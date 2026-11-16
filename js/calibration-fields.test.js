// Unit tests for the calibration block decoder. Run: node --test js/calibration-fields.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFields() {
  const sandbox = { console, Uint8Array };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'calibration-fields.js'), 'utf8'), sandbox);
  return sandbox.UVTOOLS_CALIB_FIELDS;
}

const fields = loadFields();

// A block shaped like the K1 measured on the bench: xtal blank, misc = 55/14.
function k1Block() {
  const bytes = new Uint8Array(512).fill(0xFF);
  const u16 = (off, value) => {
    bytes[off] = value & 0xFF;
    bytes[off + 1] = (value >> 8) & 0xFF;
  };
  // battery calibration (6 x u16)
  [1900, 2000, 2100, 2200, 2250, 2300].forEach((v, i) => u16(0x140 + i * 2, v));
  // vox thresholds (10 x u16 each)
  for (let i = 0; i < 10; i++) {
    u16(0x150 + i * 2, 100 + i);
    u16(0x168 + i * 2, 200 + i);
  }
  // mic levels
  [8, 14, 19, 24, 30].forEach((v, i) => { bytes[0x180 + i] = v; });
  // misc: xtal 0xFFFF, 1F8A, 1F8C, volume 55, dac 14
  bytes[0x188] = 0xFF;
  bytes[0x189] = 0xFF;
  u16(0x18A, 0x0046);
  u16(0x18C, 0x0050);
  bytes[0x18E] = 55;
  bytes[0x18F] = 14;
  return bytes;
}

function byKey(decoded, key) {
  return decoded.fields.find(field => field.key === key);
}

test('AF gain follows REG_48: 0.5 dB per step on gain-2, 2 dB on the DAC', () => {
  const gain = fields.afGain(55, 14);
  assert.equal(gain.volumeGain, 55);
  assert.equal(gain.dacGain, 14);
  assert.equal(gain.gain2, 1.5);
  assert.equal(gain.dac, 28);
  assert.equal(gain.total, 29.5);
  assert.equal(fields.afGain(58, 8).total, 19);
  assert.equal(fields.afGain(44, 14).total, 24);
  assert.equal(fields.afGain(0, 0).total, -26);
  assert.equal(fields.afGain(63, 15).total, 35.5);
});

test('out-of-range gain fields decode to null instead of a bogus dB value', () => {
  assert.equal(fields.afGain(64, 8), null);
  assert.equal(fields.afGain(58, 16), null);
  assert.equal(fields.afGain(0xFF, 0xFF), null);
});

test('dB formatting keeps the sign and one decimal', () => {
  assert.equal(fields.db(29.5), '+29.5 dB');
  assert.equal(fields.db(19), '+19.0 dB');
  assert.equal(fields.db(-4), '-4.0 dB');
  assert.equal(fields.db(0), '0.0 dB');
});

test('a K1 block decodes the measured values', () => {
  const decoded = fields.decode(k1Block(), 0xB000, 'k1');
  assert.equal(decoded.blank, false);
  assert.equal(decoded.base, 0xB000);

  const xtal = byKey(decoded, 'xtalFreqLow');
  assert.equal(xtal.abs, 0xB188);
  assert.match(xtal.value, /未校准/);

  const vol = byKey(decoded, 'volumeGain');
  assert.equal(vol.abs, 0xB18E);
  assert.equal(vol.value, '55（0x37） → +1.5 dB');

  const dac = byKey(decoded, 'dacGain');
  assert.equal(dac.value, '14（0x0E） → +28.0 dB');

  assert.equal(decoded.afGain.total, 29.5);
  assert.equal(byKey(decoded, 'micLevel').value, '8, 14, 19, 24, 30');
  assert.equal(byKey(decoded, 'batteryCal').value, '1900, 2000, 2100, 2200, 2250, 2300');
  assert.equal(byKey(decoded, 'vox0Thr').value.startsWith('200, 201'), true);
});

test('the K5 block is decoded at 0x1E00 and keeps the settings-bits row', () => {
  const decoded = fields.decode(k1Block(), 0x1E00, 'k5');
  assert.equal(byKey(decoded, 'volumeGain').abs, 0x1F8E);
  assert.equal(byKey(decoded, 'stateBits').used, true);
  assert.equal(fields.decode(k1Block(), 0xB000, 'k1').fields.find(f => f.key === 'stateBits').used, false);
});

test('an all-FF block is reported blank and its arrays stay empty', () => {
  const blank = new Uint8Array(512).fill(0xFF);
  const decoded = fields.decode(blank, 0xB000, 'k1');
  assert.equal(decoded.blank, true);
  assert.equal(fields.isBlank(blank), true);
  assert.equal(byKey(decoded, 'micLevel').value, '（空）');
  assert.equal(byKey(decoded, 'batteryCal').value, '（空）');
  // 55/14 is not what a blank block says: FF/FF is out of range.
  assert.equal(decoded.afGain, null);
});

test('a K5 block with 44/14 gives the factory K5 gain', () => {
  const bytes = k1Block();
  bytes[0x188] = 0x04;
  bytes[0x189] = 0x00;
  bytes[0x18E] = 44;
  bytes[0x18F] = 14;
  const decoded = fields.decode(bytes, 0x1E00, 'k5');
  assert.equal(decoded.afGain.total, 24);
  assert.equal(byKey(decoded, 'xtalFreqLow').value, '4（0x0004）');
});

test('decode defaults to the device base when none is passed', () => {
  assert.equal(fields.decode(k1Block(), undefined, 'k1').base, 0xB000);
  assert.equal(fields.decode(k1Block(), undefined, 'k5').base, 0x1E00);
});

test('render fills the container with the field table', () => {
  const element = { hidden: true, innerHTML: "" };
  const t = (key, ...values) => [key, ...values].join(" ");
  fields.render(element, k1Block(), { base: 0xB000, kind: "k1", t });
  assert.equal(element.hidden, false);
  assert.match(element.innerHTML, /calib-fields-table/);
  assert.match(element.innerHTML, /0xB18E/);
  assert.match(element.innerHTML, /55（0x37）/);
  assert.match(element.innerHTML, /calibAfTotal \+29\.5 dB/);
  assert.doesNotMatch(element.innerHTML, /calib-fields-warn/);
});

test('render hides itself for a missing or wrong-sized buffer', () => {
  const element = { hidden: false, innerHTML: "stale" };
  fields.render(element, null, {});
  assert.equal(element.hidden, true);
  assert.equal(element.innerHTML, "");
  element.hidden = false;
  fields.render(element, new Uint8Array(16), {});
  assert.equal(element.hidden, true);
});
