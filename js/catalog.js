// Firmware & app catalog — lists the LBJ archive published at uvk1.xanyi.eu.org.
//
// Source of truth is the GitHub Contents API for
// troilus/uv-k1-k5v3-firmware-custom-f4 @ main00 (the branch GitHub Pages serves
// as https://uvk1.xanyi.eu.org). Only two requests are ever needed: the archive
// root for .bin firmware images and archive/apps for .app overlays.
//
// Unauthenticated GitHub API calls are limited to 60 per hour per IP, so a
// successful listing is cached in localStorage for CACHE_TTL_MS, and a 403/429
// rate-limit response parks all further requests until GitHub's window resets
// (falling back to the cached listing when one exists).
//
// The parsing/grouping helpers are pure and exported for Node tests; the browser
// runtime is guarded and self-boots.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVTOOLS_CATALOG = api;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    root.UVTOOLS_CATALOG.boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REPO = 'troilus/uv-k1-k5v3-firmware-custom-f4';
  const BRANCH = 'main00';
  const ARCHIVE_PATH = 'archive';
  const APPS_PATH = 'archive/apps';
  // Public download host (GitHub Pages, CORS: *). API `download_url`s point at
  // raw.githubusercontent.com, which is rate-limited the same way as the API.
  const DOWNLOAD_BASE = 'https://uvk1.xanyi.eu.org/archive';

  const API_BASE = 'https://api.github.com/repos/' + REPO + '/contents/';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 12000;

  const CACHE_PREFIX = 'lbjtools.archive.';
  const CACHE_FIRMWARE_KEY = CACHE_PREFIX + 'firmware';
  const CACHE_APPS_KEY = CACHE_PREFIX + 'apps';
  const RATE_LIMIT_KEY = CACHE_PREFIX + 'ratelimit';

  // ===========================================================================
  // PURE HELPERS
  // ===========================================================================

  function isFirmwareFile(name) {
    return typeof name === 'string' && /\.bin$/i.test(name);
  }

  function isAppFile(name) {
    return typeof name === 'string' && /\.app$/i.test(name);
  }

  // "LBJRADIO.v5.5.0.bin"        -> LBJRADIO / 5.5.0
  // "f4hwn.fusion.v5.5.0.bin"    -> F4HWN Fusion / 5.5.0
  // "quansheng.k1.v7.03.01.bin"  -> Quansheng K1 / 7.03.01
  function splitVersionedName(name, extension) {
    const pattern = extension instanceof RegExp ? extension : new RegExp('\\.' + extension + '$', 'i');
    const stem = String(name || '').replace(pattern, '');
    const match = stem.match(/^(.*?)[._-]v(\d+(?:\.\d+)*)([._-].*)?$/i);
    if (!match) return { base: stem, version: '' };
    return { base: match[1], version: match[2] };
  }

  function titleCase(text) {
    return String(text || '')
      .split(/[\s._-]+/)
      .filter(Boolean)
      .map(token => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  }

  // Keep technical brand names readable instead of shouting them back at the user.
  function humanizeBase(base) {
    const text = String(base || "").trim();
    if (!text) return "";
    const tokens = text.split(/[._-]+/).filter(Boolean);
    if (!tokens.length) return text;
    const first = tokens[0].toLowerCase();
    if (first === "f4hwn") {
      return ["F4HWN"].concat(tokens.slice(1).map(token => titleCase(token))).join(" ").trim();
    }
    if (first === "quansheng") {
      return ["Quansheng"].concat(tokens.slice(1).map(token => titleCase(token))).join(" ").trim();
    }
    return text;
  }

  function parseFirmwareName(name) {
    if (!isFirmwareFile(name)) return null;
    const { base, version } = splitVersionedName(name, 'bin');
    const label = humanizeBase(base) || String(name);
    return {
      name,
      kind: 'firmware',
      base,
      group: label.toLowerCase(),
      label,
      version
    };
  }

  function parseAppName(name) {
    if (!isAppFile(name)) return null;
    const { base, version } = splitVersionedName(name, 'app');
    const label = humanizeBase(base) || String(name);
    return {
      name,
      kind: 'app',
      base,
      group: label.toLowerCase(),
      label,
      version
    };
  }

  // Group entries by their leading name, newest version first. Groups keep a
  // stable alphabetical order so the select does not jump between refreshes.
  function groupEntries(entries) {
    const groups = new Map();
    (Array.isArray(entries) ? entries : []).forEach(entry => {
      if (!entry) return;
      const key = entry.group;
      if (!groups.has(key)) {
        groups.set(key, { key, label: entry.label, entries: [] });
      }
      groups.get(key).entries.push(entry);
    });

    const list = Array.from(groups.values());
    list.forEach(group => {
      // Newest first; identical versions keep a deterministic file-name order.
      group.entries.sort((a, b) => {
        const delta = compareVersionDesc(a.version, b.version);
        return delta !== 0 ? delta : a.name.localeCompare(b.name);
      });
    });
    list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return list;
  }

  function categorizeFirmware(files) {
    return groupEntries((Array.isArray(files) ? files : [])
      .map(file => {
        const parsed = parseFirmwareName(file && file.name);
        if (!parsed) return null;
        return Object.assign(parsed, {
          size: Number(file.size) || 0,
          path: ARCHIVE_PATH + '/' + parsed.name,
          url: downloadUrl(parsed.name)
        });
      })
      .filter(Boolean));
  }

  function categorizeApps(files) {
    return groupEntries((Array.isArray(files) ? files : [])
      .map(file => {
        const parsed = parseAppName(file && file.name);
        if (!parsed) return null;
        return Object.assign(parsed, {
          size: Number(file.size) || 0,
          path: APPS_PATH + '/' + parsed.name,
          url: downloadUrl('apps/' + parsed.name)
        });
      })
      .filter(Boolean));
  }

  function downloadUrl(path) {
    return DOWNLOAD_BASE + '/' + String(path || '')
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
  }

  function compareVersionDesc(a, b) {
    const left = String(a || '').split('.').map(Number);
    const right = String(b || '').split('.').map(Number);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
      const delta = (right[i] || 0) - (left[i] || 0);
      if (delta) return delta;
    }
    return 0;
  }

  function formatSize(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${value} B`;
    return `${Math.round(value / 1024)} KB`;
  }

  // "v5.5.0 · 103 KB" — the version is the only thing users compare.
  function formatEntryLabel(entry) {
    if (!entry) return '';
    const parts = [entry.version ? 'v' + entry.version : entry.name];
    const size = formatSize(entry.size);
    if (size) parts.push(size);
    return parts.join(' · ');
  }

  function flatten(groups) {
    return (Array.isArray(groups) ? groups : []).reduce(
      (all, group) => all.concat(group.entries), []);
  }

  function findEntry(groups, name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;
    return flatten(groups).find(entry => entry.name.toLowerCase() === needle) || null;
  }

  // Newest catalog entry for an installed app's name (used by the Update action).
  function findNewestFor(groups, name) {
    const entry = findEntry(groups, name);
    if (entry) return entry;
    // The radio stores the header name ("LBJ RX"), not the file stem: fall back
    // to a loose comparison so "LBJ RX" still matches "LBJRX.v5.5.0.app".
    const squash = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = squash(name);
    if (!target) return null;
    for (const group of Array.isArray(groups) ? groups : []) {
      if (squash(group.label) === target || squash(group.key) === target) {
        return group.entries[0] || null;
      }
    }
    return null;
  }

  // ===========================================================================
  // BROWSER RUNTIME
  // ===========================================================================

  function preferences() {
    return typeof window !== 'undefined' ? window.UVStudioPreferences : null;
  }

  function cacheGet(key) {
    const store = preferences();
    if (!store) return null;
    try {
      const raw = store.get(key, '');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.files)) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function cacheSet(key, files) {
    const store = preferences();
    if (!store) return;
    try {
      store.set(key, JSON.stringify({ fetchedAt: Date.now(), files }));
    } catch (error) {
      /* Quota or private mode: the in-memory result still works this session. */
    }
  }

  function rateLimitUntil() {
    const store = preferences();
    if (!store) return 0;
    const value = Number(store.get(RATE_LIMIT_KEY, '0'));
    return Number.isFinite(value) ? value : 0;
  }

  function setRateLimitUntil(epochMs) {
    const store = preferences();
    if (!store) return;
    if (epochMs > Date.now()) store.set(RATE_LIMIT_KEY, String(epochMs));
    else store.remove(RATE_LIMIT_KEY);
  }

  function apiUrl(path) {
    return API_BASE + path + '?ref=' + encodeURIComponent(BRANCH);
  }

  async function requestListing(path) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let response;
    try {
      response = await fetch(apiUrl(path), {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      throw Object.assign(new Error('network'), { kind: 'network' });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      if ((response.status === 403 || response.status === 429) && remaining === '0' && reset) {
        const until = reset * 1000;
        setRateLimitUntil(until);
        throw Object.assign(new Error('rate-limit'), { kind: 'rate-limit', resetAt: until });
      }
      if (response.status === 404) return [];
      throw Object.assign(new Error('http-' + response.status), {
        kind: 'http', status: response.status
      });
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) return [];
    return payload
      .filter(item => item && item.type === 'file' && typeof item.name === 'string')
      .map(item => ({ name: item.name, size: Number(item.size) || 0 }));
  }

  async function loadListing(options) {
    const settings = options || {};
    const cacheKey = settings.cacheKey;
    const path = settings.path;
    const cached = cacheGet(cacheKey);
    const fresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS;

    if (fresh && !settings.force) {
      return { files: cached.files, stale: false, cached: true, error: null };
    }

    const blockedUntil = rateLimitUntil();
    if (blockedUntil > Date.now()) {
      return {
        files: cached ? cached.files : [],
        stale: Boolean(cached),
        cached: Boolean(cached),
        error: { kind: 'rate-limit', resetAt: blockedUntil }
      };
    }

    try {
      const files = await requestListing(path);
      cacheSet(cacheKey, files);
      return { files, stale: false, cached: false, error: null };
    } catch (error) {
      if (error && error.kind === 'rate-limit') setRateLimitUntil(error.resetAt);
      return {
        files: cached ? cached.files : [],
        stale: Boolean(cached),
        cached: Boolean(cached),
        error: { kind: error?.kind || 'network', status: error?.status, resetAt: error?.resetAt }
      };
    }
  }

  async function loadFirmware(options) {
    const result = await loadListing({
      path: ARCHIVE_PATH, cacheKey: CACHE_FIRMWARE_KEY, force: options && options.force
    });
    return Object.assign(result, { groups: categorizeFirmware(result.files) });
  }

  async function loadApps(options) {
    const result = await loadListing({
      path: APPS_PATH, cacheKey: CACHE_APPS_KEY, force: options && options.force
    });
    return Object.assign(result, { groups: categorizeApps(result.files) });
  }

  // Download an archive file (CORS is open on the Pages host). The API's `size`
  // is authoritative: Pages serves gzip, so Content-Length is not the real size.
  async function fetchBinary(url, expectedSize) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw Object.assign(new Error('HTTP ' + response.status), {
        kind: 'http', status: response.status
      });
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (Number.isFinite(expectedSize) && expectedSize > 0 && bytes.length !== expectedSize) {
      throw Object.assign(new Error('size'), {
        kind: 'size', expected: expectedSize, actual: bytes.length
      });
    }
    return bytes;
  }

  function boot() {
    /* Nothing to do at load time: the views ask for the catalog when they are
       first shown, so visitors who only use the LBJ log spend no API calls. */
  }

  return {
    REPO, BRANCH, ARCHIVE_PATH, APPS_PATH, DOWNLOAD_BASE, CACHE_TTL_MS,
    // pure helpers
    isFirmwareFile, isAppFile, splitVersionedName, parseFirmwareName, parseAppName,
    categorizeFirmware, categorizeApps, groupEntries, downloadUrl, compareVersionDesc,
    formatSize, formatEntryLabel, flatten, findEntry, findNewestFor,
    // runtime
    loadFirmware, loadApps, fetchBinary, boot
  };
});
