/* 管理安装APP — overlay-app manager (精简版).
 *
 * Same 0x073x command family UV Studio uses (js/flash.js flash.js?v=84). The
 * catalog is the flat archive/apps folder of uvk1.xanyi.eu.org, so instead of
 * UV Studio's card grid this page pairs a search box with one version dropdown.
 */
;(function () {
    "use strict";

    const ui = window.UVToolsUI;
    const serial = window.LBJSerial;
    const catalog = window.UVTOOLS_CATALOG;
    const format = window.UVTOOLS_RADIO_FORMAT;
    const t = ui.t;

    const view = document.getElementById("apps-content");
    if (!view) return;

    const firmwareEl = document.getElementById("appManagerFirmware");
    const compatibilityEl = document.getElementById("appManagerCompatibility");
    const installedCountEl = document.getElementById("appInstalledCount");
    const capacityTextEl = document.getElementById("appCapacityText");
    const capacityBar = document.getElementById("appCapacityBar");
    const tableBody = document.getElementById("appsTableBody");
    const tableWrap = document.getElementById("appsTableWrap");
    const emptyEl = document.getElementById("appEmptyInstalled");
    const refreshBtn = document.getElementById("appRefreshBtn");
    const deleteAllBtn = document.getElementById("appDeleteAllBtn");
    const searchInput = document.getElementById("appCatalogSearch");
    const versionSelect = document.getElementById("appCatalogVersionSelect");
    const reloadBtn = document.getElementById("appCatalogReloadBtn");
    const metaEl = document.getElementById("appMeta");
    const targetSelect = document.getElementById("appTarget");
    const installBtn = document.getElementById("appInstallBtn");

    const statuses = new Map();   // slot -> APP_ERR_* code
    const headers = new Map();    // slot -> parsed app_header_t
    const compat = new Map();     // slot -> launch verdict (0 = launchable)

    let activeSlotCount = 0;
    let firmwareName = "";
    let catalogGroups = [];
    let catalogState = "idle";
    let selectedApp = null;       // { entry, header, image }
    let busyDownload = false;
    const latestHeaders = new Map(); // catalog file name -> parsed header (or null)
    let headerFetchToken = 0;

    // ---- Device summary -----------------------------------------------------

    function appSlotLabel(slot) {
        return String(slot + 1);
    }

    function updateSummary() {
        const installed = Array.from(statuses.values()).filter(code => code === 0).length;
        if (installedCountEl) installedCountEl.textContent = t("appManagerInstalledCount", installed);
        if (capacityTextEl) {
            capacityTextEl.textContent = activeSlotCount
                ? t("appManagerCapacity", installed, activeSlotCount)
                : t("appManagerConnectHint");
        }
        if (capacityBar) {
            capacityBar.setAttribute("aria-valuemax", String(activeSlotCount || 0));
            capacityBar.setAttribute("aria-valuenow", String(installed));
            const fill = capacityBar.firstElementChild;
            if (fill) {
                fill.style.width = activeSlotCount
                    ? `${Math.min(100, (installed / activeSlotCount) * 100)}%`
                    : "0%";
            }
        }
        if (firmwareEl) firmwareEl.textContent = firmwareName || t("appManagerRadioPending");
        if (compatibilityEl) {
            compatibilityEl.textContent = activeSlotCount
                ? t("arch_app_slot_count", activeSlotCount)
                : t("appManagerConnectHint");
        }
    }

    function updateButtons() {
        const busy = ui.isBusy() || busyDownload;
        const ready = activeSlotCount > 0 && statuses.size === activeSlotCount;
        const installed = Array.from(statuses.values()).some(code => code === 0);
        if (installBtn) installBtn.disabled = busy || !ready || !selectedApp;
        if (refreshBtn) refreshBtn.disabled = busy;
        if (deleteAllBtn) deleteAllBtn.disabled = busy || !ready || !installed;
        if (versionSelect) versionSelect.disabled = busy || catalogState !== "ready";
        if (reloadBtn) reloadBtn.disabled = busy || catalogState === "loading";
        if (targetSelect) targetSelect.disabled = busy || !activeSlotCount;
        // Keep the search box usable even when the current filter matches nothing,
        // otherwise the filter could never be cleared again.
        if (searchInput) searchInput.disabled = busy || !catalogGroups.length;
        renderTable();
    }

    ui.onBusyChange(updateButtons);

    // ---- Installed table ----------------------------------------------------

    function buildTable() {
        if (!tableBody) return;
        tableBody.innerHTML = "";
        for (let slot = 0; slot < format.APP_SLOT_COUNT; slot++) {
            const row = document.createElement("tr");
            row.dataset.slot = String(slot);
            row.className = "app-slot-pending";
            row.hidden = true;
            row.innerHTML =
                `<td class="slot-idx">${appSlotLabel(slot)}</td>` +
                `<td class="slot-name">—</td>` +
                `<td class="slot-version"><span class="slot-version-value">—</span></td>` +
                `<td class="slot-size"><span class="slot-code-size">—</span><span class="slot-asset-size"></span></td>` +
                `<td><span class="slot-state">—</span></td>` +
                `<td class="slot-actions"><div class="slot-actions-group"></div></td>`;

            const group = row.querySelector(".slot-actions-group");
            const update = ui.iconButton("update", t("appUpdateAction", ""));
            update.className += " app-act-update";
            update.hidden = true;
            update.addEventListener("click", () => { void updateApp(slot); });
            const remove = ui.iconButton("remove", t("appDelete"), { danger: true });
            remove.className += " app-act-delete";
            remove.hidden = true;
            remove.addEventListener("click", () => { void deleteApp(slot); });
            group.append(update, remove);
            tableBody.appendChild(row);
        }
    }

    function visibleRows() {
        if (!tableBody) return [];
        return Array.from(tableBody.querySelectorAll("tr[data-slot]"));
    }

    function updateRowVisibility() {
        visibleRows().forEach(row => {
            row.hidden = Number(row.dataset.slot) >= activeSlotCount;
        });
        if (tableWrap) tableWrap.hidden = activeSlotCount === 0;
    }

    function renderTable() {
        updateRowVisibility();
        if (!tableBody) return;
        let installed = 0;
        for (let slot = 0; slot < activeSlotCount; slot++) {
            const row = tableBody.querySelector(`tr[data-slot="${slot}"]`);
            if (!row) continue;
            const status = statuses.get(slot);
            const header = headers.get(slot);
            const valid = status === 0;
            if (valid) installed++;

            row.classList.toggle("app-slot-pending", status === undefined);
            row.classList.toggle("app-slot-installed", valid);
            row.classList.toggle("app-slot-empty", status === 2);

            row.querySelector(".slot-name").textContent = valid ? (header?.name || "—") : "—";
            row.querySelector(".slot-version-value").textContent = valid ? (header?.version || "—") : "—";

            const codeSize = row.querySelector(".slot-code-size");
            const assetSize = row.querySelector(".slot-asset-size");
            if (valid) {
                codeSize.textContent = format.formatBytes(header?.codeSize || 0);
                assetSize.textContent = header?.assetSize
                    ? t("arch_app_size_assets", format.formatBytes(header.assetSize))
                    : "";
            } else {
                codeSize.textContent = "—";
                assetSize.textContent = "";
            }

            const stateCell = row.querySelector(".slot-state");
            if (status === undefined) {
                stateCell.textContent = "—";
                stateCell.className = "slot-state";
            } else {
                stateCell.textContent = t(format.statusKey(format.APP_STATUS_KEYS, status));
                const launchable = compat.get(slot) === 0;
                stateCell.className = "slot-state " +
                    (valid ? (launchable ? "ok" : "bad") : (status === 2 ? "empty" : "bad"));
            }

            const busy = ui.isBusy() || busyDownload;
            const remove = row.querySelector(".app-act-delete");
            if (remove) {
                remove.hidden = !valid;
                remove.disabled = busy;
            }
            const update = row.querySelector(".app-act-update");
            if (update) {
                const newer = valid ? findUpdate(slot) : null;
                update.hidden = !newer;
                update.disabled = busy;
                if (newer) {
                    update.title = t("appUpdateAction", updateVersionLabel(newer));
                    update.setAttribute("aria-label", update.title);
                }
            }
        }

        if (emptyEl) emptyEl.hidden = installed > 0 || statuses.size === 0;
        if (tableWrap) tableWrap.hidden = activeSlotCount === 0 || installed === 0;
        updateSummary();
    }

    function findUpdate(slot) {
        const header = headers.get(slot);
        if (!header || !catalogGroups.length) return null;
        const newest = catalog.findNewestFor(catalogGroups, header.name);
        if (!newest) return null;
        // The file-name version is the firmware release, not the app version;
        // compare the .app headers instead (0.4 vs 0.4 = no update).
        if (!latestHeaders.has(newest.name)) return null;
        const latest = latestHeaders.get(newest.name);
        if (!latest?.version) return null;
        const delta = format.compareVersions(header.version, latest.version);
        return delta !== null && delta < 0 ? newest : null;
    }

    // The app version shown in the Update action comes from the catalog .app
    // header (0.5), not from the release tag in its file name (v5.5.0).
    function updateVersionLabel(entry) {
        const latest = latestHeaders.get(entry.name);
        return "v" + (latest?.version || entry.version);
    }

    /* Read the header of each catalog .app that matches an installed app, so the
       Update action compares app versions rather than release tags. The files
       are a few KB, so a plain GET is simpler than a Range request (and avoids
       a CORS preflight for the non-safelisted Range header). */
    async function loadLatestHeaders() {
        const token = ++headerFetchToken;
        const wanted = new Map();
        for (let slot = 0; slot < activeSlotCount; slot++) {
            if (statuses.get(slot) !== 0) continue;
            const header = headers.get(slot);
            if (!header?.name) continue;
            const newest = catalog.findNewestFor(catalogGroups, header.name);
            if (newest) wanted.set(newest.name, newest);
        }

        for (const [name, entry] of wanted) {
            if (latestHeaders.has(name)) continue;
            try {
                const bytes = await catalog.fetchBinary(entry.url, entry.size);
                latestHeaders.set(name, format.parseAppHeader(bytes));
            } catch (error) {
                latestHeaders.set(name, null);
            }
            if (token !== headerFetchToken) return;
        }
        renderTable();
    }

    // ---- Catalog ------------------------------------------------------------

    function renderVersionOptions() {
        if (!versionSelect) return;
        const previous = versionSelect.value;
        versionSelect.textContent = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("app_catalog_version_placeholder");
        placeholder.disabled = true;
        placeholder.selected = true;
        versionSelect.appendChild(placeholder);

        const needle = (searchInput?.value ?? "").trim().toLowerCase();
        let count = 0;
        catalogGroups.forEach(group => {
            const entries = group.entries.filter(entry => !needle ||
                entry.name.toLowerCase().includes(needle) ||
                group.label.toLowerCase().includes(needle) ||
                ("v" + entry.version).toLowerCase().includes(needle));
            if (!entries.length) return;

            const optgroup = document.createElement("optgroup");
            optgroup.label = group.label;
            entries.forEach(entry => {
                const option = document.createElement("option");
                option.value = entry.name;
                option.textContent = catalog.formatEntryLabel(entry);
                optgroup.appendChild(option);
                count += 1;
            });
            versionSelect.appendChild(optgroup);
        });

        if (previous && count) {
            const match = Array.from(versionSelect.options).find(option => option.value === previous);
            if (match) versionSelect.value = previous;
        }
        catalogState = count ? "ready" : (catalogGroups.length ? "filtered" : "error");
        updateButtons();
    }

    async function loadCatalog(options) {
        if (!catalog || catalogState === "loading") return;
        catalogState = "loading";
        updateButtons();
        const result = await catalog.loadApps({ force: Boolean(options?.force) });
        catalogGroups = result.groups;
        latestHeaders.clear();
        headerFetchToken += 1;
        renderVersionOptions();
        if (result.error) {
            if (result.error.kind === "rate-limit") {
                const when = result.error.resetAt
                    ? new Date(result.error.resetAt).toLocaleTimeString()
                    : "";
                ui.log(t("arch_catalog_rate_limited", when), "error");
            } else {
                ui.log(t("arch_catalog_unavailable"), "error");
            }
        } else if (!catalogGroups.length) {
            ui.log(t("arch_catalog_empty"), "info");
        }
        if (statuses.size) void loadLatestHeaders();
    }

    function setSelectedApp(selection) {
        selectedApp = selection;
        if (metaEl) {
            if (!selection) {
                metaEl.textContent = "";
            } else {
                const header = selection.header;
                metaEl.textContent = t("arch_app_selected",
                    header.name || selection.entry.name,
                    header.version || "—",
                    format.formatBytes(header.codeSize));
            }
        }
        updateButtons();
    }

    async function chooseApp(name) {
        const entry = catalog.findEntry(catalogGroups, name);
        if (!entry) return;
        busyDownload = true;
        setSelectedApp(null);
        ui.log(t("arch_downloading", entry.name), "info");
        try {
            const bytes = await catalog.fetchBinary(entry.url, entry.size);
            const parts = format.splitAppImage(bytes);
            if (parts.error) throw new Error(t(parts.error));
            setSelectedApp({
                entry,
                header: format.parseAppHeader(parts.header),
                image: bytes
            });
            ui.log(t("arch_app_loaded", entry.name), "success");
        } catch (error) {
            ui.log(t("appsError", error?.message ?? String(error)), "error");
        } finally {
            busyDownload = false;
            updateButtons();
        }
    }

    if (versionSelect) {
        versionSelect.addEventListener("change", () => {
            if (versionSelect.value) void chooseApp(versionSelect.value);
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            if (catalogGroups.length) renderVersionOptions();
        });
    }

    if (reloadBtn) {
        reloadBtn.addEventListener("click", () => { void loadCatalog({ force: true }); });
    }

    // ---- Target slot --------------------------------------------------------

    function renderTargets() {
        if (!targetSelect) return;
        const previous = targetSelect.value;
        targetSelect.textContent = "";
        for (let slot = 0; slot < activeSlotCount; slot++) {
            const option = document.createElement("option");
            option.value = String(slot);
            option.textContent = appSlotLabel(slot);
            if (statuses.get(slot) === 0) option.textContent += ` · ${headers.get(slot)?.name || "—"}`;
            targetSelect.appendChild(option);
        }
        const free = Array.from({ length: activeSlotCount }, (_, slot) => slot)
            .find(slot => statuses.get(slot) !== 0);
        const preferred = previous && Number(previous) < activeSlotCount ? previous : String(free ?? 0);
        targetSelect.value = preferred;
    }

    // ---- Radio flows --------------------------------------------------------

    async function connectIfNeeded() {
        if (!serial.isSupported()) throw new Error(t("lbjBrowserUnsupported"));
        if (!serial.isConnected()) await serial.connect();
    }

    /* Slot 47 is a bad-slot index on 16-slot firmware and a valid (empty) slot
       on 48-slot firmware, so one probe tells us the capacity without trusting
       the version string. A timeout means the firmware has no overlay apps. */
    async function detectSlotCount() {
        try {
            const probe = format.parseAppInfo(await serial.appInfo(format.APP_SLOT_COUNT - 1));
            return probe && probe.status === 1
                ? format.APP_LEGACY_SLOT_COUNT
                : format.APP_SLOT_COUNT;
        } catch (error) {
            if (error?.code === "UVSTUDIO_SERIAL_SESSION_CHANGED" || !serial.isConnected()) throw error;
            return 0;
        }
    }

    async function refresh() {
        const token = ui.beginOperation("apps-refresh");
        if (!token) return;
        ui.showLog();
        statuses.clear();
        headers.clear();
        compat.clear();
        activeSlotCount = 0;
        updateButtons();
        renderTargets();

        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            firmwareName = device.name || "";
            updateSummary();

            const count = await detectSlotCount();
            if (!count) {
                ui.log(t("appUnsupportedLog", firmwareName || t("appUnknownFirmware")), "error");
                activeSlotCount = 0;
                updateButtons();
                return;
            }
            activeSlotCount = count;
            renderTargets();
            ui.log(t("appsScanning"), "info");

            for (let slot = 0; slot < activeSlotCount; slot++) {
                let info = null;
                try {
                    info = format.parseAppInfo(await serial.appInfo(slot));
                } catch (error) {
                    if (error?.code === "UVSTUDIO_SERIAL_SESSION_CHANGED" || !serial.isConnected()) throw error;
                    statuses.set(slot, 6);
                    headers.delete(slot);
                    compat.delete(slot);
                    continue;
                }
                if (!info) continue;
                statuses.set(slot, info.status);
                if (info.status === 0) {
                    headers.set(slot, info.header);
                    // 0x0736 is the same ABI/API/capability check the radio runs
                    // at launch; a refusal still leaves the app installed.
                    try {
                        const verdict = format.parseAppValidate(await serial.appValidate(slot));
                        compat.set(slot, verdict ? verdict.status : 0);
                    } catch (error) {
                        if (error?.code === "UVSTUDIO_SERIAL_SESSION_CHANGED" || !serial.isConnected()) throw error;
                        compat.set(slot, 0);
                    }
                } else {
                    headers.delete(slot);
                    compat.delete(slot);
                }
            }

            renderTargets();
            ui.log(t("appsScanDone"), "success");
            void loadLatestHeaders();
        } catch (error) {
            ui.log(t("appsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
            updateButtons();
        }
    }

    function statusOf(data) {
        return data && data.length >= 2 ? data[1] : 0xFF;
    }

    async function refreshSlot(slot) {
        const info = format.parseAppInfo(await serial.appInfo(slot));
        if (!info) return;
        statuses.set(slot, info.status);
        if (info.status === 0) headers.set(slot, info.header);
        else { headers.delete(slot); compat.delete(slot); }
        renderTable();
    }

    async function writeApp(slot, parts, operationName) {
        const token = ui.beginOperation(operationName, { critical: true });
        if (!token) return false;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);
        let ok = false;

        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            const timestamp = device.timestamp;
            const total = parts.code.length + parts.assets.length || 1;

            ui.log(t("appErasing", appSlotLabel(slot)), "info");
            let status = statusOf(await serial.appErase(slot, timestamp));
            if (status !== 0) throw new Error(t("error", t(format.statusKey(format.APP_STATUS_KEYS, status))));

            ui.log(t("appInstalling", appSlotLabel(slot)), "info");
            let done = 0;
            let painted = -1;
            for (const [part, base] of [
                [parts.code, format.APP_IMG_OFFSET],
                [parts.assets, format.APP_ASSET_OFFSET]
            ]) {
                for (let offset = 0; offset < part.length; offset += format.APP_WRITE_CHUNK) {
                    const chunk = part.subarray(
                        offset, Math.min(offset + format.APP_WRITE_CHUNK, part.length));
                    status = statusOf(await serial.appWriteChunkRetry(
                        slot, base + offset, timestamp, chunk,
                        () => ui.log(t("slotRetry", base + offset), "info")));
                    if (status !== 0) {
                        throw new Error(t("error", t(format.statusKey(format.APP_STATUS_KEYS, status))));
                    }
                    done += chunk.length;
                    const rounded = ui.updateProgress((done / total) * 95);
                    if (rounded !== painted) { painted = rounded; void ui.paint(); }
                }
            }

            // Header last: it carries the committed flag.
            status = statusOf(await serial.appWriteChunkRetry(
                slot, 0, timestamp, parts.header,
                () => ui.log(t("slotRetry", 0), "info")));
            if (status !== 0) throw new Error(t("error", t(format.statusKey(format.APP_STATUS_KEYS, status))));

            ui.updateProgress(97);
            await ui.paint();
            ui.log(t("appVerifying", appSlotLabel(slot)), "info");
            const verdict = format.parseAppValidate(await serial.appValidate(slot));
            const verdictStatus = verdict ? verdict.status : 0xFF;
            if (verdictStatus !== 0 && !format.APP_STATUS_INCOMPATIBLE.has(verdictStatus)) {
                throw new Error(t("error", t(format.statusKey(format.APP_STATUS_KEYS, verdictStatus))));
            }

            ui.updateProgress(100);
            if (verdictStatus === 0) ui.log(t("appInstalled", appSlotLabel(slot)), "success");
            else {
                ui.log(t("appInstalledIncompatible", appSlotLabel(slot),
                    t(format.statusKey(format.APP_STATUS_KEYS, verdictStatus))), "warning");
            }
            await refreshSlot(slot);
            compat.set(slot, verdictStatus);
            renderTargets();
            renderTable();
            ok = true;
            setTimeout(() => ui.setProgressVisible(false), 1200);
        } catch (error) {
            ui.setProgressVisible(false);
            ui.log(t("appsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
        return ok;
    }

    async function install() {
        if (!selectedApp) return;
        if (statuses.size !== activeSlotCount) {
            ui.log(t("appManagerScanBeforeInstall"), "error");
            return;
        }
        const slot = targetSelect ? parseInt(targetSelect.value, 10) : 0;
        if (!(slot >= 0 && slot < activeSlotCount)) return;

        const parts = format.splitAppImage(selectedApp.image);
        if (parts.error) {
            ui.log(t(parts.error), "error");
            return;
        }
        await writeApp(slot, parts, "apps-install");
    }

    async function updateApp(slot) {
        const newer = findUpdate(slot);
        if (!newer) return;
        const label = updateVersionLabel(newer);
        if (!(await ui.confirm({
            title: t("appUpdateAction", label),
            body: t("arch_app_update_confirm", appSlotLabel(slot), label),
            confirmLabel: t("appUpdateAction", label)
        }))) return;

        busyDownload = true;
        updateButtons();
        try {
            const bytes = await catalog.fetchBinary(newer.url, newer.size);
            const parts = format.splitAppImage(bytes);
            if (parts.error) throw new Error(t(parts.error));
            await writeApp(slot, parts, "apps-install");
        } catch (error) {
            ui.log(t("appsError", error?.message ?? String(error)), "error");
        } finally {
            busyDownload = false;
            updateButtons();
        }
    }

    async function deleteApp(slot) {
        if (!(await ui.confirm({
            title: t("appDelete"),
            body: t("arch_app_delete_confirm", appSlotLabel(slot)),
            confirmLabel: t("appDelete"),
            danger: true
        }))) return;

        const token = ui.beginOperation("apps-delete");
        if (!token) return;
        ui.showLog();
        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            ui.log(t("appErasing", appSlotLabel(slot)), "info");
            const status = statusOf(await serial.appErase(slot, device.timestamp));
            if (status !== 0) {
                throw new Error(t("error", t(format.statusKey(format.APP_STATUS_KEYS, status))));
            }
            ui.log(t("appErased", appSlotLabel(slot)), "success");
            statuses.set(slot, 2);
            headers.delete(slot);
            compat.delete(slot);
            await refreshSlot(slot);
            renderTargets();
        } catch (error) {
            ui.log(t("appsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    async function deleteAll() {
        if (statuses.size !== activeSlotCount) return;
        const slots = Array.from(statuses.entries())
            .filter(([, status]) => status === 0)
            .map(([slot]) => slot)
            .sort((a, b) => a - b);
        if (!slots.length) return;
        if (!(await ui.confirm({
            title: t("appDeleteAllTitle"),
            body: t("appDeleteAllConfirm", slots.length),
            confirmLabel: t("appDeleteAll"),
            danger: true
        }))) return;

        const token = ui.beginOperation("apps-delete-all");
        if (!token) return;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);
        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            for (let index = 0; index < slots.length; index++) {
                const slot = slots[index];
                ui.log(t("appErasing", appSlotLabel(slot)), "info");
                const status = statusOf(await serial.appErase(slot, device.timestamp));
                if (status !== 0) {
                    throw new Error(t("error", t(format.statusKey(format.APP_STATUS_KEYS, status))));
                }
                statuses.set(slot, 2);
                headers.delete(slot);
                compat.delete(slot);
                ui.updateProgress(((index + 1) / slots.length) * 100);
            }
            ui.log(t("appDeleteAllDone"), "success");
            renderTable();
            renderTargets();
            setTimeout(() => ui.setProgressVisible(false), 1200);
        } catch (error) {
            ui.setProgressVisible(false);
            ui.log(t("appsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    if (refreshBtn) refreshBtn.addEventListener("click", () => { void refresh(); });
    if (deleteAllBtn) deleteAllBtn.addEventListener("click", () => { void deleteAll(); });
    if (installBtn) installBtn.addEventListener("click", () => { void install(); });

    // ---- View lifecycle -----------------------------------------------------

    window.addEventListener("uvstudio:languagechange", () => {
        if (catalogGroups.length) renderVersionOptions();
        renderTable();
    });

    ui.onViewChange(detail => {
        if (detail.view === "apps") void loadCatalog();
    });

    buildTable();
    renderTargets();
    updateButtons();
})();
