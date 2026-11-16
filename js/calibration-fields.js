/* 校准块字段解码 — 校准备份读到的 512 字节里，哪些字节是什么。
 *
 * 两个页面 dump 的是同一个 512 字节块，只是基址不同：
 *   K1 / K5V3 : 0xB000（固件把它映射到物理 0x010000，见
 *               App/driver/eeprom_compat.c 的 _MK_MAPPING(0x010000, 0xB000, 0xB200)）
 *   K5/K6 V1  : 0x1E00（egzumer / k5prog 布局）
 * 块内偏移两边完全一样，所以一张表两边通用，只要把基址传进来。
 *
 * 字段来源：固件 SETTINGS_LoadCalibration() 的读取地址，以及这套固件家族
 * CHIRP 模块（0x1F68 vox、0x1F80 mic、0x1F88 misc）的结构体定义。
 */
;(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.UVTOOLS_CALIB_FIELDS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CALIB_SIZE = 512;

    /* 块内偏移 → 字段。devices 决定这块数据在哪个机型上真的被读。 */
    const FIELDS = [
        {
            off: 0x0C0, key: "rssiCal3", type: "u16dec", count: 4,
            name: "rssiCal[3][4]",
            label: "RSSI 校准（高段）",
            meaning: "S 表的四个分段门限：RSSI 依次和它们比较，决定信号条显示几格；这一组用于高段频带",
            devices: ["k1", "k5"]
        },
        {
            off: 0x0C8, key: "rssiCal0", type: "u16dec", count: 4,
            name: "rssiCal[0][4]",
            label: "RSSI 校准（低段）",
            meaning: "同上，低段频带的四个门限；K1 会把这组复制给另外两个频带",
            devices: ["k1", "k5"]
        },
        {
            off: 0x140, key: "batteryCal", type: "u16dec", count: 6,
            name: "batteryCal[6]",
            label: "电池电压校准",
            meaning: "ADC 读数换算成实际电压的对照表（mV）；空值时代码回退到 1900 / 2000 mV",
            devices: ["k1", "k5"]
        },
        {
            off: 0x150, key: "vox1Thr", type: "u16dec", count: 10,
            name: "vox1Thr[10]",
            label: "VOX 关闭门限",
            meaning: "声控发射松开（停止发射）的阈值，按 VOX 档位取其中一项",
            devices: ["k1", "k5"]
        },
        {
            off: 0x168, key: "vox0Thr", type: "u16dec", count: 10,
            name: "vox0Thr[10]",
            label: "VOX 打开门限",
            meaning: "声控发射触发（开始发射）的阈值，按 VOX 档位取其中一项",
            devices: ["k1", "k5"]
        },
        {
            off: 0x180, key: "micLevel", type: "u8dec", count: 5,
            name: "micLevel[5]",
            label: "话筒增益",
            meaning: "发射时话筒的五档增益，按 MIC 设置取一项；K5 V1 只读其中一个字节",
            devices: ["k1", "k5"]
        },
        {
            off: 0x188, key: "xtalFreqLow", type: "i16",
            name: "xtalFreqLow",
            label: "晶振校准",
            meaning: "补偿 BK4819 参考晶振的个体频差，全频段收发频率都跟着它偏；-1000..+1000，FFFF 表示未校准",
            devices: ["k1", "k5"]
        },
        {
            off: 0x18A, key: "eeprom1F8A", type: "u16",
            name: "eeprom1F8A",
            label: "保留",
            meaning: "固件只做 & 0x01FF 读取，用途未公开",
            devices: ["k1", "k5"]
        },
        {
            off: 0x18C, key: "eeprom1F8C", type: "u16",
            name: "eeprom1F8C",
            label: "保留",
            meaning: "同上，只做 & 0x01FF 读取",
            devices: ["k1", "k5"]
        },
        {
            off: 0x18E, key: "volumeGain", type: "u8",
            name: "volumeGain",
            label: "AF 增益-2",
            meaning: "接收音频的第二级增益，决定喇叭音量；PA4 采的就是这一路，所以也决定 LBJ/TDCS 拿到的信号幅度（0..63，0.5 dB/步）",
            devices: ["k1", "k5"]
        },
        {
            off: 0x18F, key: "dacGain", type: "u8",
            name: "dacGain",
            label: "AF DAC 增益",
            meaning: "音频 DAC 的输出增益，叠在上一级之后，是音量的大头（0..15，约 2 dB/步）；改它比改 VOL 影响大得多",
            devices: ["k1", "k5"]
        },
        {
            off: 0x1F0, key: "stateBits", type: "u8hex", count: 8,
            name: "state[8]",
            label: "设置位",
            meaning: "DTMF 呼叫、开机密码、TX1750 等开关，按位打包；K5 V1 会读，K1 不读",
            devices: ["k5"]
        }
    ];

    const DEVICE_LABEL = {
        k1: { name: "K1 / K5V3", base: 0xB000, physical: 0x010000 },
        k5: { name: "K5/K6 V1", base: 0x1E00, physical: null }
    };

    // ---- 基础读取 -----------------------------------------------------------

    function hex(value, width) {
        return value.toString(16).toUpperCase().padStart(width, "0");
    }

    function readU16(bytes, off) {
        return (bytes[off] | (bytes[off + 1] << 8)) >>> 0;
    }

    function readI16(bytes, off) {
        const value = readU16(bytes, off);
        return value >= 0x8000 ? value - 0x10000 : value;
    }

    function isBlank(bytes) {
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] !== 0xFF) return false;
        }
        return true;
    }

    function allFF(bytes, off, len) {
        for (let i = 0; i < len; i++) {
            if (bytes[off + i] !== 0xFF) return false;
        }
        return true;
    }

    // ---- AF 增益换算 --------------------------------------------------------
    // REG_48：AF Rx Gain-2 每步 0.5 dB（-26..+5.5），AF DAC Gain 约 2 dB/步。

    function afGain(volumeGain, dacGain) {
        if (!(volumeGain <= 63) || !(dacGain <= 15)) return null;
        const gain2 = -26 + 0.5 * volumeGain;
        const dac = 2 * dacGain;
        return { volumeGain, dacGain, gain2, dac, total: gain2 + dac };
    }

    function db(value) {
        const rounded = Math.round(value * 10) / 10;
        return (rounded > 0 ? "+" : "") + rounded.toFixed(1) + " dB";
    }

    // ---- 解码 ---------------------------------------------------------------

    function decodeField(bytes, field, base, kind) {
        const off = field.off;
        const abs = base + off;
        const used = field.devices.indexOf(kind) >= 0;
        let raw = "";
        let value = "";
        let out = false;

        switch (field.type) {
            case "u8": {
                const v = bytes[off];
                raw = hex(v, 2);
                value = v + "（0x" + raw + "）";
                if (field.key === "volumeGain") {
                    out = v > 63;
                    if (!out) value += " → " + db(-26 + 0.5 * v);
                } else if (field.key === "dacGain") {
                    out = v > 15;
                    if (!out) value += " → " + db(2 * v);
                }
                break;
            }
            case "u16": {
                const v = readU16(bytes, off);
                raw = hex(v, 4);
                value = "0x" + raw + "（" + v + "）";
                break;
            }
            case "i16": {
                const v = readI16(bytes, off);
                raw = hex(readU16(bytes, off), 4);
                value = v + "（0x" + raw + "）";
                if (field.key === "xtalFreqLow") {
                    if (readU16(bytes, off) === 0xFFFF) {
                        value = "-1（0xFFFF，未校准）";
                    } else {
                        out = v < -1000 || v > 1000;
                    }
                }
                break;
            }
            case "u8hex":
            case "u8dec":
            case "u16dec": {
                const blank = allFF(bytes, off, field.type === "u16dec" ? field.count * 2 : field.count);
                raw = blank ? "FF…" : "";
                const parts = [];
                for (let i = 0; i < field.count; i++) {
                    if (field.type === "u16dec") parts.push(String(readU16(bytes, off + i * 2)));
                    else parts.push(String(bytes[off + i]));
                }
                value = blank ? "（空）" : parts.join(", ");
                break;
            }
            default:
                value = "?";
        }

        return {
            key: field.key,
            off,
            abs,
            addr: "0x" + hex(abs, 4),
            name: field.name,
            label: field.label,
            meaning: field.meaning,
            value,
            raw,
            out,
            used
        };
    }

    function decode(bytes, base, kind) {
        const device = kind === "k5" ? "k5" : "k1";
        const blockBase = Number.isFinite(base) ? base : DEVICE_LABEL[device].base;
        const fields = FIELDS.map(field => decodeField(bytes, field, blockBase, device));
        const vol = bytes[0x18E];
        const dac = bytes[0x18F];

        return {
            base: blockBase,
            kind: device,
            device: DEVICE_LABEL[device],
            blank: isBlank(bytes),
            fields,
            afGain: afGain(vol, dac)
        };
    }

    // ---- 渲染 ---------------------------------------------------------------

    function escapeHtml(text) {
        return String(text == null ? "" : text).replace(/[&<>"']/g, character => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[character]);
    }

    function render(container, bytes, options) {
        if (!container) return;
        if (!bytes || bytes.length !== CALIB_SIZE) {
            container.hidden = true;
            container.innerHTML = "";
            return;
        }

        const opts = options || {};
        const t = opts.t || (key => key);
        const data = decode(bytes, opts.base, opts.kind);
        const end = data.base + CALIB_SIZE - 1;

        const rows = data.fields.map(field => {
            const classes = [
                field.out ? "is-out" : "",
                field.used ? "" : "is-muted"
            ].filter(Boolean).join(" ");
            return "<tr" + (classes ? ' class="' + classes + '"' : "") + ">" +
                '<td class="cf-addr">' + escapeHtml(field.addr) + "</td>" +
                '<td class="cf-field">' + escapeHtml(field.name) + "</td>" +
                '<td class="cf-label">' + escapeHtml(field.label) + "</td>" +
                '<td class="cf-value">' + escapeHtml(field.value) + "</td>" +
                '<td class="cf-mean">' + escapeHtml(field.meaning) +
                (field.used ? "" : "（本机不使用）") + "</td>" +
                "</tr>";
        }).join("");

        const note = t("calibBlockRange", "0x" + hex(data.base, 4), "0x" + hex(end, 4), data.device.name) +
            (data.device.physical != null
                ? " · " + t("calibBlockPhysical", "0x" + hex(data.device.physical, 6))
                : "");

        let total = "";
        if (data.afGain) {
            total = '<p class="calib-fields-total">' +
                escapeHtml(t("calibAfTotal", db(data.afGain.total), db(data.afGain.gain2), db(data.afGain.dac))) +
                "</p>";
        }

        container.innerHTML =
            '<p class="calib-fields-note">' + escapeHtml(note) + "</p>" +
            (data.blank ? '<p class="calib-fields-warn">' + escapeHtml(t("calibBlockBlank")) + "</p>" : "") +
            '<div class="slots-table-wrap"><table class="slots-table calib-fields-table">' +
            "<thead><tr>" +
            "<th>" + escapeHtml(t("calibColAddr")) + "</th>" +
            "<th>" + escapeHtml(t("calibColField")) + "</th>" +
            "<th>" + escapeHtml(t("calibColLabel")) + "</th>" +
            "<th>" + escapeHtml(t("calibColValue")) + "</th>" +
            "<th>" + escapeHtml(t("calibColMeaning")) + "</th>" +
            "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
            total;
        container.hidden = false;
    }

    return {
        CALIB_SIZE,
        FIELDS,
        DEVICE_LABEL,
        afGain,
        db,
        isBlank,
        decode,
        render
    };
});
