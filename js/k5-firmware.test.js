// Unit tests for the K5/K6 V1 firmware inspector. Run: node --test js/k5-firmware.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const k5 = require('./k5-firmware.js');

test('crc16xmodem matches the XMODEM check value', () => {
  assert.equal(k5.crc16xmodem(new TextEncoder().encode('123456789')), 0x31C3);
});

test('pack/unpack round-trips a raw image and its version block', () => {
  const image = new Uint8Array(0x3000);
  for (let i = 0; i < image.length; i++) image[i] = i & 0xff;
  // Valid Cortex-M0 vector table so the packed container is recognised.
  image.set([0xf0, 0x3f, 0x00, 0x20, 0x0b, 0x01, 0x00, 0x00], 0);
  const version = new TextEncoder().encode('*EGZUMER v0.22');
  const packed = k5.pack(image, version);

  assert.equal(k5.isPacked(packed), true);

  const inspected = k5.inspect(packed);
  assert.equal(inspected.format, 'packed');
  assert.equal(inspected.error, '');
  assert.equal(inspected.version, '*EGZUMER v0.22');
  assert.equal(inspected.image.length, image.length);
  assert.deepEqual(
    Array.from(inspected.image.subarray(0, 16)),
    Array.from(image.subarray(0, 16)));
  assert.deepEqual(
    Array.from(inspected.image.subarray(-16)),
    Array.from(image.subarray(-16)));
});

test('inspect treats a plain image as raw', () => {
  const image = new Uint8Array(0x2000);
  image.fill(0x55);
  const inspected = k5.inspect(image);
  assert.equal(inspected.format, 'raw');
  assert.equal(inspected.version, '');
  assert.equal(inspected.image.length, image.length);
  assert.equal(inspected.error, '');
});

test('inspect rejects images above the 60 KiB V1 limit', () => {
  const image = new Uint8Array(k5.MAX_IMAGE_SIZE + 1);
  const inspected = k5.inspect(image);
  assert.equal(inspected.error, 'too-large');
});

test('a raw image with a coincidental CRC trailer is not unpacked', () => {
  const image = new Uint8Array(0x3000);
  image.fill(0xAA);
  const crc = k5.crc16xmodem(image.subarray(0, image.length - 2));
  image[image.length - 2] = crc & 0xff;
  image[image.length - 1] = (crc >> 8) & 0xff;

  assert.equal(k5.isPacked(image), true);
  const inspected = k5.inspect(image);
  assert.equal(inspected.format, 'raw');
  assert.equal(inspected.image.length, image.length);
});

test('inspect flags an empty file', () => {
  assert.equal(k5.inspect(new Uint8Array(0)).error, 'empty');
  assert.equal(k5.inspect(null).error, 'empty');
});
