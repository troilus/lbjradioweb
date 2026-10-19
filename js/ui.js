/* Shared shell for the LBJ tools.
 *
 * Owns the pieces every view reuses and UV Studio keeps in js/studio.js
 * (armel/armel.github.io @ v2.0.0): console, progress bar, serial status pill,
 * theme, sidebar and view routing, plus the operation guard from
 * js/studio-serial.js. Views (view-flash.js, view-slots.js, view-apps.js)
 * register themselves here instead of duplicating this wiring.
 */
;(function () {
    "use strict";

    const VERSION = "0.20";
    const ROUTES = ["lbj-log", "flash", "slots", "apps"];

    const serial = window.LBJSerial;
    const controller = window.UVStudioSerial;
    const preferences = window.UVStudioPreferences;

    const statusEl = document.getElementById("studioSerialStatus");
    const statusText = document.getElementById("studioSerialText");
    const statusDisconnect = document.getElementById("studioSerialDisconnect");
    const versionLabel = document.getElementById("studioVersion");
    const sectionName = document.getElementById("sectionName");
    const progressContainer = document.getElementById("progressContainer");
    const progressFill = document.getElementById("progressFill");
    const progressLabel = document.getElementById("progressLabel");
    const logDiv = document.getElementById("log");
    const logToggle = document.getElementById("logToggle");
    const hamburgerBtn = document.getElementById("hamburgerMenu");
    const themeToggle = document.getElementById("themeToggle");
    const navItems = Array.from(document.querySelectorAll(".nav-item[data-route]"));
    const infoBox = document.getElementById("infoBox");

    const operationTranslationKeys = {
        "read-lbj-log": "studio_operation_read_lbj_log",
        "flash-firmware": "studio_operation_flash_firmware",
        "slots-refresh": "studio_operation_slots_refresh",
        "slots-write": "studio_operation_slots_write",
        "slots-erase": "studio_operation_slots_erase",
        "slots-reset-config": "studio_operation_slots_reset_config",
        "apps-refresh": "studio_operation_apps_refresh",
        "apps-install": "studio_operation_apps_install",
        "apps-delete": "studio_operation_apps_delete",
        "apps-delete-all": "studio_operation_apps_delete_all"
    };

    // Info-box text per view; swapped together with the view so every page keeps
    // its own warning without duplicating the markup.
    const INFO_KEYS = {
        "lbj-log": "lbjPageNote",
        "flash": "flashPageNote",
        "slots": "slotsPageNote",
        "apps": "appsPageNote"
    };

    let currentOperation = null;
    let currentView = null;
    const viewListeners = new Set();
    const busyListeners = new Set();

    function t(key, ...values) {
        return window.uvStudioI18n ? window.uvStudioI18n.t(key, ...values) : key;
    }

    function escapeHtml(text) {
        return String(text ?? "").replace(/[&<>"']/g, character => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[character]);
    }

    // ---- Console ------------------------------------------------------------

    function log(message, type = "") {
        const entry = document.createElement("div");
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        if (logDiv) {
            logDiv.appendChild(entry);
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    }

    function clearLog() {
        if (logDiv) logDiv.innerHTML = "";
    }

    function refreshLogToggle() {
        if (logToggle && logDiv) {
            logToggle.textContent = logDiv.classList.contains("visible") ? t("logHide") : t("logShow");
        }
    }

    function showLog() {
        if (!logDiv || logDiv.classList.contains("visible")) return;
        logDiv.classList.add("visible");
        if (logToggle) logToggle.setAttribute("aria-expanded", "true");
        refreshLogToggle();
    }

    if (logToggle && logDiv) {
        logToggle.addEventListener("click", () => {
            const visible = logDiv.classList.toggle("visible");
            logToggle.setAttribute("aria-expanded", visible ? "true" : "false");
            refreshLogToggle();
        });
    }

    window.addEventListener("lbj:serial-log", event => {
        log(event.detail?.message ?? "", event.detail?.type ?? "");
    });

    // ---- Progress -----------------------------------------------------------

    function updateProgress(percent) {
        const rounded = Math.max(0, Math.min(100, Math.round(percent)));
        const label = `${rounded}%`;
        if (progressFill) progressFill.style.width = label;
        if (progressLabel) progressLabel.textContent = label;
        const bar = document.querySelector(".progress-bar");
        if (bar) bar.setAttribute("aria-valuenow", String(rounded));
        return rounded;
    }

    function setProgressVisible(visible) {
        if (progressContainer) progressContainer.style.display = visible ? "block" : "none";
        if (!visible) updateProgress(0);
    }

    function paint() {
        if (document.visibilityState !== "visible") return Promise.resolve();
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    // ---- Serial status pill (UV Studio studio.js) ---------------------------

    let lastSerialSnapshot = controller
        ? controller.getSnapshot()
        : { owner: null, state: "disconnected", operation: null };

    function renderSerialStatus(snapshot) {
        if (!statusEl || !statusText) return;
        lastSerialSnapshot = snapshot || lastSerialSnapshot;
        const operation = lastSerialSnapshot.operation;
        let key;

        if (operation) {
            key = operationTranslationKeys[operation.name] || "studio_operation_active";
        } else if (lastSerialSnapshot.state === "connected") {
            key = "studio_serial_connected";
        } else {
            key = `studio_serial_${lastSerialSnapshot.state || "disconnected"}`;
        }

        const label = t(key);
        statusEl.dataset.state = lastSerialSnapshot.state || "disconnected";
        statusEl.dataset.operation = String(Boolean(operation));
        statusEl.dataset.critical = String(Boolean(operation?.critical));
        statusText.textContent = label;
        statusEl.setAttribute("aria-label", label);
        statusEl.title = label;

        if (statusDisconnect) {
            const held = lastSerialSnapshot.state === "connected" ||
                lastSerialSnapshot.state === "reconnecting";
            statusDisconnect.hidden = !held || Boolean(operation);
        }
    }

    window.addEventListener("uvstudio:serialstatechange", event => {
        renderSerialStatus(event.detail);
        notifyBusy();
    });

    if (statusDisconnect && controller) {
        statusDisconnect.addEventListener("click", async () => {
            statusDisconnect.disabled = true;
            try {
                await controller.releaseCurrent("user");
            } catch (error) {
                console.warn("Serial disconnect failed:", error);
            } finally {
                statusDisconnect.disabled = false;
                notifyBusy();
            }
        });
    }

    // ---- Operations ---------------------------------------------------------

    function beginOperation(name, options) {
        if (currentOperation) return null;
        const token = serial.beginOperation(name, { critical: Boolean(options?.critical) });
        if (!token) return null;
        currentOperation = token;
        notifyBusy();
        return token;
    }

    function endOperation(token) {
        if (!token || token !== currentOperation) return;
        serial.endOperation(token);
        currentOperation = null;
        notifyBusy();
    }

    function isBusy() {
        return Boolean(currentOperation);
    }

    window.addEventListener("beforeunload", event => {
        if (!currentOperation) return;
        event.preventDefault();
        event.returnValue = "";
    });

    function notifyBusy() {
        const busy = isBusy();
        for (const listener of busyListeners) {
            try { listener(busy); } catch (error) { console.warn(error); }
        }
    }

    function onBusyChange(listener) {
        busyListeners.add(listener);
        listener(isBusy());
        return () => busyListeners.delete(listener);
    }

    // ---- View routing -------------------------------------------------------

    function viewElement(view) {
        return document.getElementById(`${view}-content`);
    }

    function normalizeRoute(hash) {
        const route = String(hash || "").replace(/^#/, "").toLowerCase();
        return ROUTES.includes(route) ? route : ROUTES[0];
    }

    function applyRoute(view, options) {
        const next = ROUTES.includes(view) ? view : ROUTES[0];
        if (!viewElement(next)) return;
        const changed = next !== currentView;

        // Leaving a tool view releases the port so another page (UV Studio,
        // K5Viewer, a second tab) can take it; an in-flight operation is never
        // interrupted (releaseCurrent is a no-op while one is running).
        if (changed && currentView && controller && !currentOperation) {
            controller.releaseCurrent("navigation").catch(() => undefined);
        }

        currentView = next;

        navItems.forEach(item => {
            const active = item.dataset.route === next;
            item.classList.toggle("active", active);
            if (active) item.setAttribute("aria-current", "page");
            else item.removeAttribute("aria-current");
        });

        ROUTES.forEach(route => {
            const element = viewElement(route);
            if (!element) return;
            const active = route === next;
            element.classList.toggle("active", active);
            element.hidden = !active;
        });

        const nav = navItems.find(item => item.dataset.route === next);
        const sectionKey = nav?.dataset.sectionI18n;
        if (sectionName) {
            if (sectionKey) sectionName.setAttribute("data-i18n", sectionKey);
            sectionName.textContent = sectionKey ? t(sectionKey) : next;
        }
        if (infoBox && INFO_KEYS[next]) {
            infoBox.innerHTML = t(INFO_KEYS[next]);
        }

        if (changed || options?.force) {
            const detail = { view: next, previous: options?.previous ?? null };
            for (const listener of viewListeners) {
                try { listener(detail); } catch (error) { console.warn(error); }
            }
            window.dispatchEvent(new CustomEvent("uvtools:viewchange", { detail }));
        }
    }

    function navigate(view, options) {
        const route = normalizeRoute(view);
        if (options?.replace) {
            const url = `${location.pathname}${location.search}#${route}`;
            history.replaceState(null, "", url);
        } else if (normalizeRoute(location.hash) !== route) {
            location.hash = route;
            return; // hashchange applies the route
        }
        applyRoute(route);
    }

    function onViewChange(listener) {
        viewListeners.add(listener);
        if (currentView) listener({ view: currentView, previous: null });
        return () => viewListeners.delete(listener);
    }

    navItems.forEach(item => {
        item.addEventListener("click", () => navigate(item.dataset.route));
    });

    window.addEventListener("hashchange", () => applyRoute(normalizeRoute(location.hash)));

    // ---- Theme / sidebar ----------------------------------------------------

    function applyTheme() {
        const dark = preferences ? preferences.get("isDarkTheme", "false") === "true" : false;
        document.body.setAttribute("data-theme", dark ? "dark" : "light");
    }

    if (themeToggle) {
        themeToggle.addEventListener("click", () => {
            const dark = document.body.getAttribute("data-theme") !== "dark";
            document.body.setAttribute("data-theme", dark ? "dark" : "light");
            if (preferences) preferences.set("isDarkTheme", String(dark));
        });
    }

    if (hamburgerBtn) {
        hamburgerBtn.addEventListener("click", () => {
            const collapsed = document.body.classList.toggle("sidebar-collapsed");
            hamburgerBtn.setAttribute("aria-expanded", String(!collapsed));
        });
    }

    // ---- Confirm dialog -----------------------------------------------------

    const confirmModal = document.getElementById("confirmModal");
    const confirmTitle = document.getElementById("confirmTitle");
    const confirmBody = document.getElementById("confirmBody");
    const confirmOk = document.getElementById("confirmOk");
    const confirmCancel = document.getElementById("confirmCancel");
    const confirmClose = document.getElementById("confirmClose");
    let confirmResolve = null;

    function closeConfirm(result) {
        if (!confirmModal || !confirmModal.classList.contains("show")) return;
        const resolve = confirmResolve;
        confirmResolve = null;
        confirmModal.classList.remove("show");
        confirmModal.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
        if (resolve) resolve(Boolean(result));
    }

    function confirmAction(options) {
        if (!confirmModal) return Promise.resolve(window.confirm(options?.body || ""));
        if (confirmResolve) return Promise.resolve(false);
        if (confirmTitle) confirmTitle.textContent = options?.title || "";
        if (confirmBody) confirmBody.textContent = options?.body || "";
        if (confirmOk) {
            confirmOk.textContent = options?.confirmLabel || "OK";
            confirmOk.classList.toggle("danger", Boolean(options?.danger));
            confirmOk.classList.toggle("primary", !options?.danger);
        }
        confirmModal.classList.add("show");
        confirmModal.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
        requestAnimationFrame(() => confirmCancel?.focus());
        return new Promise(resolve => { confirmResolve = resolve; });
    }

    if (confirmOk) confirmOk.addEventListener("click", () => closeConfirm(true));
    if (confirmCancel) confirmCancel.addEventListener("click", () => closeConfirm(false));
    if (confirmClose) confirmClose.addEventListener("click", () => closeConfirm(false));
    if (confirmModal) {
        confirmModal.addEventListener("click", event => {
            if (event.target === confirmModal) closeConfirm(false);
        });
        confirmModal.addEventListener("keydown", event => {
            if (event.key === "Escape") closeConfirm(false);
        });
    }

    // ---- Shared table helpers ----------------------------------------------

    const ICONS = {
        erase: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 14h10l1-14"/><path d="M10 11v5M14 11v5"/></svg>',
        reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
        update: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
        remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="m6 7 1 13h10l1-13"/></svg>'
    };

    function iconButton(kind, label, options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn table-icon-action${options?.danger ? " is-danger" : ""}`;
        button.innerHTML = ICONS[kind] || "";
        button.title = label;
        button.setAttribute("aria-label", label);
        if (options?.hidden) button.hidden = true;
        if (options?.disabled) button.disabled = true;
        return button;
    }

    function setSectionNameKey(key) {
        if (!sectionName || !key) return;
        sectionName.setAttribute("data-i18n", key);
        sectionName.textContent = t(key);
    }

    // ---- Language -----------------------------------------------------------

    window.addEventListener("uvstudio:languagechange", () => {
        renderSerialStatus(lastSerialSnapshot);
        refreshLogToggle();
        if (currentView && sectionName) {
            const nav = navItems.find(item => item.dataset.route === currentView);
            if (nav?.dataset.sectionI18n) {
                sectionName.textContent = t(nav.dataset.sectionI18n);
            }
        }
        if (infoBox && INFO_KEYS[currentView]) infoBox.innerHTML = t(INFO_KEYS[currentView]);
    });

    // ---- Boot ---------------------------------------------------------------

    applyTheme();
    if (versionLabel) versionLabel.textContent = `v${VERSION}`;
    document.title = `UV Tools v${VERSION} — LBJ Radio`;
    renderSerialStatus(lastSerialSnapshot);
    refreshLogToggle();
    updateProgress(0);

    window.UVToolsUI = {
        VERSION,
        ROUTES,
        t,
        escapeHtml,
        log,
        clearLog,
        showLog,
        updateProgress,
        setProgressVisible,
        paint,
        beginOperation,
        endOperation,
        isBusy,
        onBusyChange,
        navigate,
        onViewChange,
        currentView: () => currentView,
        applyRoute,
        confirm: confirmAction,
        iconButton,
        setSectionNameKey,
        serial,
        controller
    };

    applyRoute(normalizeRoute(location.hash), { force: true });
})();
