const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./channel-format.js');

function hasGbkDecoder() {
  try {
    new TextDecoder('gbk');
    return true;
  } catch (error) {
    return false;
  }
}

test('bandFromFrequency follows FREQUENCY_GetBand', () => {
  assert.equal(F.bandFromFrequency(1800000), 0);
  assert.equal(F.bandFromFrequency(10800000), 1);
  assert.equal(F.bandFromFrequency(14550000), 2);
  assert.equal(F.bandFromFrequency(43350000), 5);
  assert.equal(F.bandFromFrequency(45755000), 5);
  assert.equal(F.bandFromFrequency(82123750), 6);
});

test('frequency parsing and formatting use 10 Hz units', () => {
  assert.equal(F.parseFrequency('145.50000'), 14550000);
  assert.equal(F.parseFrequency('821,23750'), 82123750);
  assert.equal(F.parseFrequency('0'), null);
  assert.equal(F.parseFrequency('1.0'), null);
  assert.equal(F.parseFrequency('abc'), null);
  assert.equal(F.parseFrequency('1300.00000'), 130000000);
  assert.equal(F.parseFrequency('1300.00001'), null);
  assert.equal(F.formatFrequency(82123750), '821.23750');
  assert.equal(F.formatFrequency(0), '-');
  assert.equal(F.formatFrequency(0xFFFFFFFF), '-');
});

test('channel record round-trips through buildRecord/parseRecord', () => {
  const channel = {
    rxFreq: 43350000,
    txOffset: 50000,
    rxCode: 12,
    txCode: 3,
    rxCodeType: 1,
    txCodeType: 2,
    modulation: 5,
    direction: 1,
    freqReverse: true,
    bandwidth: 1,
    outputPower: 6,
    bcl: true,
    txLock: true,
    dtmfDecode: false,
    pttIdMode: 2,
    stepSetting: 4,
    scrambling: 0
  };
  const parsed = F.parseRecord(F.buildRecord(channel));
  for (const key of Object.keys(channel)) {
    assert.equal(parsed[key], channel[key], key);
  }
});

test('attribute word keeps band, compander, exclude and scanlist', () => {
  const word = 5 | (2 << 3) | (1 << 7) | (3 << 8);
  assert.deepEqual(F.parseAttributes(Uint8Array.of(word & 0xFF, word >> 8)), {
    band: 5,
    compander: 2,
    exclude: 1,
    scanlist: 3
  });

  const rebuilt = F.buildAttributeWord({ rxFreq: 43350000 }, word);
  assert.deepEqual(F.parseAttributes(Uint8Array.of(rebuilt & 0xFF, rebuilt >> 8)), {
    band: 5,
    compander: 2,
    exclude: 1,
    scanlist: 3
  });
});

test('tone labels match the radio menu', () => {
  assert.equal(F.toneLabel(0, 0), '-');
  assert.equal(F.toneLabel(1, 0), '67.0Hz');
  assert.equal(F.toneLabel(2, 0), 'D023');
  assert.equal(F.toneLabel(3, 0), 'D023');
});

test('parseChannel combines record, name and attributes', () => {
  const record = F.buildRecord({
    rxFreq: 45755000,
    txOffset: 0,
    rxCode: 0,
    txCode: 0,
    rxCodeType: 0,
    txCodeType: 0,
    modulation: 6,
    direction: 0,
    freqReverse: false,
    bandwidth: 0,
    outputPower: 1,
    bcl: false,
    txLock: true,
    dtmfDecode: false,
    pttIdMode: 0,
    stepSetting: 4,
    scrambling: 0
  });
  const name = new Uint8Array(16);
  name.set([0x41, 0x42, 0x43]);
  const attr = Uint8Array.of(5, 0);
  const channel = F.parseChannel(7, record, name, attr);
  assert.equal(channel.num, 7);
  assert.equal(channel.rxFreq, 45755000);
  assert.equal(channel.name, 'ABC');
  assert.equal(channel.modulation, 6);
  assert.equal(channel.band, 5);
  assert.equal(F.isValid(channel), true);
});

test('isValid follows the firmware empty-slot marker', () => {
  const record = F.buildRecord({
    rxFreq: 14550000,
    txOffset: 0,
    rxCode: 0,
    txCode: 0,
    rxCodeType: 0,
    txCodeType: 0,
    modulation: 0,
    direction: 0,
    freqReverse: false,
    bandwidth: 0,
    outputPower: 1,
    bcl: false,
    txLock: false,
    dtmfDecode: false,
    pttIdMode: 0,
    stepSetting: 4,
    scrambling: 0
  });
  const name = new Uint8Array(16);
  assert.equal(F.isValid(F.parseChannel(0, record, name, Uint8Array.of(2, 0))), true);
  // 0x0007 (band 7) and 0xFFFF are what the firmware leaves on an empty slot.
  assert.equal(F.isValid(F.parseChannel(0, record, name, Uint8Array.of(0x07, 0x00))), false);
  assert.equal(F.isValid(F.parseChannel(0, record, name, Uint8Array.of(0xFF, 0xFF))), false);
});

test('GBK names encode to GB2312 and stay inside 10 bytes', { skip: !hasGbkDecoder() }, () => {
  const name = F.encodeName('北京');
  assert.equal(name.length, 16);
  assert.deepEqual(Array.from(name.subarray(0, 4)), [0xB1, 0xB1, 0xBE, 0xA9]);
  assert.equal(F.decodeName(name), '北京');
  assert.equal(F.encodeName('ABCDEFGHIJ').subarray(0, 10).length, 10);
  assert.throws(() => F.encodeName('ABCDEFGHIJK'), /too-long/);
  assert.throws(() => F.encodeName('北京北京北京'), /too-long/);
  assert.throws(() => F.encodeName('A\u0001B'), /control/);
});
