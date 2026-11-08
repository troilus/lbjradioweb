// Unit tests for the legacy V1 flash page builder. Run: node --test js/k5-flash.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSerial() {
  const sandbox = {
    window: { addEventListener() {}, dispatchEvent() {}, UVStudioSerial: null },
    console,
    Uint8Array,
    DataView,
    TextEncoder,
    TextDecoder,
    CustomEvent: class {},
    navigator: {},
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'serial.js'), 'utf8'), sandbox);
  return sandbox.window.LBJSerial;
}

const serial = loadSerial();

test('legacy V1 constants match k5prog', () => {
  assert.equal(serial.LEGACY_PAGE_SIZE, 0x100);
  assert.equal(serial.LEGACY_MAX_IMAGE, 0xF000);
  assert.equal(serial.LEGACY_VERSION_WILDCARD, '*.01.23');
});

test('buildLegacyFlashPage uses the k5prog 0x0519 layout', () => {
  const image = new Uint8Array(0x210);
  image.fill(0xAA);

  const page0 = serial.buildLegacyFlashPage(image, 0, 3);
  assert.equal(page0.length, 268);
  assert.deepEqual(Array.from(page0.slice(0, 4)), [0x8a, 0x8d, 0x9f, 0x1d]);
  assert.equal(page0[4], 0);   // address high
  assert.equal(page0[5], 0);   // address low
  assert.equal(page0[6], 3);   // final address high (page count)
  assert.equal(page0[7], 0);   // final address low
  assert.equal(page0[8], 0);   // length low (0x0100)
  assert.equal(page0[9], 1);   // length high
  assert.equal(page0[10], 0);
  assert.equal(page0[11], 0);
  assert.equal(page0[12], 0xAA);
  assert.equal(page0[267], 0xAA);
});

test('buildLegacyFlashPage zero-pads the last partial page', () => {
  const image = new Uint8Array(0x210);
  image.fill(0xAA);

  const last = serial.buildLegacyFlashPage(image, 2, 3);
  assert.equal(last[4], 2);
  assert.equal(last[5], 0);
  assert.equal(last[8], 0x10);
  assert.equal(last[9], 0);
  assert.equal(last[12], 0xAA);
  assert.equal(last[12 + 0x0f], 0xAA);
  assert.equal(last[12 + 0x10], 0);
  assert.equal(last[267], 0);
});
