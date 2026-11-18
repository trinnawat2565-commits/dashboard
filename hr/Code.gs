/**
 * ระบบบุคลากร รพ.สต. — Apps Script API (เก็บข้อมูลใน Google Sheets)
 * หน้าเว็บอยู่บน GitHub Pages (โฟลเดอร์ hr/) และเรียก API นี้ผ่าน fetch
 *
 * ชีตที่ setup() สร้าง
 *   ตั้งค่า      : ค่า GPS (ละติจูด ลองจิจูด รัศมี ความแม่นยำ)
 *   ผู้ใช้        : รหัส, ชื่อ-สกุล, PIN, สิทธิ์ (admin/staff), ใช้งาน
 *   ข้อมูล       : ที่เก็บเอกสารทั้งหมดของแอป (path, collection, json, updatedAt, by, deleted) — ไม่ต้องแก้มือ
 *   บันทึก GPS   : ประวัติการกดลงเวลาทุกครั้ง พร้อมพิกัดและระยะห่าง
 */

var SH = { settings: 'ตั้งค่า', users: 'ผู้ใช้', docs: 'ข้อมูล', gps: 'บันทึก GPS' };
var USER_HEADERS = ['รหัส', 'ชื่อ-สกุล', 'PIN', 'สิทธิ์', 'ใช้งาน'];
var DOC_HEADERS = ['path', 'collection', 'json', 'updatedAt', 'by', 'deleted'];
var GPS_HEADERS = ['เวลาบันทึก', 'วันที่', 'เวลา', 'รหัส', 'ชื่อ-สกุล', 'ประเภท', 'ละติจูด', 'ลองจิจูด', 'ความแม่นยำ (ม.)', 'ระยะห่าง (ม.)', 'สถานะ', 'หมายเหตุ'];
var SETTING_ROWS = [
  ['ละติจูด', '', 'ตั้งจากแอปได้ที่แท็บ ตั้งค่า > ตั้งพิกัดตรงที่ยืนอยู่'],
  ['ลองจิจูด', '', ''],
  ['รัศมีที่อนุญาต (ม.)', 150, 'ระยะห่างสูงสุดจาก รพ.สต. ที่ลงเวลาได้'],
  ['ความแม่นยำขั้นต่ำ (ม.)', 100, 'ถ้า GPS คลาดเคลื่อนมากกว่านี้ ให้ลองใหม่'],
  ['เปิดใช้ GPS', true, 'เอาติ๊กออกเพื่อปิดการตรวจพิกัดชั่วคราว']
];
var TZ = 'Asia/Bangkok';
var SESSION_SEC = 6 * 3600;
var MAX_JSON = 48000;
var PATH_RE = /^[a-z]+\/[A-Za-z0-9_\-]{1,80}$/;
var ADMIN_WRITE = ['config', 'duty', 'logs', 'evals'];
var ADMIN_READ = ['evals'];

/* ---------- setup ---------- */
function setup() {
  var ss = SpreadsheetApp.getActive();
  var st = ensure_(ss, SH.settings, ['รายการ', 'ค่า', 'คำอธิบาย']);
  if (st.getLastRow() < 2) st.getRange(2, 1, SETTING_ROWS.length, 3).setValues(SETTING_ROWS);
  st.getRange(6, 2).insertCheckboxes();
  if (st.getRange(6, 2).getValue() === '') st.getRange(6, 2).setValue(true);
  var us = ensure_(ss, SH.users, USER_HEADERS);
  us.getRange('C:C').setNumberFormat('@');
  us.getRange(2, 5, Math.max(us.getMaxRows() - 1, 1), 1).insertCheckboxes();
  ensure_(ss, SH.docs, DOC_HEADERS).getRange('A:D').setNumberFormat('@');
  ensure_(ss, SH.gps, GPS_HEADERS);
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  if (!PropertiesService.getScriptProperties().getProperty('SALT')) {
    PropertiesService.getScriptProperties().setProperty('SALT', Utilities.getUuid());
  }
}
function ensure_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ---------- web entry ---------- */
function doGet() { return json_({ ok: true, data: { service: 'hr', time: now_().iso } }); }

var ACTIONS = {
  roster: { pub: true, fn: roster },
  login: { pub: true, fn: login },
  logout: { fn: logout },
  pull: { fn: pull },
  set: { fn: setDoc },
  del: { fn: delDoc },
  punch: { fn: punch },
  geo: { fn: getGeo },
  setGeo: { admin: true, fn: setGeo }
};

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 60000) throw new Error('คำขอไม่ถูกต้องหรือมีขนาดใหญ่เกินไป');
    var req;
    try { req = JSON.parse(raw); } catch (_) { throw new Error('คำขอต้องเป็น JSON'); }
    var a = req && ACTIONS.hasOwnProperty(req.action) ? ACTIONS[req.action] : null;
    if (!a) throw new Error('ไม่อนุญาตให้เรียกคำสั่งนี้');
    var p = req.params && typeof req.params === 'object' ? req.params : {};
    if (a.pub) return json_({ ok: true, data: a.fn(p) });
    var s = session_(req.token);
    if (a.admin && s.role !== 'admin') throw new Error('เฉพาะผู้ดูแลระบบ');
    return json_({ ok: true, data: a.fn(s, p) });
  } catch (err) {
    return json_({ ok: false, error: err && err.message ? err.message : 'ไม่สามารถดำเนินการได้', code: err && err.code });
  }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(msg, code) { var e = new Error(msg); e.code = code || 'error'; throw e; }

/* ---------- users & sessions ---------- */
function users_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH.users);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().map(function (r, i) {
    return { row: i + 2, id: String(r[0]).trim(), name: String(r[1]).trim(), pin: String(r[2]).trim(),
      role: String(r[3]).trim().toLowerCase() === 'admin' ? 'admin' : 'staff', active: r[4] === true || String(r[4]).toUpperCase() === 'TRUE' };
  }).filter(function (u) { return u.id && u.name && u.active; });
}
function roster() {
  return { users: users_().map(function (u) { return { id: u.id, name: u.name }; }), time: now_().iso };
}
function hash_(pin) {
  var salt = PropertiesService.getScriptProperties().getProperty('SALT') || '';
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return 'h:' + Utilities.base64Encode(b);
}
function login(p) {
  var id = String(p.id || ''), pin = String(p.pin || '');
  if (!/^\d{4,6}$/.test(pin)) fail_('PIN ต้องเป็นตัวเลข 4–6 หลัก');
  var cache = CacheService.getScriptCache(), lockKey = 'fail_' + id;
  var fails = Number(cache.get(lockKey) || 0);
  if (fails >= 5) fail_('ใส่ PIN ผิดหลายครั้ง ระบบล็อกชื่อนี้ไว้ 10 นาที');
  var u = users_().filter(function (x) { return x.id === id; })[0];
  if (!u || !u.pin) fail_('ไม่พบชื่อนี้ หรือยังไม่ได้ตั้ง PIN ในชีต ผู้ใช้');
  var ok = u.pin.indexOf('h:') === 0 ? u.pin === hash_(pin) : u.pin === pin;
  if (!ok) { cache.put(lockKey, String(fails + 1), 600); fail_('PIN ไม่ถูกต้อง'); }
  cache.remove(lockKey);
  if (u.pin.indexOf('h:') !== 0) {
    SpreadsheetApp.getActive().getSheetByName(SH.users).getRange(u.row, 3).setValue(hash_(pin));
  }
  users_().forEach(ensureStaffDoc_);
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('tok_' + token, JSON.stringify({ id: u.id, name: u.name, role: u.role }), SESSION_SEC);
  return { token: token, user: { id: u.id, name: u.name, role: u.role } };
}
function ensureStaffDoc_(u) {
  var path = 'staff/' + u.id;
  if (!PATH_RE.test(path) || readDoc_(path)) return;
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (readDoc_(path)) return;
    var order = users_().map(function (x) { return x.id; }).indexOf(u.id);
    write_(path, { name: u.name, position: '', order: order < 0 ? 99 : order, active: true, since: now_().date, vacQuota: 10 }, 'system');
  } finally { lock.releaseLock(); }
}
function session_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) fail_('กรุณาเข้าสู่ระบบ', 'auth');
  var raw = CacheService.getScriptCache().get('tok_' + token);
  if (!raw) fail_('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่', 'auth');
  CacheService.getScriptCache().put('tok_' + token, raw, SESSION_SEC);
  var s = JSON.parse(raw); s.token = token; return s;
}
function logout(s) { CacheService.getScriptCache().remove('tok_' + s.token); return true; }

/* ---------- document store ---------- */
function docSheet_() { return SpreadsheetApp.getActive().getSheetByName(SH.docs); }
function rows_() {
  var sh = docSheet_(); if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
}
function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }
function pull(s, p) {
  var since = String(p.since || '');
  var stamp = new Date().toISOString(), out = [];
  rows_().forEach(function (r) {
    var col = String(r[1]), at = iso_(r[3]);
    if (ADMIN_READ.indexOf(col) >= 0 && s.role !== 'admin') return;
    if (since && at <= since) return;
    var del = r[5] === true || String(r[5]).toUpperCase() === 'TRUE';
    if (del) { if (since) out.push({ path: String(r[0]), deleted: true }); return; }
    var data; try { data = JSON.parse(r[2]); } catch (_) { return; }
    out.push({ path: String(r[0]), data: data, at: at });
  });
  return { docs: out, now: stamp, me: { id: s.id, name: s.name, role: s.role } };
}
function find_(path) {
  var sh = docSheet_(); if (sh.getLastRow() < 2) return 0;
  var hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(path).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}
function readDoc_(path) {
  var row = find_(path); if (!row) return null;
  var r = docSheet_().getRange(row, 1, 1, 6).getValues()[0];
  if (r[5] === true || String(r[5]).toUpperCase() === 'TRUE') return null;
  try { return JSON.parse(r[2]); } catch (_) { return null; }
}
function canWrite_(s, path, body) {
  var col = path.split('/')[0], id = path.split('/')[1];
  if (s.role === 'admin') return;
  if (ADMIN_WRITE.indexOf(col) >= 0) fail_('เฉพาะผู้ดูแลระบบแก้ไขส่วนนี้ได้', 'forbidden');
  if (col === 'staff' && id !== s.id) fail_('แก้ไขได้เฉพาะข้อมูลของตัวเอง', 'forbidden');
  if (col === 'requests') {
    var cur = readDoc_(path);
    var was = cur ? cur.status : 'pending', now = body ? body.status : was;
    if (was !== 'pending' || (now && now !== 'pending')) fail_('เฉพาะผู้ดูแลระบบอนุมัติหรือแก้คำขอที่พิจารณาแล้วได้', 'forbidden');
    if (cur && cur.createdBy && cur.createdBy !== s.id) fail_('แก้ไขได้เฉพาะคำขอของตัวเอง', 'forbidden');
  }
}
function write_(path, body, by) {
  var sh = docSheet_(), at = new Date().toISOString();
  var json = body ? JSON.stringify(body) : '';
  if (json.length > MAX_JSON) fail_('ข้อมูลใหญ่เกินไป (เช่น รูปหรือข้อความยาวเกิน) ลองย่อลง');
  var vals = [[path, path.split('/')[0], json, at, by, !body]];
  var row = find_(path);
  if (row) sh.getRange(row, 1, 1, 6).setValues(vals);
  else if (body) sh.appendRow(vals[0]);
  return at;
}
function setDoc(s, p) {
  var path = String(p.path || '');
  if (!PATH_RE.test(path)) fail_('ที่อยู่ข้อมูลไม่ถูกต้อง');
  if (!p.data || typeof p.data !== 'object') fail_('ไม่มีข้อมูลที่จะบันทึก');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { canWrite_(s, path, p.data); return { at: write_(path, p.data, s.id) }; }
  finally { lock.releaseLock(); }
}
function delDoc(s, p) {
  var path = String(p.path || '');
  if (!PATH_RE.test(path)) fail_('ที่อยู่ข้อมูลไม่ถูกต้อง');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { canWrite_(s, path, null); return { at: write_(path, null, s.id) }; }
  finally { lock.releaseLock(); }
}

/* ---------- GPS clock-in ---------- */
function geo_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH.settings);
  var v = sh.getRange(2, 2, 5, 1).getValues().map(function (r) { return r[0]; });
  return { lat: v[0] === '' ? null : Number(v[0]), lng: v[1] === '' ? null : Number(v[1]),
    radius: Number(v[2]) || 150, maxAcc: Number(v[3]) || 100, on: !(v[4] === false || String(v[4]).toUpperCase() === 'FALSE') };
}
function getGeo(s) { var g = geo_(); return { set: g.lat !== null && g.lng !== null, radius: g.radius, maxAcc: g.maxAcc, on: g.on }; }
function setGeo(s, p) {
  var lat = Number(p.lat), lng = Number(p.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail_('พิกัดไม่ถูกต้อง');
  var sh = SpreadsheetApp.getActive().getSheetByName(SH.settings);
  sh.getRange(2, 2, 2, 1).setValues([[lat.toFixed(6)], [lng.toFixed(6)]]);
  if (p.radius) sh.getRange(4, 2).setValue(Math.max(30, Math.min(2000, Number(p.radius) || 150)));
  return getGeo(s);
}
function dist_(a, b, c, d) {
  var R = 6371000, r = Math.PI / 180;
  var x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2);
  var h = x * x + Math.cos(a * r) * Math.cos(c * r) * y * y;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function now_() {
  var d = new Date();
  return { d: d, iso: d.toISOString(), date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), time: Utilities.formatDate(d, TZ, 'HH:mm') };
}
function punch(s, p) {
  var kind = p.kind === 'out' ? 'out' : 'in';
  var g = geo_(), n = now_();
  var lat = Number(p.lat), lng = Number(p.lng), acc = Number(p.acc);
  var meters = '', status = 'สำเร็จ', note = '';
  if (g.on) {
    if (g.lat === null || g.lng === null) fail_('ผู้ดูแลยังไม่ได้ตั้งพิกัด รพ.สต. (แท็บ ตั้งค่า)');
    if (!isFinite(lat) || !isFinite(lng)) fail_('ไม่ได้รับพิกัดจากมือถือ ลองเปิด GPS แล้วกดใหม่');
    meters = Math.round(dist_(g.lat, g.lng, lat, lng));
    if (isFinite(acc) && acc > g.maxAcc) { status = 'ปฏิเสธ'; note = 'สัญญาณ GPS คลาดเคลื่อน ' + Math.round(acc) + ' ม.'; }
    else if (meters > g.radius) { status = 'ปฏิเสธ'; note = 'อยู่นอกพื้นที่ ' + meters + ' ม. (อนุญาต ' + g.radius + ' ม.)'; }
  }
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var path = 'logs/' + n.date + '_' + s.id;
    var cur = readDoc_(path) || {};
    if (status === 'สำเร็จ') {
      if (kind === 'in' && cur['in']) { status = 'ปฏิเสธ'; note = 'ลงเวลาเข้าวันนี้แล้ว ' + cur['in']; }
      if (kind === 'out' && !cur['in']) { status = 'ปฏิเสธ'; note = 'ยังไม่ได้ลงเวลาเข้า'; }
    }
    SpreadsheetApp.getActive().getSheetByName(SH.gps).appendRow([n.d, n.date, n.time, s.id, s.name,
      kind === 'in' ? 'เข้า' : 'ออก', isFinite(lat) ? lat : '', isFinite(lng) ? lng : '', isFinite(acc) ? Math.round(acc) : '', meters, status, note]);
    if (status !== 'สำเร็จ') return { ok: false, reason: note, meters: meters };
    var body = {};
    Object.keys(cur).forEach(function (k) { body[k] = cur[k]; });
    body.date = n.date; body.staffId = s.id; body[kind] = n.time; body.via = 'gps'; body.updatedAt = n.iso;
    if (meters !== '') body[kind + 'M'] = meters;
    write_(path, body, s.id);
    return { ok: true, time: n.time, date: n.date, meters: meters, log: body, path: path };
  } finally { lock.releaseLock(); }
}
