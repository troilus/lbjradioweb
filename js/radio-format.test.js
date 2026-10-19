// Unit tests for the FMB1/FAP1 image formats. Run: node --test js/radio-format.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const format = require('./radio-format.js');

test('crc32 matches the standard zlib vector', () => {
  // The firmware uses the same reflected poly 0xEDB88320 as zlib/PNG.
  assert.equal(format.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(format.crc32(new Uint8Array(0)), 0);
});

test('buildSlotHeader round-trips through parseSlotHeader', () => {
  const image = new Uint8Array([1, 2, 3, 4, 5]);
  const crc = format.crc32(image);
  const header = format.buildSlotHeader(image.length, crc, {
    name: 'LBJRADIO', fwVersion: 'v5.5.0'
  });

  assert.equal(header.length, format.SLOT_HDR_SIZE);
  const parsed = format.parseSlotHeader(header);
  assert.equal(parsed.magic, format.SLOT_MAGIC);
  assert.equal(parsed.hdrVersion, 1);
  assert.equal(parsed.flags, format.SLOT_FLAG_COMMITTED);
  assert.equal(parsed.imageSize, 5);
  assert.equal(parsed.imageCrc32, crc);
  assert.equal(parsed.name, 'LBJRADIO');
  assert.equal(parsed.fwVersion, 'v5.5.0');
});

test('buildSlotHeader fills the fixed 16-byte metadata fields', () => {
  const header = format.buildSlotHeader(1, 0, {
    name: 'a-very-long-edition-name', fwVersion: 'v123.456.789'
  });
  const parsed = format.parseSlotHeader(header);
  assert.equal(parsed.name, 'a-very-long-edit');
  assert.equal(parsed.fwVersion, 'v123.456.789');
});

test('parseSlotInfo and parseSlotValidate decode 0x0721 / 0x0727 replies', () => {
  const header = format.buildSlotHeader(1024, 0xDEADBEEF, {
    name: 'FUSION', fwVersion: 'v5.5.0'
  });
  const info = new Uint8Array(2 + header.length);
  info[0] = 3;
  info[1] = 0;
  info.set(header, 2);

  const parsed = format.parseSlotInfo(info);
  assert.equal(parsed.slot, 3);
  assert.equal(parsed.status, 0);
  assert.equal(parsed.header.name, 'FUSION');

  const validate = new Uint8Array([0xEF, 0xBE, 0xAD, 0xDE, 3, 0]);
  const verdict = format.parseSlotValidate(validate);
  assert.equal(verdict.crc, 0xDEADBEEF);
  assert.equal(verdict.slot, 3);
  assert.equal(verdict.status, 0);
});

test('normalizeSlotName keeps printable ASCII and 15 characters', () => {
  assert.equal(format.normalizeSlotName('  LBJ   Radio  '), 'LBJ Radio');
  assert.equal(format.normalizeSlotName('中文名称'), '');
  assert.equal(format.normalizeSlotName('abc\u0000def'), 'abcdef');
  assert.equal(format.normalizeSlotName('12345678901234567890'), '123456789012345');
});

test('deriveSlotMeta reads the archive naming convention', () => {
  assert.deepEqual(format.deriveSlotMeta(null, 'LBJRADIO.v5.5.0.bin'), {
    name: 'LBJRADIO', fwVersion: 'v5.5.0'
  });
  assert.deepEqual(format.deriveSlotMeta(null, 'f4hwn.fusion.v5.5.0.bin'), {
    name: 'fusion', fwVersion: 'v5.5.0'
  });
  assert.deepEqual(format.deriveSlotMeta(null, 'plain.bin'), {
    name: 'plain', fwVersion: ''
  });
});

test('deriveSlotMeta falls back to the embedded banner', () => {
  const image = new Uint8Array(64);
  const banner = new TextEncoder().encode('\u0000LBJRADIO v5.5.0\u0000');
  image.set(banner, 8);
  assert.equal(format.deriveSlotMeta(image, 'firmware.bin').fwVersion, 'v5.5.0');
});

test('parseAppHeader decodes the LBJRX fixture', () => {
  const file = path.join(__dirname, '..', 'test-fixtures', 'LBJRX.app');
  if (!fs.existsSync(file)) {
    // Fixture is optional in the repo; the synthetic header test below still
    // covers the layout.
    return;
  }
  const header = format.parseAppHeader(new Uint8Array(fs.readFileSync(file)));
  assert.equal(header.magic, format.APP_MAGIC);
  assert.equal(header.abiVersion, 513);
  assert.equal(header.name, 'LBJ RX');
  assert.equal(header.version, '0.4');
  assert.equal(header.codeSize, 0x0FC0);
  assert.equal(header.assetSize, 1962);
  assert.equal(header.linkVma, 0x20000280);
  assert.equal(header.codeCrc32, 0x87DE74BE);
});

test('splitAppImage separates code and assets and validates sizes', () => {
  const code = new Uint8Array(16).fill(0xAA);
  const assets = new Uint8Array(8).fill(0x55);
  const file = new Uint8Array(format.APP_HDR_SIZE + code.length + assets.length);
  const view = new DataView(file.buffer);
  view.setUint32(0, format.APP_MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 513, true);
  view.setUint32(8, code.length, true);
  view.setUint32(12, format.crc32(code), true);
  view.setUint32(16, 0x00010000, true);
  view.setUint16(18, 1, true);
  view.setUint32(52, 0x20000280, true);
  view.setUint16(60, assets.length, true);
  file.set(code, format.APP_HDR_SIZE);
  file.set(assets, format.APP_HDR_SIZE + code.length);

  const parts = format.splitAppImage(file);
  assert.equal(parts.error, undefined);
  assert.equal(parts.header.length, format.APP_HDR_SIZE);
  assert.deepEqual(Array.from(parts.code), Array.from(code));
  assert.deepEqual(Array.from(parts.assets), Array.from(assets));

  assert.equal(format.splitAppImage(new Uint8Array(8)).error, 'appBadFile');
});

test('splitAppImage rejects an image that does not fit a slot', () => {
  const file = new Uint8Array(format.APP_HDR_SIZE + format.APP_CODE_MAX + 1);
  const view = new DataView(file.buffer);
  view.setUint32(0, format.APP_MAGIC, true);
  view.setUint32(8, format.APP_CODE_MAX + 1, true);
  view.setUint16(60, 0, true);
  assert.equal(format.splitAppImage(file).error, 'appTooBig');
});

test('parseAppInfo and parseAppValidate decode 0x0731 / 0x0737 replies', () => {
  const header = new Uint8Array(format.APP_HDR_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, format.APP_MAGIC, true);
  view.setUint16(6, 513, true);
  view.setUint32(8, 64, true);
  header.set(new TextEncoder().encode('LBJ RX'), 20);
  header.set(new TextEncoder().encode('0.4'), 36);

  const reply = new Uint8Array(2 + header.length);
  reply[0] = 5;
  reply[1] = 0;
  reply.set(header, 2);

  const info = format.parseAppInfo(reply);
  assert.equal(info.slot, 5);
  assert.equal(info.status, 0);
  assert.equal(info.header.name, 'LBJ RX');

  const verdict = format.parseAppValidate(new Uint8Array([5, 3]));
  assert.equal(verdict.slot, 5);
  assert.equal(verdict.status, 3);
});

test('statusKey maps codes to locale keys and falls back safely', () => {
  assert.equal(format.statusKey(format.SLOT_STATUS_KEYS, 0), 'slotStateValid');
  assert.equal(format.statusKey(format.SLOT_STATUS_KEYS, 8), 'slotStateAuth');
  assert.equal(format.statusKey(format.SLOT_STATUS_KEYS, 99), 'slotStateError');
  assert.equal(format.statusKey(format.APP_STATUS_KEYS, 1), 'appStateBadSlot');
  assert.equal(format.statusKey(format.APP_STATUS_KEYS, 9), 'appStateCap');
  assert.equal(format.statusKey(format.APP_STATUS_KEYS, 42), 'slotStateError');
  assert.ok(format.APP_STATUS_INCOMPATIBLE.has(3));
  assert.ok(format.APP_STATUS_INCOMPATIBLE.has(9));
  assert.ok(!format.APP_STATUS_INCOMPATIBLE.has(0));
});

test('compareVersions orders numerically and tolerates suffixes', () => {
  assert.ok(format.compareVersions('5.5.0', '5.10.0') < 0);
  assert.ok(format.compareVersions('6.2.0', '6.1.0') > 0);
  assert.equal(format.compareVersions('5.5', '5.5.0'), 0);
  assert.ok(format.compareVersions('5.5.0-beta', '5.5.0') < 0);
  assert.equal(format.compareVersions('0.4', 'nonsense'), null);

  const list = [{ version: '5.4.0' }, { version: '5.10.0' }, { version: '5.5.0' }];
  list.sort(format.compareVersionDesc);
  assert.deepEqual(list.map(item => item.version), ['5.10.0', '5.5.0', '5.4.0']);
});

test('appSlotCountForFirmware follows the 6.1.0 boundary', () => {
  assert.equal(format.appSlotCountForFirmware('LBJRADIO v5.5.0'), 16);
  assert.equal(format.appSlotCountForFirmware('F4HWN Fusion v6.1.0'), 16);
  assert.equal(format.appSlotCountForFirmware('F4HWN Fusion v6.2.0'), 48);
  assert.equal(format.appSlotCountForFirmware('unknown'), 16);
});

test('isBootloaderCompatible compares dotted versions', () => {
  assert.equal(format.isBootloaderCompatible('7.00.07', '7.00.07'), true);
  assert.equal(format.isBootloaderCompatible('7.00.08', '7.00.07'), true);
  assert.equal(format.isBootloaderCompatible('7.1.0', '7.00.07'), true);
  assert.equal(format.isBootloaderCompatible('7.00.06', '7.00.07'), false);
  assert.equal(format.isBootloaderCompatible('6.99.99', '7.00.07'), false);
});

test('formatBytes and formatHex are display-only helpers', () => {
  assert.equal(format.formatBytes(512), '512 B');
  assert.equal(format.formatBytes(105756), '103 KB');
  assert.equal(format.formatBytes(-1), '—');
  assert.equal(format.formatBytes('x'), '—');
  assert.equal(format.formatHex(0x1000), '0x001000');
});
