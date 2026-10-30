// Unit tests for the calibration helpers. Run: node --test js/calibration.test.js
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

test('calibration constants match UV Studio', () => {
  assert.equal(serial.CALIB_SIZE, 512);
  assert.equal(serial.CALIB_CHUNK, 16);
  assert.equal(serial.MSG_READ_EEPROM, 0x051B);
  assert.equal(serial.MSG_READ_EEPROM_RESP, 0x051C);
  assert.equal(serial.MSG_WRITE_EEPROM, 0x051D);
  assert.equal(serial.MSG_WRITE_EEPROM_RESP, 0x051E);
});

test('calibrationOffset uses 0xB000 from firmware v5 on', () => {
  assert.equal(serial.calibrationOffset('F4HWN v5.5.0'), 0xB000);
  assert.equal(serial.calibrationOffset('LBJRADIO v50'), 0xB000);
  assert.equal(serial.calibrationOffset('Radio v5'), 0xB000);
});

test('calibrationOffset keeps 0x1E00 for older or unknown firmware', () => {
  assert.equal(serial.calibrationOffset('F4HWN v4.3.0'), 0x1E00);
  assert.equal(serial.calibrationOffset('v1.2'), 0x1E00);
  assert.equal(serial.calibrationOffset('LBJRADIO'), 0x1E00);
  assert.equal(serial.calibrationOffset(''), 0x1E00);
  assert.equal(serial.calibrationOffset(undefined), 0x1E00);
});
