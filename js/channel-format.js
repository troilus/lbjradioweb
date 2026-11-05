// Channel-record codec for the LBJ/TDCS firmware's external flash.
//
// Layout (App/settings.c, App/radio.c):
//   0x000000 + n*16  16-byte channel record
//   0x004000 + n*16  10-byte GB2312 name (6 bytes padding)
//   0x008000 + n*2   2-byte attribute word
//
// The record is the same one SETTINGS_SaveChannel() writes:
//   u32 rxFreq @0, u32 txOffset @4, rxCode @8, txCode @9,
//   (txCodeType<<4)|rxCodeType @10, (modulation<<4)|direction @11,
//   flags @12, (pttId<<1)|dtmf @13, step @14, scrambling @15.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVTOOLS_CHANNEL_FORMAT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CHANNEL_COUNT = 1024;
  const RECORD_BASE = 0x000000;
  const NAME_BASE = 0x004000;
  const ATTR_BASE = 0x008000;
  const RECORD_SIZE = 16;
  const NAME_SIZE = 10;
  const NAME_BLOCK = 16;
  const ATTR_SIZE = 2;

  // Values match the firmware's MODULATION_* enum for the published LBJRadio
  // builds (BYP/RAW + LBJ + TDCS/KLW, no TCC).
  const MODULATIONS = [
    { value: 0, label: 'FM' },
    { value: 1, label: 'AM' },
    { value: 2, label: 'USB' },
    { value: 3, label: 'BYP' },
    { value: 4, label: 'RAW' },
    { value: 5, label: 'LBJ' },
    { value: 6, label: 'TDC' },
    { value: 7, label: 'KLW' }
  ];
  const MODULATION_LABELS = MODULATIONS.reduce((map, item) => {
    map[item.value] = item.label;
    return map;
  }, {});

  // gStepFrequencyTable order, kept identical to the firmware.
  const STEP_NAMES = [
    '2.5k', '5k', '6.25k', '10k', '12.5k', '25k', '8.33k', '0.01k',
    '0.05k', '0.1k', '0.25k', '0.5k', '1k', '1.25k', '9k', '15k',
    '20k', '30k', '50k', '100k', '125k', '200k', '250k', '500k'
  ];

  const POWER_NAMES = ['USER', 'LOW 1', 'LOW 2', 'LOW 3', 'LOW 4', 'LOW 5', 'MID', 'HIGH'];
  const DIRECTIONS = ['OFF', '+', '-'];
  const TONE_TYPES = ['OFF', 'CTCSS', 'DCS', 'DCS-R'];

  const CTCSS_VALS = [
    670, 693, 719, 744, 770, 797, 825, 854, 885, 915, 948, 974, 1000, 1035,
    1072, 1109, 1148, 1188, 1230, 1273, 1318, 1365, 1413, 1462, 1514, 1567,
    1598, 1622, 1655, 1679, 1713, 1738, 1773, 1799, 1835, 1862, 1899, 1928,
    1966, 1995, 2035, 2065, 2107, 2181, 2257, 2291, 2336, 2418, 2503, 2541
  ];

  const DCS_VALS = [
    0x0013, 0x0015, 0x0016, 0x0019, 0x001a, 0x001e, 0x0023, 0x0027, 0x0029,
    0x002b, 0x002c, 0x0035, 0x0039, 0x003a, 0x003b, 0x003c, 0x004c, 0x004d,
    0x004e, 0x0052, 0x0055, 0x0059, 0x005a, 0x005c, 0x0063, 0x0065, 0x006a,
    0x006d, 0x006e, 0x0072, 0x0075, 0x007a, 0x007c, 0x0085, 0x008a, 0x0093,
    0x0095, 0x0096, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a9, 0x00aa, 0x00ad,
    0x00b1, 0x00b3, 0x00b5, 0x00b6, 0x00b9, 0x00bc, 0x00c6, 0x00c9, 0x00cd,
    0x00d5, 0x00d9, 0x00da, 0x00e3, 0x00e6, 0x00e9, 0x00ee, 0x00f4, 0x00f5,
    0x00f9, 0x0109, 0x010a, 0x010b, 0x0113, 0x0119, 0x011a, 0x0125, 0x0126,
    0x012a, 0x012c, 0x012d, 0x0132, 0x0134, 0x0135, 0x0136, 0x0143, 0x0146,
    0x014e, 0x0153, 0x0156, 0x015a, 0x0166, 0x0175, 0x0186, 0x018a, 0x0194,
    0x0197, 0x0199, 0x019a, 0x01ac, 0x01b2, 0x01b4, 0x01c3, 0x01ca, 0x01d3,
    0x01d9, 0x01da, 0x01dc, 0x01e3, 0x01ec
  ];

  // Same order as FREQUENCY_GetBand(): BAND1_50MHz (0) .. BAND7_470MHz (6).
  function bandFromFrequency(freq) {
    if (freq >= 47000000) return 6;
    if (freq >= 40000000) return 5;
    if (freq >= 35000000) return 4;
    if (freq >= 17400000) return 3;
    if (freq >= 13700000) return 2;
    if (freq >= 10800000) return 1;
    return 0;
  }

  function isValid(channel) {
    return channel.rxFreq !== 0 && channel.rxFreq !== 0xFFFFFFFF;
  }

  function formatFrequency(freq) {
    if (freq === 0 || freq === 0xFFFFFFFF) return '-';
    return (freq / 100000).toFixed(5);
  }

  function parseFrequency(text) {
    const value = Math.round(parseFloat(String(text).replace(',', '.')) * 100000);
    if (!Number.isFinite(value) || value <= 0 || value > 0xFFFFFFFF) return null;
    return value;
  }

  function parseRecord(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      rxFreq: view.getUint32(0, true),
      txOffset: view.getUint32(4, true),
      rxCode: bytes[8],
      txCode: bytes[9],
      rxCodeType: bytes[10] & 0x0F,
      txCodeType: bytes[10] >> 4,
      modulation: bytes[11] >> 4,
      direction: bytes[11] & 0x0F,
      freqReverse: !!(bytes[12] & 1),
      bandwidth: (bytes[12] >> 1) & 1,
      outputPower: (bytes[12] >> 2) & 7,
      bcl: !!(bytes[12] & 0x20),
      txLock: !!(bytes[12] & 0x40),
      dtmfDecode: !!(bytes[13] & 1),
      pttIdMode: (bytes[13] >> 1) & 7,
      stepSetting: bytes[14],
      scrambling: bytes[15]
    };
  }

  function buildRecord(channel) {
    const bytes = new Uint8Array(RECORD_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, channel.rxFreq >>> 0, true);
    view.setUint32(4, channel.txOffset >>> 0, true);
    bytes[8] = channel.rxCode & 0xFF;
    bytes[9] = channel.txCode & 0xFF;
    bytes[10] = ((channel.txCodeType & 0x0F) << 4) | (channel.rxCodeType & 0x0F);
    bytes[11] = ((channel.modulation & 0x0F) << 4) | (channel.direction & 0x0F);
    bytes[12] = (channel.txLock ? 0x40 : 0)
      | (channel.bcl ? 0x20 : 0)
      | ((channel.outputPower & 7) << 2)
      | ((channel.bandwidth & 1) << 1)
      | (channel.freqReverse ? 1 : 0);
    bytes[13] = ((channel.pttIdMode & 7) << 1) | (channel.dtmfDecode ? 1 : 0);
    bytes[14] = channel.stepSetting & 0xFF;
    bytes[15] = channel.scrambling & 0xFF;
    return bytes;
  }

  function parseAttributes(bytes) {
    const value = bytes[0] | (bytes[1] << 8);
    return {
      band: value & 7,
      compander: (value >> 3) & 3,
      exclude: (value >> 7) & 1,
      scanlist: (value >> 8) & 0xFF
    };
  }

  function buildAttributeWord(channel, existing) {
    const band = bandFromFrequency(channel.rxFreq);
    const compander = channel.compander ?? ((existing >> 3) & 3);
    const exclude = channel.exclude ?? ((existing >> 7) & 1);
    const scanlist = channel.scanlist ?? ((existing >> 8) & 0xFF);
    return (band & 7)
      | ((compander & 3) << 3)
      | ((exclude & 1) << 7)
      | ((scanlist & 0xFF) << 8);
  }

  function decodeName(bytes) {
    let end = bytes.length;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) { end = i; break; }
    }
    try {
      return new TextDecoder('gbk').decode(bytes.subarray(0, end)).trimEnd();
    } catch (error) {
      return '';
    }
  }

  let gbkMap = null;

  // The browser can decode GBK but cannot encode it. Build a reverse map once
  // from TextDecoder('gbk'), restricted to the GB2312 range the firmware's
  // SETTINGS_FetchChannelName() understands (lead A1..F7, trail A1..FE).
  function getGbkMap() {
    if (gbkMap) return gbkMap;
    const decoder = new TextDecoder('gbk');
    const map = new Map();
    for (let lead = 0xA1; lead <= 0xF7; lead++) {
      for (let trail = 0xA1; trail <= 0xFE; trail++) {
        const text = decoder.decode(Uint8Array.of(lead, trail));
        if (text.length === 1 && text !== '\uFFFD' && !map.has(text)) {
          map.set(text, [lead, trail]);
        }
      }
    }
    gbkMap = map;
    return map;
  }

  function encodeName(text) {
    const value = String(text ?? '');
    const map = getGbkMap();
    const out = [];
    for (const character of value) {
      const code = character.codePointAt(0);
      if (code < 0x80) {
        if (code < 0x20 || code === 0x7F) throw new Error('control');
        out.push(code);
        continue;
      }
      const bytes = map.get(character);
      if (!bytes) throw new Error(`unsupported:${character}`);
      out.push(bytes[0], bytes[1]);
    }
    if (out.length > NAME_SIZE) throw new Error('too-long');
    const result = new Uint8Array(NAME_BLOCK);
    result.set(out);
    return result;
  }

  function parseChannel(index, recordBytes, nameBytes, attrBytes) {
    const channel = Object.assign({ num: index }, parseRecord(recordBytes));
    const attributes = parseAttributes(attrBytes);
    channel.name = decodeName(nameBytes.subarray(0, NAME_SIZE));
    channel._nameBytes = new Uint8Array(nameBytes.subarray(0, NAME_BLOCK));
    channel.band = attributes.band;
    channel.compander = attributes.compander;
    channel.exclude = attributes.exclude;
    channel.scanlist = attributes.scanlist;
    channel._modified = false;
    return channel;
  }

  function toneLabel(type, code) {
    if (type === 0 || code >= 0xFF) return '-';
    if (type === 1 && code < CTCSS_VALS.length) return (CTCSS_VALS[code] / 10).toFixed(1) + 'Hz';
    if (type >= 2 && code < DCS_VALS.length) return 'D' + DCS_VALS[code].toString(8).padStart(3, '0');
    return '?';
  }

  return {
    CHANNEL_COUNT,
    RECORD_BASE,
    NAME_BASE,
    ATTR_BASE,
    RECORD_SIZE,
    NAME_SIZE,
    NAME_BLOCK,
    ATTR_SIZE,
    MODULATIONS,
    MODULATION_LABELS,
    STEP_NAMES,
    POWER_NAMES,
    DIRECTIONS,
    TONE_TYPES,
    CTCSS_VALS,
    DCS_VALS,
    bandFromFrequency,
    isValid,
    formatFrequency,
    parseFrequency,
    parseRecord,
    buildRecord,
    parseAttributes,
    buildAttributeWord,
    decodeName,
    encodeName,
    parseChannel,
    toneLabel
  };
});
