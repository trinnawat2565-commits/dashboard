// จำลองบริการของ Apps Script แบบในหน่วยความจำ สำหรับทดสอบ Code.gs ด้วย Node (ไม่มีข้อมูลจริง)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeSheet(name) {
  const data = [];
  const cell = (r, c) => (data[r - 1] || [])[c - 1];
  const sh = {
    data, getName: () => name,
    getLastRow: () => data.length,
    getMaxRows: () => Math.max(data.length, 1000),
    appendRow: (row) => { data.push(row.slice()); },
    setFrozenRows: () => {},
    getRange: (row, col, nr, nc) => {
      if (typeof row === 'string') return { setNumberFormat() { return this; }, insertCheckboxes() { return this; } };
      nr = nr || 1; nc = nc || 1;
      const range = {
        setNumberFormat: () => range, insertCheckboxes: () => range, setFontWeight: () => range,
        getRow: () => row,
        getValue: () => (cell(row, col) === undefined ? '' : cell(row, col)),
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = cell(row + i, col + j); return v === undefined ? '' : v; })),
        setValues: (vals) => { vals.forEach((r, i) => { while (data.length < row + i) data.push([]); r.forEach((v, j) => { data[row - 1 + i][col - 1 + j] = v; }); }); return range; },
        setValue: (v) => { while (data.length < row) data.push([]); data[row - 1][col - 1] = v; return range; },
        createTextFinder: (t) => ({ matchEntireCell() { return this; }, findNext: () => {
          for (let i = 0; i < nr; i++) if (String(cell(row + i, col)) === t) return { getRow: () => row + i };
          return null; } })
      };
      return range;
    }
  };
  return sh;
}

function load() {
  const book = {};
  const ss = {
    getSheetByName: (n) => book[n] || null,
    insertSheet: (n) => (book[n] = makeSheet(n)),
    getSheets: () => Object.values(book),
    deleteSheet: (s) => { delete book[s.getName()]; }
  };
  const cache = new Map(); const props = new Map();
  const pad = (n) => String(n).padStart(2, '0');
  const ctx = {
    SpreadsheetApp: { getActive: () => ss },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (b) => Buffer.from(b.map((x) => (x < 0 ? x + 256 : x))).toString('base64'),
      formatDate: (d, tz, f) => { const t = new Date(d.getTime() + (tz === 'UTC' ? 0 : 7 * 3600e3));
        return f === 'HH:mm' ? pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) : t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
  ctx.book = book;
  ctx.post = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
  ctx.api = (action, params, token) => ctx.post({ action, params, token });
  return ctx;
}
module.exports = { load };
