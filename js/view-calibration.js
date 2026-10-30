/* 校准备份 — EEPROM calibration backup and restore.
 *
 * Mirrors UV Studio's calibration view (js/flash.js?v=84): 512 bytes are read
 * or written in 16-byte chunks over 0x051B/0x051D. The radio keeps calibration
 * at 0x1E00 on firmware < v5 and at 0xB000 from v5 on, chosen from the 0x0514
 * device name. Calibration is device-specific, so restore asks first.
 */
;(function () {
    "use strict";

    const ui = window.UVToolsUI;
    const serial = window.LBJSerial;
    const t = ui.t;

    const view = document.getElementById("calibration-content");
    if (!view) return;

    const tabs = Array.from(view.querySelectorAll(".action-tab"));
    const panels = Array.from(view.querySelectorAll(".action-view"));
    const dumpBtn = document.getElementById("dumpBtn");
    const dumpDownload = document.getElementById("dumpDownload");
    const dumpLink = document.getElementById("dumpLink");
    const fileInput = document.getElementById("calibFile");
    const fileLabel = document.getElementById("calibFileLabel");
    const fileName = document.getElementById("calibFileName");
    const restoreBtn = document.getElementById("restoreBtn");

    let dumpUrl = null;
    let calibration = null;      // Uint8Array (512 bytes)
    let calibrationName = "";

    // ---- Tabs ---------------------------------------------------------------

    function selectTab(action) {
        tabs.forEach(tab => {
            const selected = tab.dataset.action === action;
            tab.classList.toggle("active", selected);
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });
        panels.forEach(panel => {
            const selected = panel.dataset.actionPanel === action;
            panel.classList.toggle("active", selected);
            panel.hidden = !selected;
        });
    }

    tabs.forEach(tab => {
        tab.addEventListener("click", () => selectTab(tab.dataset.action));
        tab.addEventListener("keydown", event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const index = tabs.indexOf(tab);
            const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
            selectTab(next.dataset.action);
            next.focus();
        });
    });

    // ---- File selection -----------------------------------------------------

    function setCalibrationFile(bytes, name) {
        calibration = bytes;
        calibrationName = name || "";
        const hasFile = Boolean(bytes);
        if (fileName) {
            fileName.textContent = hasFile ? calibrationName : t("fileNoFile");
            fileName.classList.toggle("has-file", hasFile);
        }
        if (fileLabel) fileLabel.classList.toggle("has-file", hasFile);
        updateButtons();
    }

    function clearCalibrationFile() {
        if (fileInput) fileInput.value = "";
        setCalibrationFile(null, "");
    }

    function updateButtons() {
        const busy = ui.isBusy();
        if (dumpBtn) dumpBtn.disabled = busy;
        if (restoreBtn) restoreBtn.disabled = busy || !calibration;
        if (fileInput) fileInput.disabled = busy;
    }

    ui.onBusyChange(updateButtons);

    if (fileInput) {
        fileInput.addEventListener("change", event => {
            const file = event.target.files?.[0];
            if (!file) {
                clearCalibrationFile();
                return;
            }
            const reader = new FileReader();
            reader.onload = ev => {
                const bytes = new Uint8Array(ev.target.result);
                if (bytes.length !== serial.CALIB_SIZE) {
                    clearCalibrationFile();
                    ui.log(t("calibInvalidSize", bytes.length), "error");
                    return;
                }
                setCalibrationFile(bytes, file.name);
                ui.log(t("calibLoaded", file.name, bytes.length), "success");
            };
            reader.onerror = () => {
                clearCalibrationFile();
                ui.log(t("error", file.name), "error");
            };
            reader.readAsArrayBuffer(file);
        });
    }

    // ---- Shared helpers -----------------------------------------------------

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function hexOffset(offset) {
        return offset.toString(16).toUpperCase();
    }

    function logError(error) {
        if (error?.code === "EEPROM_ERROR") {
            ui.log(t("eepromError", hexOffset(error.offset)), "error");
        } else {
            ui.log(t("error", error?.message ?? String(error)), "error");
        }
    }

    async function connectIfNeeded() {
        if (!serial.isSupported()) throw new Error(t("lbjBrowserUnsupported"));
        if (!serial.isConnected()) {
            ui.log(t("establishing"), "info");
            await serial.connect();
        }
    }

    async function readDevice() {
        const device = await serial.requestDeviceInfo();
        ui.log(t("deviceDetected"), "success");
        return { timestamp: device.timestamp, offset: serial.calibrationOffset(device.name) };
    }

    function setProgress(ratio) {
        ui.updateProgress(ratio * 100);
    }

    // ---- Backup -------------------------------------------------------------

    async function dump() {
        const token = ui.beginOperation("dump-calibration");
        if (!token) return;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);

        try {
            await connectIfNeeded();
            const { timestamp, offset } = await readDevice();
            ui.log(t("dumpingData"), "info");
            ui.log(t("readingEeprom", hexOffset(offset)), "info");

            const image = await serial.readCalibration(timestamp, offset, setProgress);

            ui.updateProgress(100);
            if (dumpUrl) URL.revokeObjectURL(dumpUrl);
            dumpUrl = URL.createObjectURL(new Blob([image], { type: "application/octet-stream" }));
            if (dumpLink) {
                dumpLink.href = dumpUrl;
                dumpLink.download = "calibration.dat";
            }
            if (dumpDownload) dumpDownload.style.display = "flex";

            ui.log(t("dumpComplete"), "success");
            ui.log(t("dumpSaved"), "success");
            setTimeout(() => {
                ui.setProgressVisible(false);
                ui.updateProgress(0);
            }, 800);
        } catch (error) {
            ui.setProgressVisible(false);
            logError(error);
        } finally {
            ui.endOperation(token);
        }
    }

    // ---- Restore ------------------------------------------------------------

    async function restore() {
        if (!calibration) return;
        if (!(await ui.confirm({
            title: t("studio_nav_restore_calib"),
            body: t("calibrationRestoreConfirm"),
            confirmLabel: t("restoreBtn"),
            danger: true
        }))) return;

        const token = ui.beginOperation("restore-calibration", { critical: true });
        if (!token) return;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);

        const image = calibration;

        try {
            await connectIfNeeded();
            const { timestamp, offset } = await readDevice();
            ui.log(t("restoringData"), "info");
            ui.log(t("writingEeprom", hexOffset(offset)), "info");

            await serial.writeCalibration(image, timestamp, offset, setProgress);

            ui.updateProgress(100);
            ui.log(t("restoreComplete"), "success");
            ui.log(t("rebooting"), "info");
            await serial.reboot();
            await sleep(500);
            ui.log(t("rebootComplete"), "success");
            setTimeout(() => {
                ui.setProgressVisible(false);
                ui.updateProgress(0);
            }, 800);

            if (serial.isConnected()) await serial.disconnect().catch(() => undefined);
        } catch (error) {
            ui.setProgressVisible(false);
            logError(error);
        } finally {
            ui.endOperation(token);
        }
    }

    if (dumpBtn) dumpBtn.addEventListener("click", () => { void dump(); });
    if (restoreBtn) restoreBtn.addEventListener("click", () => { void restore(); });

    // ---- View lifecycle -----------------------------------------------------

    window.addEventListener("uvstudio:languagechange", () => {
        setCalibrationFile(calibration, calibrationName);
    });

    ui.onViewChange(detail => {
        if (detail.view === "calibration") selectTab("dump");
    });

    selectTab("dump");
    setCalibrationFile(null, "");
    updateButtons();
})();
