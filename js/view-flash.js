/* 刷固件 — DFU firmware flashing.
 *
 * The flow mirrors UV Studio's js/flash.js (flash.js?v=84): the radio is put in
 * DFU mode, the bootloader announces itself over 0x0518, we echo its version
 * back with 0x0530 and then program the image page by page with 0x0519.
 */
;(function () {
    "use strict";

    const ui = window.UVToolsUI;
    const serial = window.LBJSerial;
    const catalog = window.UVTOOLS_CATALOG;
    const format = window.UVTOOLS_RADIO_FORMAT;
    const t = ui.t;

    const view = document.getElementById("flash-content");
    if (!view) return;

    const catalogSection = document.getElementById("firmwareCatalogSection");
    const catalogSelect = document.getElementById("firmwareCatalogSelect");
    const catalogOr = document.getElementById("firmwareCatalogOr");
    const fileInput = document.getElementById("firmwareFile");
    const fileLabel = document.getElementById("fileLabel");
    const fileName = document.getElementById("fileName");
    const flashBtn = document.getElementById("flashBtn");
    const metaEl = document.getElementById("flashMeta");
    const reloadBtn = document.getElementById("firmwareReloadBtn");

    let firmware = null;         // Uint8Array
    let firmwareName = "";       // file name or archive file name
    let catalogGroups = [];
    let loadSequence = 0;
    let catalogState = "idle";   // idle | loading | ready | error

    // ---- Selection ----------------------------------------------------------

    function setFirmware(bytes, name) {
        firmware = bytes;
        firmwareName = name || "";
        const hasFile = Boolean(bytes);
        if (fileName) {
            fileName.textContent = hasFile ? firmwareName : t("fileNoFile");
            fileName.classList.toggle("has-file", hasFile);
        }
        if (fileLabel) fileLabel.classList.toggle("has-file", hasFile);
        if (metaEl) {
            metaEl.textContent = hasFile
                ? t("arch_meta_selected", firmwareName, format.formatBytes(bytes.length))
                : "";
        }
        updateButtons();
    }

    function clearFirmware() {
        if (fileInput) fileInput.value = "";
        setFirmware(null, "");
    }

    function updateButtons() {
        const busy = ui.isBusy();
        if (flashBtn) flashBtn.disabled = busy || !firmware;
        if (catalogSelect) catalogSelect.disabled = busy || catalogState !== "ready";
        if (reloadBtn) reloadBtn.disabled = busy || catalogState === "loading";
        if (fileInput) fileInput.disabled = busy;
    }

    ui.onBusyChange(updateButtons);

    if (fileInput) {
        fileInput.addEventListener("change", event => {
            const file = event.target.files?.[0];
            if (!file) return;
            const sequence = ++loadSequence;
            if (catalogSelect) catalogSelect.selectedIndex = 0;
            ui.log(t("arch_loading_file", file.name), "info");
            const reader = new FileReader();
            reader.onload = ev => {
                if (sequence !== loadSequence) return;
                setFirmware(new Uint8Array(ev.target.result), file.name);
                ui.log(t("arch_loaded", file.name, format.formatBytes(file.size)), "success");
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
            if (!catalogGroups.length) catalogState = "error";
        } else if (!catalogGroups.length) {
            ui.log(t("arch_catalog_empty"), "info");
        } else if (result.cached && !result.stale) {
            ui.log(t("arch_catalog_cached", catalog.flatten(catalogGroups).length), "info");
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
                setFirmware(bytes, entry.name);
                ui.log(t("arch_loaded", entry.name, format.formatBytes(bytes.length)), "success");
            } catch (error) {
                if (sequence !== loadSequence) return;
                clearFirmware();
                ui.log(t("arch_download_error", entry.name, error?.message ?? String(error)), "error");
            }
        });
    }

    if (reloadBtn) {
        reloadBtn.addEventListener("click", () => { void loadCatalog({ force: true }); });
    }

    // ---- Flashing -----------------------------------------------------------

    function formatUid(uid) {
        return Array.from(uid).map(byte => byte.toString(16).padStart(2, "0")).join(" ");
    }

    async function flash() {
        if (!firmware) return;
        const token = ui.beginOperation("flash-firmware", { critical: true });
        if (!token) return;

        const image = firmware;
        const name = firmwareName;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);
        ui.log(t("arch_flash_start", name, format.formatBytes(image.length)), "info");

        try {
            if (!serial.isSupported()) throw new Error(t("lbjBrowserUnsupported"));
            if (!serial.isConnected()) await serial.connect();

            // 1. The bootloader streams 0x0518 messages; five steady intervals
            //    mean we can trust the advertised bootloader version.
            ui.log(t("arch_flash_waiting"), "info");
            const device = await serial.waitForBootloader(ui.log);
            ui.log(t("arch_flash_uid", formatUid(device.uid)), "info");
            ui.log(t("arch_flash_bootloader", device.blVersion), "info");

            if (!format.isBootloaderCompatible(device.blVersion, serial.FW_MIN_BOOTLOADER)) {
                throw new Error(t("arch_flash_bootloader_old", device.blVersion, serial.FW_MIN_BOOTLOADER));
            }

            // 2. Echo the version so the bootloader accepts programming commands.
            ui.log(t("arch_flash_handshake"), "info");
            await serial.performHandshake(device.blVersion, ui.log);

            // 3. Program the image, one 256-byte page at a time.
            ui.log(t("arch_flash_programming", Math.ceil(image.length / serial.FW_PAGE_SIZE)), "info");
            let painted = -1;
            await serial.programFirmware(image, {
                onLog: ui.log,
                onProgress: percent => {
                    const rounded = ui.updateProgress(percent);
                    if (rounded !== painted && rounded % 5 === 0) {
                        painted = rounded;
                        void ui.paint();
                    }
                }
            });

            ui.updateProgress(100);
            ui.log(t("arch_flash_complete", name), "success");
            setTimeout(() => ui.setProgressVisible(false), 1200);
        } catch (error) {
            ui.setProgressVisible(false);
            ui.log(t("error", error?.message ?? String(error)), "error");
        } finally {
            if (serial.isConnected()) await serial.disconnect().catch(() => undefined);
            ui.endOperation(token);
        }
    }

    if (flashBtn) flashBtn.addEventListener("click", () => { void flash(); });

    // ---- View lifecycle -----------------------------------------------------

    window.addEventListener("uvstudio:languagechange", () => {
        if (catalogState === "ready" || catalogGroups.length) renderCatalog();
        setFirmware(firmware, firmwareName);
    });

    ui.onViewChange(detail => {
        if (detail.view === "flash") void loadCatalog();
    });

    setFirmware(null, "");
    updateButtons();
})();
