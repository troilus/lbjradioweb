/* 多固件 — firmware slots (multiboot).
 *
 * Same 0x072x command family UV Studio uses (js/flash.js flash.js?v=84). Only
 * the external flash is written, so a failed write never bricks the radio.
 */
;(function () {
    "use strict";

    const ui = window.UVToolsUI;
    const serial = window.LBJSerial;
    const catalog = window.UVTOOLS_CATALOG;
    const format = window.UVTOOLS_RADIO_FORMAT;
    const t = ui.t;

    const view = document.getElementById("slots-content");
    if (!view) return;

    const tableBody = document.getElementById("slotsTableBody");
    const refreshBtn = document.getElementById("slotsRefreshBtn");
    const catalogSection = document.getElementById("slotFirmwareCatalogSection");
    const catalogSelect = document.getElementById("slotFirmwareCatalogSelect");
    const catalogOr = document.getElementById("slotFirmwareCatalogOr");
    const reloadBtn = document.getElementById("slotFirmwareReloadBtn");
    const fileInput = document.getElementById("slotFile");
    const fileLabel = document.getElementById("slotFileLabel");
    const fileName = document.getElementById("slotFileName");
    const metaEl = document.getElementById("slotMeta");
    const targetSelect = document.getElementById("slotTarget");
    const nameInput = document.getElementById("slotName");
    const writeBtn = document.getElementById("slotWriteBtn");

    const slots = new Map();     // slot -> { status, header }
    const statuses = new Map();  // slot -> status code
    let image = null;
    let imageName = "";
    let imageMeta = { name: "", fwVersion: "" };
    let catalogGroups = [];
    let catalogState = "idle";
    let loadSequence = 0;

    // ---- Table --------------------------------------------------------------

    function statusText(code) {
        return t(format.statusKey(format.SLOT_STATUS_KEYS, code));
    }

    function buildTable() {
        if (!tableBody) return;
        tableBody.innerHTML = "";
        for (let slot = format.SLOT_FIRST; slot < format.SLOT_END; slot++) {
            const row = document.createElement("tr");
            row.dataset.slot = String(slot);
            row.innerHTML =
                `<td class="slot-idx">${slot}</td>` +
                `<td class="slot-name">—</td>` +
                `<td class="slot-version">—</td>` +
                `<td class="slot-size">—</td>` +
                `<td><span class="slot-state">—</span></td>` +
                `<td class="slot-actions"><div class="slot-actions-group"></div></td>`;

            const group = row.querySelector(".slot-actions-group");
            const erase = ui.iconButton("erase", t("slotErase"));
            erase.className += " slot-act-erase";
            erase.addEventListener("click", () => { void eraseSlot(slot); });
            const reset = ui.iconButton("reset", t("slotResetConfig"));
            reset.className += " slot-act-reset";
            reset.addEventListener("click", () => { void resetConfig(slot); });
            group.append(erase, reset);
            tableBody.appendChild(row);
        }
        renderAllRows();
    }

    function renderRow(slot, info) {
        const row = tableBody?.querySelector(`tr[data-slot="${slot}"]`);
        if (!row) return;
        if (info) {
            slots.set(slot, info);
            statuses.set(slot, info.status);
        }
        const current = info || slots.get(slot);
        const valid = current && current.status === 0;
        const committed = current && (current.status === 0 || current.status === 5);
        const header = current?.header;

        row.querySelector(".slot-name").textContent = committed ? (header?.name || "—") : "—";
        row.querySelector(".slot-version").textContent = committed ? (header?.fwVersion || "—") : "—";
        row.querySelector(".slot-size").textContent = committed && header?.imageSize
            ? format.formatBytes(header.imageSize)
            : "—";

        const stateCell = row.querySelector(".slot-state");
        if (current) {
            stateCell.textContent = statusText(current.status);
            stateCell.className = "slot-state " + (valid ? "ok" : (current.status === 1 ? "empty" : "bad"));
        } else {
            stateCell.textContent = "—";
            stateCell.className = "slot-state";
        }

        row.querySelectorAll(".slot-act-erase, .slot-act-reset").forEach(button => {
            button.hidden = !committed || ui.isBusy();
        });
    }

    function renderAllRows() {
        for (let slot = format.SLOT_FIRST; slot < format.SLOT_END; slot++) {
            renderRow(slot, slots.get(slot));
        }
    }

    function pickDefaultTarget() {
        if (!targetSelect) return;
        let target = format.SLOT_FIRST;
        for (let slot = format.SLOT_FIRST; slot < format.SLOT_END; slot++) {
            if (statuses.get(slot) === 1) { target = slot; break; }
        }
        targetSelect.value = String(target);
    }

    // ---- Selection ----------------------------------------------------------

    function setImage(bytes, name, options) {
        image = bytes;
        imageName = name || "";
        imageMeta = bytes
            ? format.deriveSlotMeta(bytes, imageName)
            : { name: "", fwVersion: "" };

        const hasFile = Boolean(bytes);
        if (fileName) {
            fileName.textContent = hasFile ? imageName : t("fileNoFile");
            fileName.classList.toggle("has-file", hasFile);
        }
        if (fileLabel) fileLabel.classList.toggle("has-file", hasFile);
        if (nameInput) {
            // A language change re-renders the labels but must not overwrite a
            // slot name the user has already typed.
            if (!options?.preserveName) nameInput.value = hasFile ? imageMeta.name : "";
            nameInput.disabled = !hasFile;
        }
        if (metaEl) {
            if (!hasFile) {
                metaEl.textContent = "";
            } else {
                const parts = [format.formatBytes(bytes.length)];
                if (imageMeta.fwVersion) parts.push(imageMeta.fwVersion);
                metaEl.textContent = t("slotFileLoaded", imageName) + " · " + parts.join(" · ");
            }
        }
        updateButtons();
    }

    function clearImage() {
        if (fileInput) fileInput.value = "";
        setImage(null, "");
    }

    function updateButtons() {
        const busy = ui.isBusy();
        if (writeBtn) writeBtn.disabled = busy || !image;
        if (refreshBtn) refreshBtn.disabled = busy;
        if (catalogSelect) catalogSelect.disabled = busy || catalogState !== "ready";
        if (reloadBtn) reloadBtn.disabled = busy || catalogState === "loading";
        if (fileInput) fileInput.disabled = busy;
        if (targetSelect) targetSelect.disabled = busy;
        if (nameInput) nameInput.disabled = busy || !image;
        renderAllRows();
    }

    ui.onBusyChange(updateButtons);

    if (fileInput) {
        fileInput.addEventListener("change", event => {
            const file = event.target.files?.[0];
            if (!file) return;
            const sequence = ++loadSequence;
            if (catalogSelect) catalogSelect.selectedIndex = 0;
            const reader = new FileReader();
            reader.onload = ev => {
                if (sequence !== loadSequence) return;
                setImage(new Uint8Array(ev.target.result), file.name);
            };
            reader.onerror = () => ui.log(t("arch_load_error", file.name), "error");
            reader.readAsArrayBuffer(file);
        });
    }

    // ---- Catalog ------------------------------------------------------------

    function renderCatalog() {
        if (!catalogSelect) return;
        const previous = catalogSelect.value;
        catalogSelect.textContent = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("flash_catalog_placeholder");
        placeholder.disabled = true;
        placeholder.selected = true;
        catalogSelect.appendChild(placeholder);

        let count = 0;
        catalogGroups.forEach(group => {
            if (!group.entries.length) return;
            const optgroup = document.createElement("optgroup");
            optgroup.label = group.label;
            group.entries.forEach(entry => {
                const option = document.createElement("option");
                option.value = entry.name;
                option.textContent = catalog.formatEntryLabel(entry);
                optgroup.appendChild(option);
                count += 1;
            });
            catalogSelect.appendChild(optgroup);
        });

        if (previous) {
            const match = Array.from(catalogSelect.options).find(option => option.value === previous);
            if (match) catalogSelect.value = previous;
        }
        if (catalogSection) catalogSection.hidden = count === 0;
        if (catalogOr) catalogOr.hidden = count === 0;
        catalogState = count ? "ready" : "error";
        updateButtons();
    }

    async function loadCatalog(options) {
        if (!catalog || catalogState === "loading") return;
        catalogState = "loading";
        updateButtons();
        const result = await catalog.loadFirmware({ force: Boolean(options?.force) });
        catalogGroups = result.groups;
        renderCatalog();
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
        updateButtons();
    }

    if (catalogSelect) {
        catalogSelect.addEventListener("change", async () => {
            const name = catalogSelect.value;
            if (!name) return;
            const entry = catalog.findEntry(catalogGroups, name);
            if (!entry) return;
            const sequence = ++loadSequence;
            if (fileInput) fileInput.value = "";
            ui.log(t("arch_downloading", entry.name), "info");
            try {
                const bytes = await catalog.fetchBinary(entry.url, entry.size);
                if (sequence !== loadSequence) return;
                setImage(bytes, entry.name);
            } catch (error) {
                if (sequence !== loadSequence) return;
                clearImage();
                ui.log(t("arch_download_error", entry.name, error?.message ?? String(error)), "error");
            }
        });
    }

    if (reloadBtn) {
        reloadBtn.addEventListener("click", () => { void loadCatalog({ force: true }); });
    }

    // ---- Radio flows --------------------------------------------------------

    function requireStatus(data) {
        return data && data.length >= 2 ? data[1] : 0xFF;
    }

    async function connectIfNeeded() {
        if (!serial.isSupported()) throw new Error(t("lbjBrowserUnsupported"));
        if (!serial.isConnected()) await serial.connect();
    }

    async function refresh() {
        const token = ui.beginOperation("slots-refresh");
        if (!token) return;
        ui.showLog();
        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            ui.log(t("slotsScanning"), "info");
            for (let slot = format.SLOT_FIRST; slot < format.SLOT_END; slot++) {
                try {
                    renderRow(slot, format.parseSlotInfo(await serial.slotInfo(slot)));
                } catch (error) {
                    if (error?.code === "UVSTUDIO_SERIAL_SESSION_CHANGED" || !serial.isConnected()) throw error;
                    renderRow(slot, { slot, status: 6, header: null });
                }
            }
            pickDefaultTarget();
            ui.log(t("slotsScanDone", device.name || "radio"), "success");
        } catch (error) {
            ui.log(t("slotsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    async function eraseSlot(slot) {
        if (!(await ui.confirm({
            title: t("slotEraseFw"),
            body: t("slotEraseConfirm", slot),
            confirmLabel: t("slotErase"),
            danger: true
        }))) return;

        const token = ui.beginOperation("slots-erase");
        if (!token) return;
        ui.showLog();
        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            ui.log(t("slotErasing", slot), "info");
            const status = requireStatus(await serial.slotErase(slot, device.timestamp));
            if (status !== 0) throw new Error(statusText(status));
            ui.log(t("slotErased", slot), "success");
            renderRow(slot, format.parseSlotInfo(await serial.slotInfo(slot)));
            pickDefaultTarget();
        } catch (error) {
            ui.log(t("slotsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    async function resetConfig(slot) {
        if (!(await ui.confirm({
            title: t("slotResetConfig"),
            body: t("arch_slot_reset_confirm", slot),
            confirmLabel: t("slotResetConfig")
        }))) return;

        const token = ui.beginOperation("slots-reset-config");
        if (!token) return;
        ui.showLog();
        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            ui.log(t("slotConfigResetting", slot), "info");
            const status = requireStatus(await serial.slotResetConfig(slot, device.timestamp));
            if (status !== 0) throw new Error(statusText(status));
            ui.log(t("slotConfigReset", slot), "success");
        } catch (error) {
            ui.log(t("slotsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    async function writeSlot() {
        if (!image) return;
        const slot = targetSelect ? parseInt(targetSelect.value, 10) : format.SLOT_FIRST;
        if (!(slot >= format.SLOT_FIRST && slot < format.SLOT_END)) return;
        if (image.length > format.SLOT_IMG_MAX) {
            ui.log(t("slotTooBig"), "error");
            return;
        }
        const displayName = format.normalizeSlotName(nameInput?.value ?? imageMeta.name);
        if (!displayName) {
            ui.log(t("arch_slot_name_required"), "error");
            return;
        }
        if (nameInput) nameInput.value = displayName;

        if (!(await ui.confirm({
            title: t("slotWriteBtn"),
            body: t("slotWriteConfirm", slot),
            confirmLabel: t("slotWriteBtn")
        }))) return;

        const token = ui.beginOperation("slots-write", { critical: true });
        if (!token) return;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);

        try {
            await connectIfNeeded();
            const device = await serial.requestDeviceInfo();
            const timestamp = device.timestamp;
            const crc = format.crc32(image);

            ui.log(t("slotErasing", slot), "info");
            let status = requireStatus(await serial.slotErase(slot, timestamp));
            if (status !== 0) throw new Error(t("error", statusText(status)));

            ui.log(t("slotWriting", slot), "info");
            let painted = -1;
            for (let offset = 0; offset < image.length; offset += format.SLOT_WRITE_CHUNK) {
                const chunk = image.subarray(
                    offset, Math.min(offset + format.SLOT_WRITE_CHUNK, image.length));
                status = requireStatus(await serial.slotWriteChunkRetry(
                    slot, format.SLOT_IMG_OFFSET + offset, timestamp, chunk,
                    () => ui.log(t("slotRetry", offset), "info")));
                if (status !== 0) throw new Error(t("error", statusText(status)));

                const rounded = ui.updateProgress(((offset + chunk.length) / image.length) * 95);
                if (rounded !== painted) { painted = rounded; void ui.paint(); }
            }

            // The header carries the committed flag, so it is written last: a
            // partial write can never validate.
            const header = format.buildSlotHeader(image.length, crc, {
                name: displayName,
                fwVersion: imageMeta.fwVersion
            });
            status = requireStatus(await serial.slotWriteChunkRetry(
                slot, 0, timestamp, header, () => ui.log(t("slotRetry", 0), "info")));
            if (status !== 0) throw new Error(t("error", statusText(status)));

            ui.updateProgress(97);
            await ui.paint();
            ui.log(t("slotVerifying", slot), "info");
            const verdict = format.parseSlotValidate(await serial.slotValidate(slot));
            if (!verdict || verdict.status !== 0 || verdict.crc !== crc) {
                throw new Error(t("error", statusText(verdict ? verdict.status : 0xFF)));
            }

            ui.updateProgress(100);
            ui.log(t("slotWriteOk", slot), "success");
            renderRow(slot, format.parseSlotInfo(await serial.slotInfo(slot)));
            pickDefaultTarget();
            setTimeout(() => ui.setProgressVisible(false), 1200);
        } catch (error) {
            ui.setProgressVisible(false);
            ui.log(t("slotsError", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    if (refreshBtn) refreshBtn.addEventListener("click", () => { void refresh(); });
    if (writeBtn) writeBtn.addEventListener("click", () => { void writeSlot(); });

    // ---- View lifecycle -----------------------------------------------------

    window.addEventListener("uvstudio:languagechange", () => {
        if (catalogGroups.length) renderCatalog();
        renderAllRows();
        setImage(image, imageName, { preserveName: true });
    });

    ui.onViewChange(detail => {
        if (detail.view === "slots") void loadCatalog();
    });

    buildTable();
    setImage(null, "");
    updateButtons();
})();
