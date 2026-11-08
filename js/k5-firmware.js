// K5/K6 V1 firmware inspector — raw images and uvmod/official packed images.
//
// A packed image is the official/uvmod container: the flash image with a
// 16-byte version block inserted at 0x2000, XOR-obfuscated with the 128-byte
// table below and followed by a little-endian CRC16/XMODEM of everything
// before it. Unpacking reverses that, so the legacy V1 bootloader receives the
// same raw image k5prog writes.
//
// The helpers are pure and exported for Node tests; the browser runtime is
// guarded and self-boots.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVTOOLS_K5_FIRMWARE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_IMAGE_SIZE = 0xF000;      // 60 KiB; 0xF000..0xFFFF is the bootloader
  const PAGE_SIZE = 0x100;
  const PACKED_VERSION_OFFSET = 0x2000;
  const PACKED_VERSION_LENGTH = 16;

  const PACKED_XOR = new Uint8Array([
    0x47, 0x22, 0xc0, 0x52, 0x5d, 0x57, 0x48, 0x94, 0xb1, 0x60, 0x60, 0xdb, 0x6f, 0xe3, 0x4c, 0x7c,
    0xd8, 0x4a, 0xd6, 0x8b, 0x30, 0xec, 0x25, 0xe0, 0x4c, 0xd9, 0x00, 0x7f, 0xbf, 0xe3, 0x54, 0x05,
    0xe9, 0x3a, 0x97, 0x6b, 0xb0, 0x6e, 0x0c, 0xfb, 0xb1, 0x1a, 0xe2, 0xc9, 0xc1, 0x56, 0x47, 0xe9,
    0xba, 0xf1, 0x42, 0xb6, 0x67, 0x5f, 0x0f, 0x96, 0xf7, 0xc9, 0x3c, 0x84, 0x1b, 0x26, 0xe1, 0x4e,
    0x3b, 0x6f, 0x66, 0xe6, 0xa0, 0x6a, 0xb0, 0xbf, 0xc6, 0xa5, 0x70, 0x3a, 0xba, 0x18, 0x9e, 0x27,
    0x1a, 0x53, 0x5b, 0x71, 0xb1, 0x94, 0x1e, 0x18, 0xf2, 0xd6, 0x81, 0x02, 0x22, 0xfd, 0x5a, 0x28,
    0x91, 0xdb, 0xba, 0x5d, 0x64, 0xc6, 0xfe, 0x86, 0x83, 0x9c, 0x50, 0x1c, 0x73, 0x03, 0x11, 0xd6,
    0xaf, 0x30, 0xf4, 0x2c, 0x77, 0xb2, 0x7d, 0xbb, 0x3f, 0x29, 0x28, 0x57, 0x22, 0xd6, 0x92, 0x8b
  ]);

  // CRC-16/XMODEM (poly 0x1021, init 0), the same one k5prog and fwpack.js use.
  function crc16xmodem(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  function xorBytes(bytes) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      out[i] = bytes[i] ^ PACKED_XOR[i % PACKED_XOR.length];
    }
    return out;
  }

  // A packed file ends with the CRC16 of everything before it. A raw image has
  // only a 1-in-65536 chance of matching, so this is a safe discriminator.
  function isPacked(bytes) {
    if (!bytes || bytes.length < PACKED_VERSION_OFFSET + PACKED_VERSION_LENGTH + 2) return false;
    const stored = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
    return crc16xmodem(bytes.subarray(0, bytes.length - 2)) === stored;
  }

  function decodeVersion(block) {
    let text = '';
    for (let i = 0; i < block.length; i++) {
      const byte = block[i];
      if (byte === 0 || byte < 0x20 || byte > 0x7e) break;
      text += String.fromCharCode(byte);
    }
    return text;
  }

  // A real UV-K5 image starts with the Cortex-M0 vector table: stack pointer in
  // the 8 KiB SRAM at 0x20000000 and an odd Thumb reset vector below 0xF000.
  // This guards against a raw image whose last two bytes happen to match the
  // CRC (1 in 65536) being mistaken for a packed container.
  function looksLikeFirmwareImage(image) {
    if (!image || image.length < 8) return false;
    const sp = image[0] | (image[1] << 8) | (image[2] << 16) | (image[3] << 24);
    const reset = image[4] | (image[5] << 8) | (image[6] << 16) | (image[7] << 24);
    return sp >= 0x20000000 && sp < 0x20020000 &&
      reset >= 0x100 && reset < 0xF000 && (reset & 1) === 1;
  }

  function unpack(bytes) {
    const decoded = xorBytes(bytes.subarray(0, bytes.length - 2));
    const versionBlock = decoded.slice(
      PACKED_VERSION_OFFSET, PACKED_VERSION_OFFSET + PACKED_VERSION_LENGTH);
    const image = new Uint8Array(decoded.length - PACKED_VERSION_LENGTH);
    image.set(decoded.subarray(0, PACKED_VERSION_OFFSET), 0);
    image.set(decoded.subarray(PACKED_VERSION_OFFSET + PACKED_VERSION_LENGTH), PACKED_VERSION_OFFSET);
    return { image, versionBlock, version: decodeVersion(versionBlock) };
  }

  // Inverse of unpack(); used by the tests and handy for rebuilding a packed
  // file from a raw image.
  function pack(image, versionBlock) {
    const block = new Uint8Array(PACKED_VERSION_LENGTH);
    if (versionBlock) block.set(versionBlock.subarray(0, PACKED_VERSION_LENGTH), 0);
    const combined = new Uint8Array(image.length + PACKED_VERSION_LENGTH);
    combined.set(image.subarray(0, PACKED_VERSION_OFFSET), 0);
    combined.set(block, PACKED_VERSION_OFFSET);
    combined.set(image.subarray(PACKED_VERSION_OFFSET), PACKED_VERSION_OFFSET + PACKED_VERSION_LENGTH);

    const encoded = xorBytes(combined);
    const crc = crc16xmodem(encoded);
    const packed = new Uint8Array(encoded.length + 2);
    packed.set(encoded, 0);
    packed[encoded.length] = crc & 0xff;
    packed[encoded.length + 1] = (crc >> 8) & 0xff;
    return packed;
  }

  function inspect(bytes) {
    if (!bytes || !bytes.length) {
      return {
        image: new Uint8Array(0), format: 'raw', version: '', versionBlock: null,
        error: 'empty'
      };
    }

    let image = bytes;
    let format = 'raw';
    let version = '';
    let versionBlock = null;

    if (isPacked(bytes)) {
      const unpacked = unpack(bytes);
      // Require both a valid vector table and a version string so a raw image
      // with a coincidental CRC match stays raw.
      if (looksLikeFirmwareImage(unpacked.image) && unpacked.version.length > 0) {
        image = unpacked.image;
        version = unpacked.version;
        versionBlock = unpacked.versionBlock;
        format = 'packed';
      }
    }

    if (image.length > MAX_IMAGE_SIZE) {
      return { image, format, version, versionBlock, error: 'too-large' };
    }
    return { image, format, version, versionBlock, error: '' };
  }

  return {
    MAX_IMAGE_SIZE,
    PAGE_SIZE,
    PACKED_VERSION_OFFSET,
    PACKED_VERSION_LENGTH,
    PACKED_XOR,
    crc16xmodem,
    isPacked,
    looksLikeFirmwareImage,
    unpack,
    pack,
    inspect
  };
});
