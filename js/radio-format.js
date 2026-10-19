// Radio image formats shared by the firmware-slot and overlay-app pages.
//
// Pure module (no DOM), mirroring UV Studio's js/flash.js (flash.js?v=84) so the
// headers this page writes are byte-identical to the ones UV Studio writes and
// to the ones the firmware validates (App/app/multiboot.c, App/app/overlay*.c).
//
// Layouts:
//   mb_slot_header_t (64 B): magic@0 hdrVersion@4 flags@6 imageSize@8 imageCrc32@12
//                            name@16[16] fwVersion@32[16]
//   app_header_t     (64 B): magic@0 hdrVersion@4 abiVersion@6 codeSize@8
//                            codeCrc32@12 entry@16 flags@18 name@20[16]
//                            version@36[16] linkVma@52 caps@56 assetSize@60
//                            assetCrc32@62
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVTOOLS_RADIO_FORMAT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Firmware slots (multiboot) — external flash, 128 KiB per slot.
  // ---------------------------------------------------------------------------

  const SLOT_FIRST = 1;              // slot 0 is the firmware-managed base backup
  const SLOT_COUNT = 4;              // user slots 1..4
  const SLOT_END = SLOT_FIRST + SLOT_COUNT;
  const SLOT_IMG_OFFSET = 0x1000;    // image starts after the header sector
  const SLOT_IMG_MAX = 0x1D800;      // 118 KiB application region
  const SLOT_HDR_SIZE = 64;
  const SLOT_WRITE_CHUNK = 128;      // keep the whole VCP command under 256 B
  const SLOT_MAGIC = 0x31424D46;     // "FMB1" little-endian
  const SLOT_HDR_VERSION = 1;
  const SLOT_FLAG_COMMITTED = 1;

  // MB_ERR_* (0..8) -> locale keys.
  const SLOT_STATUS_KEYS = [
    'slotStateValid', 'slotStateEmpty', 'slotStateNewHdr', 'slotStateIncomplete',
    'slotStateBadSize', 'slotStateCrc', 'slotStateSpi', 'slotStateBadSlot',
    'slotStateAuth'
  ];

  // ---------------------------------------------------------------------------
  // Overlay apps — external flash, 8 KiB per slot.
  // ---------------------------------------------------------------------------

  const APP_SLOT_FIRST = 0;
  const APP_SLOT_COUNT = 48;         // v6.2.0+ capacity
  const APP_LEGACY_SLOT_COUNT = 16;  // through v6.1.0
  const APP_SLOT_STRIDE = 0x2000;
  const APP_HDR_SIZE = 64;
  const APP_IMG_OFFSET = 0x1000;     // code sector
  const APP_ASSET_OFFSET = 0x100;    // assets live in the header sector
  const APP_ASSET_MAX = 0xF00;       // up to the end of the header sector
  const APP_CODE_MAX = 0x1000;       // one code sector
  const APP_WRITE_CHUNK = 128;
  const APP_MAGIC = 0x31504146;      // "FAP1" little-endian
  const APP_FLAG_COMMITTED = 1;

  // APP_ERR_* (0..9) -> locale keys.
  const APP_STATUS_KEYS = [
    'appStateValid', 'appStateBadSlot', 'appStateEmpty', 'appStateAbi',
    'appStateIncomplete', 'appStateBadSize', 'appStateCrc', 'appStateVma',
    'appStateAuth', 'appStateCap'
  ];
  // ABI / capability refusals mean "installed but this firmware cannot launch it".
  const APP_STATUS_INCOMPATIBLE = new Set([3, 9]);

  // ---------------------------------------------------------------------------
  // CRC-32 (zlib/PNG, poly 0xEDB88320) — must match the firmware mb_crc32_update.
  // ---------------------------------------------------------------------------

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function readAscii(bytes, offset, length) {
    let text = '';
    for (let i = 0; i < length; i++) {
      const code = bytes[offset + i];
      if (!code) break;
      text += String.fromCharCode(code);
    }
    return text;
  }

  function writeAscii(target, offset, length, value) {
    const text = String(value || '');
    for (let i = 0; i < length; i++) {
      target[offset + i] = i < text.length ? (text.charCodeAt(i) & 0x7F) : 0;
    }
  }

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function statusKey(keys, code) {
    return keys[code] || 'slotStateError';
  }

  // ---------------------------------------------------------------------------
  // Firmware-slot headers
  // ---------------------------------------------------------------------------

  function buildSlotHeader(imageSize, crc, meta) {
    const header = new Uint8Array(SLOT_HDR_SIZE);
    const view = viewOf(header);
    view.setUint32(0, SLOT_MAGIC, true);
    view.setUint16(4, SLOT_HDR_VERSION, true);
    view.setUint16(6, SLOT_FLAG_COMMITTED, true);
    view.setUint32(8, imageSize, true);
    view.setUint32(12, crc >>> 0, true);
    writeAscii(header, 16, 16, (meta && meta.name) || '');
    writeAscii(header, 32, 16, (meta && meta.fwVersion) || '');
    return header;
  }

  function parseSlotHeader(bytes) {
    if (!bytes || bytes.length < SLOT_HDR_SIZE) return null;
    const view = viewOf(bytes);
    return {
      magic: view.getUint32(0, true),
      hdrVersion: view.getUint16(4, true),
      flags: view.getUint16(6, true),
      imageSize: view.getUint32(8, true),
      imageCrc32: view.getUint32(12, true) >>> 0,
      name: readAscii(bytes, 16, 16),
      fwVersion: readAscii(bytes, 32, 16)
    };
  }

  // 0x0721 reply: slot, status, then the 64-byte header.
  function parseSlotInfo(data) {
    if (!data || data.length < 2) return null;
    return {
      slot: data[0],
      status: data[1],
      header: parseSlotHeader(data.subarray(2, 2 + SLOT_HDR_SIZE))
    };
  }

  // 0x0727 reply: crc32(4), slot, status.
  function parseSlotValidate(data) {
    if (!data || data.length < 6) return null;
    return {
      crc: viewOf(data).getUint32(0, true) >>> 0,
      slot: data[4],
      status: data[5]
    };
  }

  // The multiboot font/header is ASCII-only and reserves one byte for NUL.
  function normalizeSlotName(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 15);
  }

  // Canonical archive names look like "LBJRADIO.v5.5.0.bin" or
  // "f4hwn.fusion.v5.5.0.bin"; keep the leading token as the edition label.
  function deriveSlotMeta(bytes, filename) {
    const stem = String(filename || '').replace(/\.bin$/i, '');
    const versionMatch = stem.match(/[._-]v(\d+(?:\.\d+)*)$/i);
    let name = versionMatch ? stem.slice(0, versionMatch.index) : stem;
    name = name.replace(/^f4hwn[._-]/i, '').replace(/[._-]+/g, ' ').trim();
    let fwVersion = versionMatch ? `v${versionMatch[1]}` : '';

    // Fall back to an embedded "AUTHOR vX.Y.Z" banner when the filename has none.
    if (!fwVersion && bytes && bytes.length) {
      let text = '';
      for (let i = 0; i < bytes.length; i++) {
        const code = bytes[i];
        text += (code >= 32 && code < 127) ? String.fromCharCode(code) : '\n';
      }
      const embedded = text.match(/[A-Za-z0-9]+ (v\d+(?:\.\d+)*)/i);
      if (embedded) fwVersion = embedded[1];
    }

    return {
      name: normalizeSlotName(name).slice(0, 15),
      fwVersion: String(fwVersion).slice(0, 15)
    };
  }

  // ---------------------------------------------------------------------------
  // Overlay-app headers
  // ---------------------------------------------------------------------------

  function parseAppHeader(bytes) {
    if (!bytes || bytes.length < APP_HDR_SIZE) return null;
    const view = viewOf(bytes);
    return {
      magic: view.getUint32(0, true),
      hdrVersion: view.getUint16(4, true),
      abiVersion: view.getUint16(6, true),
      codeSize: view.getUint32(8, true),
      codeCrc32: view.getUint32(12, true) >>> 0,
      entry: view.getUint32(16, true) >>> 0,
      flags: view.getUint16(18, true),
      name: readAscii(bytes, 20, 16),
      version: readAscii(bytes, 36, 16),
      linkVma: view.getUint32(52, true) >>> 0,
      caps: view.getUint32(56, true) >>> 0,
      assetSize: view.getUint16(60, true),
      assetCrc32: view.getUint16(62, true) >>> 0
    };
  }

  // 0x0731 reply: slot, status, then the 64-byte header.
  function parseAppInfo(data) {
    if (!data || data.length < 2) return null;
    return {
      slot: data[0],
      status: data[1],
      header: parseAppHeader(data.subarray(2, 2 + APP_HDR_SIZE))
    };
  }

  // 0x0737 reply: slot, status.
  function parseAppValidate(data) {
    if (!data || data.length < 2) return null;
    return { slot: data[0], status: data[1] };
  }

  // Split a .app file into the three parts the firmware expects, checking every
  // length against the header. Returns { header, code, assets } or
  // { error: 'appBadFile' | 'appTooBig' }.
  function splitAppImage(bytes) {
    const header = parseAppHeader(bytes);
    if (!header || header.magic !== APP_MAGIC) return { error: 'appBadFile' };
    const codeEnd = APP_HDR_SIZE + header.codeSize;
    if (!header.codeSize || codeEnd > bytes.length) return { error: 'appBadFile' };
    const code = bytes.subarray(APP_HDR_SIZE, codeEnd);
    const assets = bytes.subarray(codeEnd);
    if (assets.length !== header.assetSize) return { error: 'appBadFile' };
    if (code.length > APP_CODE_MAX || assets.length > APP_ASSET_MAX) {
      return { error: 'appTooBig' };
    }
    return {
      header: bytes.subarray(0, APP_HDR_SIZE),
      code,
      assets
    };
  }

  // ---------------------------------------------------------------------------
  // Version helpers
  // ---------------------------------------------------------------------------

  function versionParts(value) {
    const match = String(value || '').trim().match(/^v?(\d+(?:\.\d+)*)(?:[-_]?([a-z][0-9a-z.-]*))?$/i);
    if (!match) return null;
    return {
      numbers: match[1].split('.').map(Number),
      suffix: (match[2] || '').toLowerCase()
    };
  }

  // Negative when `a` is older than `b`, 0 when equal, null when unparseable.
  function compareVersions(a, b) {
    const left = versionParts(a);
    const right = versionParts(b);
    if (!left || !right) return null;
    const length = Math.max(left.numbers.length, right.numbers.length);
    for (let i = 0; i < length; i++) {
      const delta = (left.numbers[i] || 0) - (right.numbers[i] || 0);
      if (delta) return delta;
    }
    if (left.suffix === right.suffix) return 0;
    if (!left.suffix) return 1;
    if (!right.suffix) return -1;
    return left.suffix.localeCompare(right.suffix, undefined, { numeric: true });
  }

  // Descending sort helper for a list of { version } entries.
  function compareVersionDesc(a, b) {
    const delta = compareVersions(a && a.version, b && b.version);
    return delta === null ? 0 : -delta;
  }

  // "LBJRADIO v5.5.0" -> "5.5.0.0"? Keep three components, as the firmware
  // version gate compares against 6.1.0.
  function firmwareVersionFromName(name) {
    const match = String(name || '').match(/\bv?(\d+(?:\.\d+){1,2})\b/i);
    if (!match) return '';
    return match[1].split('.').concat('0', '0').slice(0, 3).join('.');
  }

  function appSlotCountForFirmware(name) {
    const version = firmwareVersionFromName(name);
    return version && compareVersions(version, '6.1.0') > 0
      ? APP_SLOT_COUNT
      : APP_LEGACY_SLOT_COUNT;
  }

  function isBootloaderCompatible(version, minimum) {
    const parse = value => {
      const parts = String(value || '').split('.').map(part => parseInt(part, 10) || 0);
      while (parts.length < 3) parts.push(0);
      return parts;
    };
    const current = parse(version);
    const required = parse(minimum);
    for (let i = 0; i < 3; i++) {
      if (current[i] > required[i]) return true;
      if (current[i] < required[i]) return false;
    }
    return true;
  }

  function formatBytes(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${value} B`;
    return `${Math.round(value / 1024)} KB`;
  }

  function formatHex(value, width) {
    return '0x' + (Number(value) >>> 0).toString(16).toUpperCase().padStart(width || 6, '0');
  }

  return {
    // slots
    SLOT_FIRST, SLOT_COUNT, SLOT_END, SLOT_IMG_OFFSET, SLOT_IMG_MAX,
    SLOT_HDR_SIZE, SLOT_WRITE_CHUNK, SLOT_MAGIC, SLOT_HDR_VERSION,
    SLOT_FLAG_COMMITTED, SLOT_STATUS_KEYS,
    buildSlotHeader, parseSlotHeader, parseSlotInfo, parseSlotValidate,
    normalizeSlotName, deriveSlotMeta,
    // apps
    APP_SLOT_FIRST, APP_SLOT_COUNT, APP_LEGACY_SLOT_COUNT, APP_SLOT_STRIDE,
    APP_HDR_SIZE, APP_IMG_OFFSET, APP_ASSET_OFFSET, APP_ASSET_MAX, APP_CODE_MAX,
    APP_WRITE_CHUNK, APP_MAGIC, APP_FLAG_COMMITTED, APP_STATUS_KEYS,
    APP_STATUS_INCOMPATIBLE,
    parseAppHeader, parseAppInfo, parseAppValidate, splitAppImage,
    // versions & formatting
    compareVersions, compareVersionDesc, firmwareVersionFromName,
    appSlotCountForFirmware, isBootloaderCompatible, formatBytes, formatHex,
    statusKey,
    crc32
  };
});
