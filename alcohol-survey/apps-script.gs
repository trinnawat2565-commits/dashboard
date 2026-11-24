/**
 * ฐานข้อมูล Google Sheets สำหรับแดชบอร์ดลดละเลิกเหล้า (alcohol-survey/index.html)
 *
 * วิธีติดตั้ง
 * 1. สร้าง Google Sheet ใหม่ > ส่วนขยาย > Apps Script
 * 2. วางโค้ดนี้แทนโค้ดเดิม แล้วเปลี่ยน SECRET ด้านล่างเป็นรหัสลับของคุณเอง
 * 3. ทำให้ใช้งานได้ > การทำให้ใช้งานได้รายการใหม่ > ประเภท: เว็บแอป
 *    เรียกใช้ในฐานะ: ฉัน · ผู้มีสิทธิ์เข้าถึง: ทุกคน
 * 4. คัดลอก URL ของเว็บแอป (ลงท้าย /exec) ไปใส่ในแท็บ "ตั้งค่า" ของแดชบอร์ด พร้อมรหัสลับ
 *
 * ถ้าแก้โค้ดภายหลัง ต้องกด "จัดการการทำให้ใช้งานได้ > แก้ไข > เวอร์ชันใหม่" ลิงก์เดิมจึงจะใช้โค้ดใหม่
 *
 * ข้อมูลเก็บ 2 ชีต: participants (ส่วนที่ 1) และ visits (ส่วนที่ 2–7 ต่อรอบ)
 * คอลัมน์ json คือข้อมูลเต็ม ห้ามแก้ด้วยมือ คอลัมน์อื่นมีไว้ให้อ่านง่ายเท่านั้น
 */
const SECRET = 'เปลี่ยนเป็นรหัสลับของคุณ';

const HEAD = {
  participants: ['id', 'pid', 'province', 'sex', 'orgtype', 'updatedAt', 'json'],
  visits: ['id', 'pid', 'month', 'date', 'alt', 'ast', 'audit', 'eth_g_week', 'hl_total', 'stage', 'updatedAt', 'json']
};

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.appendRow(HEAD[name]);
    s.setFrozenRows(1);
    s.getRange('A:B').setNumberFormat('@'); // keep ids like 00123 as text
  }
  return s;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function read_(name) {
  const s = sheet_(name);
  const values = s.getDataRange().getValues();
  const head = values.shift();
  const j = head.indexOf('json');
  return values.filter(r => r[0] !== '').map(r => [String(r[0]), JSON.parse(r[j])]);
}

function row_(name, id, d) {
  if (name === 'participants') {
    return [id, d.pid || '', d.province || '', d.sex || '', d.orgtype || '', d.updatedAt || '', JSON.stringify(d)];
  }
  const a = d.a || {}, c = d.c || {};
  const stage = a.stage || (c.stage_suggest && c.stage_suggest.s) || '';
  const n = v => (typeof v === 'number' ? v : '');
  return [id, d.pid || '', n(d.month), d.date || '', n(a.alt), n(a.ast), n(c.audit),
          typeof c.eth_wk === 'number' ? Math.round(c.eth_wk * 10) / 10 : '', n(c.hl_total), stage, d.updatedAt || '', JSON.stringify(d)];
}

function doGet(e) {
  if (!e.parameter || e.parameter.key !== SECRET) return out_({ ok: false, error: 'รหัสลับไม่ถูกต้อง' });
  return out_({ ok: true, participants: read_('participants'), visits: read_('visits') });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  if (body.key !== SECRET) return out_({ ok: false, error: 'รหัสลับไม่ถูกต้อง' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    (body.ops || []).forEach(op => {
      if (!HEAD[op.col] || !op.id) return;
      const s = sheet_(op.col);
      const last = s.getLastRow();
      const ids = last > 1 ? s.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
      const i = ids.indexOf(String(op.id));
      if (op.op === 'del') {
        if (i >= 0) s.deleteRow(i + 2);
      } else if (op.op === 'set') {
        const r = row_(op.col, String(op.id), op.doc || {});
        if (i >= 0) s.getRange(i + 2, 1, 1, r.length).setValues([r]);
        else s.appendRow(r);
      }
    });
    return out_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
