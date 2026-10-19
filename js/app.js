/* LBJ Log view wiring.
 *
 * Shell behaviour (console, progress, serial status pill, theme, routing) lives
 * in js/ui.js; the read flow follows UV Studio's js/flash.js (flash.js?v=84).
 */
;(function () {
    "use strict";

    const ui = window.UVToolsUI;
    const L = window.UVTOOLS_LBJ_LOG;
    const serial = window.LBJSerial;
    const t = ui.t;

    const readBtn = document.getElementById("lbjReadBtn");
    const resultsEl = document.getElementById("lbjResults");
    const metaEl = document.getElementById("lbjMeta");
    const rowsEl = document.getElementById("lbjRows");
    const emptyEl = document.getElementById("lbjEmpty");
    const filterEl = document.getElementById("lbjFilter");
    const csvDownload = document.getElementById("lbjCsvDownload");
    const csvLink = document.getElementById("lbjCsvLink");
    const binDownload = document.getElementById("lbjBinDownload");
    const binLink = document.getElementById("lbjBinLink");

    let parsedRows = [];
    let csvUrl = null;
    let binUrl = null;

    // ---- Table --------------------------------------------------------------

    function renderRows() {
        if (!rowsEl) return;
        const needle = (filterEl?.value ?? "").trim().toLowerCase();
        const rows = needle
            ? parsedRows.filter(row =>
                String(row.train).toLowerCase().includes(needle) ||
                String(row.loco_number).toLowerCase().includes(needle))
            : parsedRows;

        rowsEl.innerHTML = rows.map(row => "<tr>" + L.COLUMNS.map(column =>
            `<td>${ui.escapeHtml(row[column])}</td>`).join("") + "</tr>").join("");

        if (emptyEl) emptyEl.hidden = rows.length > 0;
    }

    if (filterEl) filterEl.addEventListener("input", renderRows);

    function updateReadButton() {
        if (!readBtn) return;
        readBtn.disabled = ui.isBusy();
    }

    ui.onBusyChange(updateReadButton);

    // ---- Read flow (UV Studio flash.js dump flow) ---------------------------

    async function readLbjLog() {
        const token = ui.beginOperation("read-lbj-log");
        if (!token) return;

        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);
        if (resultsEl) resultsEl.hidden = true;
        if (csvDownload) csvDownload.style.display = "none";
        if (binDownload) binDownload.style.display = "none";

        try {
            if (!serial.isSupported()) {
                throw new Error(t("lbjBrowserUnsupported"));
            }

            if (!serial.isConnected()) await serial.connect();
            ui.log(t("lbjReading"), "info");

            const device = await serial.requestDeviceInfo();
            if (!(await serial.hasExternalFlashSupport(device.timestamp))) {
                throw new Error(t("lbjUnsupported"));
            }

            const image = await serial.readLog(device.timestamp, fraction => {
                ui.updateProgress(fraction * 100);
                void ui.paint();
            });

            const parsed = L.parseLog(image);
            parsedRows = parsed.rows;

            if (csvUrl) { URL.revokeObjectURL(csvUrl); csvUrl = null; }
            if (binUrl) { URL.revokeObjectURL(binUrl); binUrl = null; }

            /* Reveal the download chips the way flash.js does (css/tools.css
               keeps .download-link at display:none until we show it). */
            if (csvLink && csvDownload) {
                csvUrl = URL.createObjectURL(new Blob(
                    [L.rowsToCsv(parsed.rows, { chinese: window.uvStudioI18n?.lang === "zh" })],
                    { type: "text/csv;charset=utf-8" }));
                csvLink.href = csvUrl;
                csvDownload.style.display = "flex";
            }
            if (binLink && binDownload) {
                binUrl = URL.createObjectURL(
                    new Blob([image], { type: "application/octet-stream" }));
                binLink.href = binUrl;
                binDownload.style.display = "flex";
            }

            if (metaEl) {
                const zone = `0x${L.LOG_BASE.toString(16).toUpperCase()}..0x${(L.LOG_BASE + L.LOG_SIZE - 1).toString(16).toUpperCase()}`;
                metaEl.textContent = t("lbjMeta", parsed.valid, parsed.unwritten, parsed.badCrc, zone);
            }
            if (resultsEl) resultsEl.hidden = false;
            if (filterEl) filterEl.value = "";
            renderRows();

            ui.updateProgress(100);
            ui.log(t("lbjReadDone", parsed.valid, device.name || "radio"), "success");
            setTimeout(() => ui.setProgressVisible(false), 800);
        } catch (error) {
            ui.setProgressVisible(false);
            ui.log(t("error", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    if (readBtn) readBtn.addEventListener("click", () => { void readLbjLog(); });

    // ---- Boot ---------------------------------------------------------------

    if (!serial.isSupported()) {
        ui.log(t("lbjBrowserUnsupported"), "error");
    }
})();
