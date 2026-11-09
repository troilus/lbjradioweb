// Unit tests for the archive catalog helpers. Run: node --test js/catalog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('./catalog.js');

test('parseFirmwareName keeps the project edition and version', () => {
  const parsed = catalog.parseFirmwareName('LBJRADIO.v5.5.0.bin');
  assert.equal(parsed.name, 'LBJRADIO.v5.5.0.bin');
  assert.equal(parsed.base, 'LBJRADIO');
  assert.equal(parsed.label, 'LBJRADIO');
  assert.equal(parsed.version, '5.5.0');
  assert.equal(parsed.suffix, '');
});

test('parseFirmwareName keeps a -test suffix for the label', () => {
  const parsed = catalog.parseFirmwareName('LBJRADIO-cn.v5.6.3-test.bin');
  assert.equal(parsed.base, 'LBJRADIO-cn');
  assert.equal(parsed.version, '5.6.3');
  assert.equal(parsed.suffix, '-test');
  assert.equal(catalog.formatEntryLabel({ ...parsed, size: 118792 }), 'v5.6.3-test · 116 KB');
});

test('parseFirmwareName humanizes F4HWN and Quansheng prefixes', () => {
  assert.equal(catalog.parseFirmwareName('f4hwn.fusion.v5.5.0.bin').label, 'F4HWN Fusion');
  assert.equal(catalog.parseFirmwareName('quansheng.k1.v7.03.01.bin').label, 'Quansheng K1');
});

test('parseFirmwareName ignores non-firmware files', () => {
  assert.equal(catalog.parseFirmwareName('quansheng.stock.logo.png'), null);
  assert.equal(catalog.parseFirmwareName('README.md'), null);
  assert.equal(catalog.parseFirmwareName(''), null);
});

test('parseFirmwareName tolerates a missing version', () => {
  const parsed = catalog.parseFirmwareName('custom.bin');
  assert.equal(parsed.version, '');
  assert.equal(parsed.base, 'custom');
  assert.equal(parsed.label, 'custom');
});

test('parseAppName handles the flat apps folder', () => {
  const parsed = catalog.parseAppName('LBJRX-cn.v5.5.0.app');
  assert.equal(parsed.base, 'LBJRX-cn');
  assert.equal(parsed.label, 'LBJRX-cn');
  assert.equal(parsed.version, '5.5.0');
  assert.equal(catalog.parseAppName('LBJRX.app').version, '');
  assert.equal(catalog.parseAppName('LBJRX.bin'), null);
});

test('categorizeFirmware groups by edition, newest first', () => {
  const groups = catalog.categorizeFirmware([
    { name: 'LBJRADIO.v5.4.0.bin', size: 100 },
    { name: 'f4hwn.fusion.v5.5.0.bin', size: 200 },
    { name: 'LBJRADIO.v5.5.0.bin', size: 300 },
    { name: 'quansheng.stock.logo.png', size: 400 },
    { name: 'LBJRADIO.v5.10.0.bin', size: 500 }
  ]);

  assert.equal(groups.length, 2);
  const editions = groups.map(group => group.label).sort();
  assert.deepEqual(editions, ['F4HWN Fusion', 'LBJRADIO']);

  const lbj = groups.find(group => group.label === 'LBJRADIO');
  assert.deepEqual(lbj.entries.map(entry => entry.version), ['5.10.0', '5.5.0', '5.4.0']);
  assert.equal(lbj.entries[0].size, 500);
  assert.equal(lbj.entries[0].url, 'https://lbj.xanyi.eu.org/archive/LBJRADIO.v5.10.0.bin');
});

test('parseFirmwareName still parses K5 TDCS but the V3 list hides it', () => {
  const parsed = catalog.parseFirmwareName('k5tdcs-v1.0.1.bin');
  assert.equal(parsed.base, 'k5tdcs');
  assert.equal(parsed.label, 'K5 TDCS');
  assert.equal(parsed.version, '1.0.1');

  // V1-only images must never show up in the UV-K1 / K5 V3 firmware list.
  const groups = catalog.categorizeFirmware([
    { name: 'k5tdcs-v1.0.0.bin', size: 1 },
    { name: 'k5tdcs-v1.0.1.bin', size: 2 },
    { name: 'LBJRADIO.v5.6.2.bin', size: 3 }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'LBJRADIO');
});

test('categorizeK5Firmware lists the V1 TDCS images newest first', () => {
  const entries = catalog.categorizeK5Firmware([
    { name: 'k5tdcs-v1.0.0.bin', size: 100 },
    { name: 'k5tdcs_v1.2.0.bin', size: 200 },
    { name: 'LBJRADIO.v5.6.2.bin', size: 300 },
    { name: 'k5tdcs-1.1.0.bin', size: 400 }
  ]);
  assert.deepEqual(entries.map(entry => entry.version), ['1.2.0', '1.1.0', '1.0.0']);
  assert.equal(entries[0].url, 'https://lbj.xanyi.eu.org/archive/k5tdcs_v1.2.0.bin');
  assert.equal(entries[0].size, 200);
});

test('categorizeApps groups and sorts versions numerically', () => {
  const groups = catalog.categorizeApps([
    { name: 'LBJRX.v5.5.0.app', size: 6058 },
    { name: 'LBJRX.v5.10.0.app', size: 7000 },
    { name: 'LBJRX-cn.v5.5.0.app', size: 5966 }
  ]);
  assert.equal(groups.length, 2);
  const main = groups.find(group => group.label === 'LBJRX');
  assert.deepEqual(main.entries.map(entry => entry.version), ['5.10.0', '5.5.0']);
  assert.equal(main.entries[0].url, 'https://lbj.xanyi.eu.org/archive/apps/LBJRX.v5.10.0.app');
});

test('downloadUrl encodes each path segment', () => {
  assert.equal(
    catalog.downloadUrl('apps/LBJ RX.v5.app'),
    'https://lbj.xanyi.eu.org/archive/apps/LBJ%20RX.v5.app'
  );
});

test('formatEntryLabel prefers the version and appends the size', () => {
  assert.equal(catalog.formatEntryLabel({ version: '5.5.0', size: 105756 }), 'v5.5.0 · 103 KB');
  assert.equal(catalog.formatEntryLabel({ version: '', name: 'raw.bin', size: 0 }), 'raw.bin');
});

test('flatten and findEntry locate an entry by file name', () => {
  const groups = catalog.categorizeFirmware([
    { name: 'LBJRADIO.v5.5.0.bin', size: 1 },
    { name: 'LBJRADIO.v5.4.0.bin', size: 1 }
  ]);
  assert.equal(catalog.flatten(groups).length, 2);
  assert.equal(catalog.findEntry(groups, 'LBJRADIO.v5.4.0.bin').version, '5.4.0');
  assert.equal(catalog.findEntry(groups, 'missing.bin'), null);
});

test('findNewestFor matches the header name the radio reports', () => {
  const groups = catalog.categorizeApps([
    { name: 'LBJRX.v5.5.0.app', size: 1 },
    { name: 'LBJRX.v5.4.0.app', size: 1 }
  ]);
  // The .app header stores "LBJ RX"; the file stem is "LBJRX".
  assert.equal(catalog.findNewestFor(groups, 'LBJ RX').version, '5.5.0');
  assert.equal(catalog.findNewestFor(groups, 'LBJRX').version, '5.5.0');
  assert.equal(catalog.findNewestFor(groups, 'other'), null);
});
