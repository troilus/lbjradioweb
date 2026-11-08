/* K5/K6 V1 TDCS 解码 — legacy V1 flashing and calibration backup.
 *
 * V1 radios use the old 2.00.06 / 3.x bootloader and the k5prog/uvmod
 * 0x0518/0x0530/0x0519/0x051A exchange; the 7.00.07 DFU flow in
 * view-flash.js rejects them. The calibration block is fixed at EEPROM
 * 0x1E00..0x1FFF: egzumer's SETTINGS_LoadCalibration reads 0x1EC0 (RSSI),
 * 0x1EC8 (RSSI), 0x1F40 (battery) and 0x1F88 (misc), and k5prog treats
 * 0x1D00..0x1FFF as the calibration area. Do not use the v5+ 0xB000 offset
 * here even if a V1 build reports a v5-style name.
 */
;(function () {
    "use strict";

    const ui = window.UVToolsUI;
    const serial = window.LBJSerial;
    const catalog = window.UVTOOLS_CATALOG;
    const k5 = window.UVTOOLS_K5_FIRMWARE;
    const format = window.UVTOOLS_RADIO_FORMAT;
    const t = ui.t;

    const view = document.getElementById("k5tdcs-content");
    if (!view) return;

    // V1 EEPROM calibration: 512 bytes at 0x1E00 (k5prog/egzumer layout).
    const V1_CALIBRATION_OFFSET = 0x1E00;

    const calibBtn = document.getElementById("k5CalibReadBtn");
    const calibDownload = document.getElementById("k5CalibDownload");
    const calibLink = document.getElementById("k5CalibLink");
    const catalogSection = document.getElementById("k5FirmwareCatalogSection");
    const catalogSelect = document.getElementById("k5FirmwareCatalogSelect");
    const catalogOr = document.getElementById("k5FirmwareCatalogOr");
    const reloadBtn = document.getElementById("k5FirmwareReloadBtn");
    const fileInput = document.getElementById("k5FirmwareFile");
    const fileLabel = document.getElementById("k5FileLabel");
    const fileName = document.getElementById("k5FileName");
    const metaEl = document.getElementById("k5FlashMeta");
    const flashBtn = document.getElementById("k5FlashBtn");

    let selection = null;        // { bytes, name, image, format, version, versionBlock, error }
    let entries = [];            // K5 catalog entries
    let catalogState = "idle";   // idle | loading | ready | error
    let loadSequence = 0;
    let calibUrl = null;
    let progressTimer = null;

    function clearProgressTimer() {
        if (progressTimer) {
            clearTimeout(progressTimer);
            progressTimer = null;
        }
    }

    // The calibration dump and the flash share one progress bar; cancel the
    // previous "hide" timer so it cannot hide the next operation's progress.
    function hideProgressSoon(delayMs) {
        clearProgressTimer();
        progressTimer = setTimeout(() => {
            progressTimer = null;
            // Do not touch the shared bar after the user moved to another view.
            if (ui.currentView() !== "k5tdcs") return;
            ui.setProgressVisible(false);
            ui.updateProgress(0);
        }, delayMs);
    }

    // ---- Firmware selection -------------------------------------------------

    function setFirmware(bytes, name) {
        selection = bytes
            ? Object.assign({ bytes, name: name || "" }, k5.inspect(bytes))
            : null;

        const hasFile = Boolean(bytes);
        if (fileName) {
            fileName.textContent = hasFile ? selection.name : t("fileNoFile");
            fileName.classList.toggle("has-file", hasFile);
        }
        if (fileLabel) fileLabel.classList.toggle("has-file", hasFile);
        if (metaEl) {
            metaEl.classList.toggle("is-error", Boolean(selection?.error));
            if (!selection) {
                metaEl.textContent = "";
            } else if (selection.error === "too-large") {
                metaEl.textContent = t("k5TooLarge", format.formatBytes(selection.image.length));
            } else if (selection.error === "empty") {
                metaEl.textContent = t("k5EmptyFirmware");
            } else {
                const formatText = selection.format === "packed"
                    ? t("k5FormatPacked", selection.version || "?")
                    : t("k5FormatRaw");
                metaEl.textContent = t("k5Meta", selection.name,
                    format.formatBytes(selection.image.length), formatText);
            }
        }
        updateButtons();
    }

    function clearFirmware() {
        if (fileInput) fileInput.value = "";
        setFirmware(null, "");
    }

    function updateButtons() {
        const busy = ui.isBusy();
        if (flashBtn) {
            flashBtn.disabled = busy || !selection?.image || Boolean(selection?.error);
        }
        if (calibBtn) calibBtn.disabled = busy;
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
            reader.onerror = () => {
                clearFirmware();
                ui.log(t("arch_load_error", file.name), "error");
            };
            reader.readAsArrayBuffer(file);
        });
    }

    // ---- Catalog (archive/k5tdcs-*.bin only) --------------------------------

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

        entries.forEach(entry => {
            const option = document.createElement("option");
            option.value = entry.name;
            option.textContent = catalog.formatEntryLabel(entry);
            catalogSelect.appendChild(option);
        });

        if (previous) {
            const match = Array.from(catalogSelect.options).find(option => option.value === previous);
            if (match) catalogSelect.value = previous;
        }
        if (catalogSection) catalogSection.hidden = entries.length === 0;
        if (catalogOr) catalogOr.hidden = entries.length === 0;
        catalogState = entries.length ? "ready" : "error";
        updateButtons();
    }

    async function loadCatalog(options) {
        if (!catalog || catalogState === "loading") return;
        catalogState = "loading";
        updateButtons();
        const result = await catalog.loadK5Firmware({ force: Boolean(options?.force) });
        entries = result.entries;
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
            if (!entries.length) catalogState = "error";
        } else if (!entries.length) {
            ui.log(t("k5CatalogEmpty"), "info");
        } else if (result.cached && !result.stale) {
            ui.log(t("arch_catalog_cached", entries.length), "info");
        }
        updateButtons();
    }

    if (catalogSelect) {
        catalogSelect.addEventListener("change", async () => {
            const name = catalogSelect.value;
            if (!name) return;
            const entry = entries.find(item => item.name === name);
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

    // ---- Calibration backup (V1 EEPROM 0x1E00) ------------------------------

    function hexOffset(offset) {
        return offset.toString(16).toUpperCase();
    }

    async function backupCalibration() {
        const token = ui.beginOperation("dump-calibration");
        if (!token) return;
        clearProgressTimer();
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);

        try {
            if (!serial.isSupported()) throw new Error(t("lbjBrowserUnsupported"));
            if (!serial.isConnected()) {
                ui.log(t("establishing"), "info");
                await serial.connect();
            }

            const device = await serial.requestDeviceInfo();
            ui.log(t("deviceDetected"), "success");
            ui.log(t("dumpingData"), "info");
            ui.log(t("readingEeprom", hexOffset(V1_CALIBRATION_OFFSET)), "info");

            const image = await serial.readCalibration(
                device.timestamp, V1_CALIBRATION_OFFSET,
                fraction => { ui.updateProgress(fraction * 100); });

            ui.updateProgress(100);
            if (calibUrl) URL.revokeObjectURL(calibUrl);
            calibUrl = URL.createObjectURL(new Blob([image], { type: "application/octet-stream" }));
            if (calibLink) {
                calibLink.href = calibUrl;
                calibLink.download = "calibration.dat";
            }
            if (calibDownload) calibDownload.style.display = "flex";

            ui.log(t("dumpComplete"), "success");
            ui.log(t("dumpSaved"), "success");
            hideProgressSoon(800);
        } catch (error) {
            ui.setProgressVisible(false);
            if (error?.code === "EEPROM_ERROR") {
                ui.log(t("eepromError", hexOffset(error.offset)), "error");
            } else {
                ui.log(t("error", error?.message ?? String(error)), "error");
            }
        } finally {
            ui.endOperation(token);
        }
    }

    if (calibBtn) calibBtn.addEventListener("click", () => { void backupCalibration(); });

    // ---- Legacy V1 flashing -------------------------------------------------

    async function flash() {
        if (!selection?.image || selection.error) return;
        const token = ui.beginOperation("flash-k5-firmware", { critical: true });
        if (!token) return;
        clearProgressTimer();

        const image = selection.image;
        const name = selection.name;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);
        ui.log(t("arch_flash_start", name, format.formatBytes(image.length)), "info");

        try {
            if (!serial.isSupported()) throw new Error(t("lbjBrowserUnsupported"));
            if (!serial.isConnected()) await serial.connect();

            ui.log(t("k5FlashWaiting"), "info");
            const device = await serial.waitForLegacyBootloader(ui.log);
            ui.log(t("arch_flash_bootloader", device.blVersion), "info");

            // 2.x / 3.x are V1. 4.x is the UV-5R Plus and 7.x is the V3/K1
            // bootloader, which needs the normal Flash firmware page.
            const major = Number.parseInt(device.blVersion, 10);
            if (Number.isFinite(major) && major >= 4) {
                throw new Error(t("k5FlashNotV1", device.blVersion));
            }

            ui.log(t("arch_flash_handshake"), "info");
            await serial.legacyHandshake(selection.versionBlock, ui.log);

            const pageCount = Math.ceil(image.length / serial.LEGACY_PAGE_SIZE);
            ui.log(t("arch_flash_programming", pageCount), "info");

            let painted = -1;
            await serial.programFirmwareLegacy(image, {
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
            ui.log(t("k5FlashPowerCycle"), "info");
            hideProgressSoon(1200);
        } catch (error) {
            ui.setProgressVisible(false);
            if (error?.code === "NO_BOOTLOADER") {
                ui.log(t("k5NoBootloader"), "error");
            } else {
                ui.log(t("error", error?.message ?? String(error)), "error");
            }
        } finally {
            if (serial.isConnected()) await serial.disconnect().catch(() => undefined);
            ui.endOperation(token);
        }
    }

    if (flashBtn) flashBtn.addEventListener("click", () => { void flash(); });

    // ---- View lifecycle -----------------------------------------------------

    window.addEventListener("uvstudio:languagechange", () => {
        if (catalogState === "ready" || entries.length) renderCatalog();
        if (selection) setFirmware(selection.bytes, selection.name);
    });

    ui.onViewChange(detail => {
        if (detail.view === "k5tdcs") {
            void loadCatalog();
        } else {
            clearProgressTimer();
        }
    });

    setFirmware(null, "");
    updateButtons();
})();
