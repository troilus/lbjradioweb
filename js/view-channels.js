/* Channel editor — read, edit and write the radio's MR channels.
 *
 * The channel records, names and attributes live in the external flash:
 *   0x000000 + n*16  record
 *   0x004000 + n*16  GB2312 name (10 bytes used)
 *   0x008000 + n*2   attribute word
 *
 * The page uses the same 0x051B/0x051D EEPROM commands as the calibration
 * view. Writing a channel does not reload the firmware's RAM copy, so the
 * user is asked to reboot the radio afterwards.
 */
;(function () {
    "use strict";

    const ui = window.UVToolsUI;
    const serial = window.LBJSerial;
    const F = window.UVTOOLS_CHANNEL_FORMAT;
    const t = ui.t;

    const view = document.getElementById("channels-content");
    if (!view || !F) return;

    const readBtn = document.getElementById("channelReadBtn");
    const writeBtn = document.getElementById("channelWriteBtn");
    const writeAllBtn = document.getElementById("channelWriteAllBtn");
    const rebootBtn = document.getElementById("channelRebootBtn");
    const filterEl = document.getElementById("channelFilter");
    const showEmptyEl = document.getElementById("channelShowEmpty");
    const modifiedEl = document.getElementById("channelModified");
    const resultsEl = document.getElementById("channelResults");
    const rowsEl = document.getElementById("channelRows");
    const emptyEl = document.getElementById("channelEmpty");

    const modal = document.getElementById("channelEditModal");
    const modalTitle = document.getElementById("channelEditTitle");
    const modalError = document.getElementById("channelEditError");
    const editName = document.getElementById("channelEditName");
    const editRx = document.getElementById("channelEditRx");
    const editOffset = document.getElementById("channelEditOffset");
    const editDirection = document.getElementById("channelEditDirection");
    const editRxToneType = document.getElementById("channelEditRxToneType");
    const editRxTone = document.getElementById("channelEditRxTone");
    const editTxToneType = document.getElementById("channelEditTxToneType");
    const editTxTone = document.getElementById("channelEditTxTone");
    const editMod = document.getElementById("channelEditMod");
    const editBw = document.getElementById("channelEditBw");
    const editPower = document.getElementById("channelEditPower");
    const editStep = document.getElementById("channelEditStep");
    const editScan = document.getElementById("channelEditScan");
    const editCompander = document.getElementById("channelEditCompander");
    const editBcl = document.getElementById("channelEditBcl");
    const editTxLock = document.getElementById("channelEditTxLock");
    const editReverse = document.getElementById("channelEditReverse");
    const editSave = document.getElementById("channelEditSave");
    const editCancel = document.getElementById("channelEditCancel");
    const editClose = document.getElementById("channelEditClose");

    let channels = [];
    let attributes = new Uint8Array(F.CHANNEL_COUNT * F.ATTR_SIZE);
    let loaded = false;
    let timestamp = 0;
    let sortKey = "num";
    let sortAsc = true;
    let editingIndex = -1;

    // ---- Selects ------------------------------------------------------------

    function fillSelect(select, options) {
        if (!select) return;
        select.innerHTML = "";
        for (const option of options) {
            select.appendChild(new Option(option.label, String(option.value)));
        }
    }

    function initSelects() {
        fillSelect(editDirection, [
            { value: 0, label: t("channelDirectionOff") },
            { value: 1, label: t("channelDirectionPlus") },
            { value: 2, label: t("channelDirectionMinus") }
        ]);
        fillSelect(editMod, F.MODULATIONS.map(item => ({ value: item.value, label: item.label })));
        fillSelect(editBw, [
            { value: 0, label: t("channelBandwidthWide") },
            { value: 1, label: t("channelBandwidthNarrow") }
        ]);
        fillSelect(editPower, F.POWER_NAMES.map((label, value) => ({ value, label })));
        fillSelect(editStep, F.STEP_NAMES.map((label, value) => ({ value, label })));
        fillSelect(editScan, [{ value: 0, label: t("channelScanOff") }]
            .concat(Array.from({ length: 24 }, (_, index) => ({
                value: index + 1,
                label: String(index + 1)
            })))
            .concat([{ value: 25, label: t("channelScanAll") }]));
        fillSelect(editCompander, [
            { value: 0, label: t("channelCompanderOff") },
            { value: 1, label: "1" },
            { value: 2, label: "2" },
            { value: 3, label: "3" }
        ]);
        fillSelect(editRxToneType, F.TONE_TYPES.map((label, value) => ({ value, label })));
        fillSelect(editTxToneType, F.TONE_TYPES.map((label, value) => ({ value, label })));
    }

    function fillToneCodes(select, type, code) {
        if (!select) return;
        select.innerHTML = "";
        if (type === 0) {
            select.appendChild(new Option(t("channelToneOff"), "0"));
        } else if (type === 1) {
            F.CTCSS_VALS.forEach((value, index) => {
                select.appendChild(new Option((value / 10).toFixed(1) + "Hz", String(index)));
            });
        } else {
            F.DCS_VALS.forEach((value, index) => {
                select.appendChild(new Option("D" + value.toString(8).padStart(3, "0"), String(index)));
            });
        }
        select.value = String(code);
        if (select.value !== String(code)) select.selectedIndex = 0;
    }

    initSelects();
    fillToneCodes(editRxTone, 0, 0);
    fillToneCodes(editTxTone, 0, 0);

    // ---- State / buttons ----------------------------------------------------

    function modifiedCount() {
        return channels.reduce((count, channel) => count + (channel._modified ? 1 : 0), 0);
    }

    function validCount() {
        return channels.reduce((count, channel) => count + (F.isValid(channel) ? 1 : 0), 0);
    }

    function updateButtons() {
        const busy = ui.isBusy();
        const modified = modifiedCount();
        if (readBtn) readBtn.disabled = busy;
        if (writeBtn) writeBtn.disabled = busy || !loaded || modified === 0;
        if (writeAllBtn) writeAllBtn.disabled = busy || !loaded || validCount() === 0;
        if (rebootBtn) rebootBtn.disabled = busy;
        if (modifiedEl) {
            modifiedEl.hidden = modified === 0;
            modifiedEl.textContent = modified > 0 ? t("channelModifiedCount", modified) : "";
        }
    }

    ui.onBusyChange(updateButtons);

    // ---- Table --------------------------------------------------------------

    function scanLabel(value) {
        if (value === 0) return t("channelScanOff");
        if (value >= 25) return t("channelScanAll");
        return String(value);
    }

    function rowHtml(channel) {
        const valid = F.isValid(channel);
        const offset = channel.direction === 0
            ? "-"
            : (channel.direction === 1 ? "+" : "-") + F.formatFrequency(channel.txOffset);
        return `<tr data-index="${channel.num}"${channel._modified ? ' class="channel-row-modified"' : ""}>`
            + `<td class="slot-col-idx">${channel.num + 1}</td>`
            + `<td class="channel-freq">${valid ? F.formatFrequency(channel.rxFreq) : "-"}</td>`
            + `<td class="channel-name">${ui.escapeHtml(channel.name) || "-"}</td>`
            + `<td>${F.MODULATION_LABELS[channel.modulation] || "?"}</td>`
            + `<td>${F.POWER_NAMES[channel.outputPower] || "?"}</td>`
            + `<td>${channel.bandwidth ? t("channelBandwidthNarrowShort") : t("channelBandwidthWideShort")}</td>`
            + `<td>${F.STEP_NAMES[channel.stepSetting] || "-"}</td>`
            + `<td>${offset}</td>`
            + `<td>${F.toneLabel(channel.rxCodeType, channel.rxCode)}</td>`
            + `<td>${scanLabel(channel.scanlist)}</td>`
            + `<td><button class="btn channel-edit-btn" type="button" data-index="${channel.num}">${t("channelEdit")}</button></td>`
            + "</tr>";
    }

    function compareChannels(a, b) {
        let left;
        let right;
        switch (sortKey) {
            case "rx": left = a.rxFreq; right = b.rxFreq; break;
            case "name": left = a.name; right = b.name; break;
            case "mode": left = a.modulation; right = b.modulation; break;
            default: left = a.num; right = b.num; break;
        }
        if (typeof left === "string") {
            return sortAsc ? left.localeCompare(right) : right.localeCompare(left);
        }
        return sortAsc ? left - right : right - left;
    }

    function render() {
        if (!loaded) return;
        const needle = (filterEl?.value ?? "").trim().toLowerCase();
        const showEmpty = Boolean(showEmptyEl?.checked);

        let list = channels.filter(channel => {
            if (!showEmpty && !F.isValid(channel)) return false;
            if (!needle) return true;
            return String(channel.num + 1).includes(needle)
                || channel.name.toLowerCase().includes(needle)
                || F.formatFrequency(channel.rxFreq).includes(needle);
        });
        list = list.slice().sort(compareChannels);

        if (rowsEl) rowsEl.innerHTML = list.map(rowHtml).join("");
        if (emptyEl) emptyEl.hidden = list.length > 0;
        if (resultsEl) resultsEl.hidden = false;
        updateButtons();
    }

    view.querySelectorAll(".channel-table th[data-sort]").forEach(header => {
        header.addEventListener("click", () => {
            const key = header.dataset.sort;
            if (sortKey === key) sortAsc = !sortAsc;
            else {
                sortKey = key;
                sortAsc = true;
            }
            render();
        });
    });

    if (filterEl) filterEl.addEventListener("input", render);
    if (showEmptyEl) showEmptyEl.addEventListener("change", render);

    if (rowsEl) {
        rowsEl.addEventListener("click", event => {
            const button = event.target.closest(".channel-edit-btn");
            if (!button) return;
            openEdit(Number(button.dataset.index));
        });
    }

    // ---- Read ---------------------------------------------------------------

    async function connectIfNeeded() {
        if (!serial.isSupported()) throw new Error(t("lbjBrowserUnsupported"));
        if (!serial.isConnected()) {
            ui.log(t("establishing"), "info");
            await serial.connect();
        }
    }

    async function readDevice() {
        const device = await serial.requestDeviceInfo();
        timestamp = device.timestamp;
        return device;
    }

    async function readChannels() {
        if (channels.some(channel => channel._modified)) {
            const proceed = await ui.confirm({
                title: t("channelRead"),
                body: t("channelReadDiscard"),
                confirmLabel: t("channelRead"),
                danger: true
            });
            if (!proceed) return;
        }

        const token = ui.beginOperation("read-channels");
        if (!token) return;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);

        try {
            await connectIfNeeded();
            const device = await readDevice();
            ui.log(t("channelReading", device.name || "radio"), "info");

            const recordBytes = await serial.readEepromRange(
                F.RECORD_BASE, F.CHANNEL_COUNT * F.RECORD_SIZE, timestamp,
                fraction => ui.updateProgress(fraction * 70));
            const nameBytes = await serial.readEepromRange(
                F.NAME_BASE, F.CHANNEL_COUNT * F.NAME_BLOCK, timestamp,
                fraction => ui.updateProgress(70 + fraction * 25));
            attributes = await serial.readEepromRange(
                F.ATTR_BASE, F.CHANNEL_COUNT * F.ATTR_SIZE, timestamp,
                fraction => ui.updateProgress(95 + fraction * 5));

            channels = [];
            for (let index = 0; index < F.CHANNEL_COUNT; index++) {
                channels.push(F.parseChannel(
                    index,
                    recordBytes.subarray(index * F.RECORD_SIZE, (index + 1) * F.RECORD_SIZE),
                    nameBytes.subarray(index * F.NAME_BLOCK, (index + 1) * F.NAME_BLOCK),
                    attributes.subarray(index * F.ATTR_SIZE, (index + 1) * F.ATTR_SIZE)
                ));
            }
            loaded = true;
            if (rebootBtn) rebootBtn.hidden = true;
            if (filterEl) filterEl.value = "";
            render();
            ui.updateProgress(100);
            ui.log(t("channelReadDone", validCount()), "success");
            setTimeout(() => {
                ui.setProgressVisible(false);
                ui.updateProgress(0);
            }, 800);
        } catch (error) {
            ui.setProgressVisible(false);
            ui.log(t("error", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    // ---- Edit ---------------------------------------------------------------

    function currentAttributeWord(index) {
        return attributes[index * F.ATTR_SIZE] | (attributes[index * F.ATTR_SIZE + 1] << 8);
    }

    function showError(message) {
        if (modalError) {
            modalError.textContent = message;
            modalError.hidden = false;
        }
        ui.log(message, "error");
    }

    function clearError() {
        if (modalError) {
            modalError.hidden = true;
            modalError.textContent = "";
        }
    }

    function openEdit(index) {
        const channel = channels[index];
        if (!channel) return;
        editingIndex = index;
        clearError();

        if (modalTitle) modalTitle.textContent = t("channelEditTitle", channel.num + 1);
        if (editName) editName.value = channel.name;
        if (editRx) editRx.value = F.isValid(channel) ? F.formatFrequency(channel.rxFreq) : "";
        if (editOffset) editOffset.value = channel.txOffset ? F.formatFrequency(channel.txOffset) : "";
        if (editDirection) editDirection.value = String(channel.direction);
        if (editRxToneType) editRxToneType.value = String(channel.rxCodeType);
        if (editTxToneType) editTxToneType.value = String(channel.txCodeType);
        fillToneCodes(editRxTone, channel.rxCodeType, channel.rxCode);
        fillToneCodes(editTxTone, channel.txCodeType, channel.txCode);
        if (editMod) editMod.value = String(channel.modulation);
        if (editBw) editBw.value = String(channel.bandwidth);
        if (editPower) editPower.value = String(channel.outputPower);
        if (editStep) editStep.value = String(channel.stepSetting);
        if (editScan) editScan.value = String(channel.scanlist);
        if (editCompander) editCompander.value = String(channel.compander);
        if (editBcl) editBcl.checked = Boolean(channel.bcl);
        if (editTxLock) editTxLock.checked = Boolean(channel.txLock);
        if (editReverse) editReverse.checked = Boolean(channel.freqReverse);

        if (modal) {
            modal.classList.add("show");
            modal.setAttribute("aria-hidden", "false");
        }
        if (editName) editName.focus();
    }

    function closeEdit() {
        editingIndex = -1;
        if (modal) {
            modal.classList.remove("show");
            modal.setAttribute("aria-hidden", "true");
        }
        clearError();
    }

    function parseOffset(text) {
        const value = String(text ?? "").trim();
        if (!value) return 0;
        const parsed = Math.round(parseFloat(value.replace(",", ".")) * 100000);
        return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0xFFFFFFFF ? parsed : null;
    }

    function nameError(error) {
        const message = String(error?.message ?? "");
        if (message === "too-long") return t("channelNameTooLong");
        if (message === "control") return t("channelNameControl");
        if (message.startsWith("unsupported:")) {
            return t("channelNameUnsupported", message.slice("unsupported:".length));
        }
        return t("error", message);
    }

    function saveEdit() {
        if (editingIndex < 0) return;
        const channel = channels[editingIndex];

        let nameBytes;
        const name = String(editName?.value ?? "").trim();
        try {
            nameBytes = F.encodeName(name);
        } catch (error) {
            showError(nameError(error));
            return;
        }

        const frequency = F.parseFrequency(editRx?.value ?? "");
        if (frequency === null) {
            showError(t("channelInvalidFreq"));
            return;
        }
        const offset = parseOffset(editOffset?.value ?? "");
        if (offset === null) {
            showError(t("channelInvalidOffset"));
            return;
        }

        channel.name = name;
        channel.rxFreq = frequency;
        channel.txOffset = offset;
        channel.direction = Number(editDirection?.value ?? 0);
        channel.rxCodeType = Number(editRxToneType?.value ?? 0);
        channel.rxCode = Number(editRxTone?.value ?? 0);
        channel.txCodeType = Number(editTxToneType?.value ?? 0);
        channel.txCode = Number(editTxTone?.value ?? 0);
        channel.modulation = Number(editMod?.value ?? 0);
        channel.bandwidth = Number(editBw?.value ?? 0);
        channel.outputPower = Number(editPower?.value ?? 1);
        channel.stepSetting = Number(editStep?.value ?? 4);
        channel.scanlist = Number(editScan?.value ?? 0);
        channel.compander = Number(editCompander?.value ?? 0);
        channel.bcl = Boolean(editBcl?.checked);
        channel.txLock = Boolean(editTxLock?.checked);
        channel.freqReverse = Boolean(editReverse?.checked);
        channel._nameBytes = nameBytes;

        const word = F.buildAttributeWord(channel, currentAttributeWord(channel.num));
        attributes[channel.num * F.ATTR_SIZE] = word & 0xFF;
        attributes[channel.num * F.ATTR_SIZE + 1] = (word >> 8) & 0xFF;
        channel.band = word & 7;
        channel._modified = true;

        closeEdit();
        render();
    }

    // ---- Write --------------------------------------------------------------

    function channelNameBytes(channel) {
        if (channel._nameBytes) return channel._nameBytes;
        try {
            return F.encodeName(channel.name);
        } catch (error) {
            return new Uint8Array(F.NAME_BLOCK);
        }
    }

    async function writeChannels(list) {
        if (!loaded || list.length === 0) return;
        const token = ui.beginOperation("write-channels");
        if (!token) return;
        ui.showLog();
        ui.setProgressVisible(true);
        ui.updateProgress(0);

        try {
            await connectIfNeeded();
            await readDevice();
            ui.log(t("channelWriting", list.length), "info");

            const attributeBlocks = new Set();
            for (const channel of list) attributeBlocks.add(channel.num & ~3);

            const total = list.length * 2 + attributeBlocks.size;
            let done = 0;

            for (const channel of list) {
                await serial.writeEepromRange(
                    F.RECORD_BASE + channel.num * F.RECORD_SIZE,
                    timestamp,
                    F.buildRecord(channel)
                );
                done++;
                ui.updateProgress((done / total) * 100);

                await serial.writeEepromRange(
                    F.NAME_BASE + channel.num * F.NAME_BLOCK,
                    timestamp,
                    channelNameBytes(channel)
                );
                done++;
                ui.updateProgress((done / total) * 100);
            }

            for (const start of attributeBlocks) {
                const offset = start * F.ATTR_SIZE;
                const block = attributes.slice(offset, offset + 8);
                await serial.writeEepromRange(F.ATTR_BASE + offset, timestamp, block);
                done++;
                ui.updateProgress((done / total) * 100);
            }

            for (const channel of list) {
                channel._modified = false;
            }
            render();
            if (rebootBtn) rebootBtn.hidden = false;
            ui.updateProgress(100);
            ui.log(t("channelWriteDone", list.length), "success");
            setTimeout(() => {
                ui.setProgressVisible(false);
                ui.updateProgress(0);
            }, 800);
        } catch (error) {
            ui.setProgressVisible(false);
            ui.log(t("error", error?.message ?? String(error)), "error");
        } finally {
            ui.endOperation(token);
        }
    }

    async function writeSelected() {
        const list = channels.filter(channel => channel._modified);
        if (list.length === 0) {
            ui.log(t("channelNoChanges"), "info");
            return;
        }
        if (!(await ui.confirm({
            title: t("channelWriteSelected"),
            body: t("channelConfirmWrite", list.length),
            confirmLabel: t("channelWriteSelected")
        }))) return;
        await writeChannels(list);
    }

    async function writeAll() {
        const list = channels.filter(F.isValid);
        if (list.length === 0) return;
        if (!(await ui.confirm({
            title: t("channelWriteAll"),
            body: t("channelConfirmWriteAll", list.length),
            confirmLabel: t("channelWriteAll"),
            danger: true
        }))) return;
        await writeChannels(list);
    }

    async function reboot() {
        if (!(await ui.confirm({
            title: t("channelReboot"),
            body: t("channelRebootConfirm"),
            confirmLabel: t("channelReboot")
        }))) return;
        try {
            await serial.reboot();
            ui.log(t("channelRebootSent"), "success");
        } catch (error) {
            ui.log(t("error", error?.message ?? String(error)), "error");
        }
    }

    // ---- Wiring -------------------------------------------------------------

    if (readBtn) readBtn.addEventListener("click", () => { void readChannels(); });
    if (writeBtn) writeBtn.addEventListener("click", () => { void writeSelected(); });
    if (writeAllBtn) writeAllBtn.addEventListener("click", () => { void writeAll(); });
    if (rebootBtn) rebootBtn.addEventListener("click", () => { void reboot(); });
    if (editSave) editSave.addEventListener("click", saveEdit);
    if (editCancel) editCancel.addEventListener("click", closeEdit);
    if (editClose) editClose.addEventListener("click", closeEdit);
    if (modal) {
        modal.addEventListener("click", event => {
            if (event.target === modal) closeEdit();
        });
    }
    if (editRxToneType) {
        editRxToneType.addEventListener("change", () => {
            fillToneCodes(editRxTone, Number(editRxToneType.value), 0);
        });
    }
    if (editTxToneType) {
        editTxToneType.addEventListener("change", () => {
            fillToneCodes(editTxTone, Number(editTxToneType.value), 0);
        });
    }

    window.addEventListener("uvstudio:languagechange", () => {
        initSelects();
        if (loaded) render();
    });

    ui.onViewChange(detail => {
        if (detail.view !== "channels") closeEdit();
    });

    updateButtons();
})();
