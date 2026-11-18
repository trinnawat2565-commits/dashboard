// ทดสอบ Code.gs: node tests/code.test.js  (ใช้ชื่อสมมติเท่านั้น)
'use strict';
const assert = require('assert');
const { load } = require('./gas-mock');
let n = 0;
function t(name, fn) { fn(); n++; console.log('✓ ' + name); }

const g = load();
g.setup();
const users = g.book['ผู้ใช้'];
users.appendRow(['A01', 'ผู้ดูแลสมมติ', '1234', 'admin', true]);
users.appendRow(['B02', 'เจ้าหน้าที่สมมติ', '5678', 'staff', true]);
users.appendRow(['C03', 'ปิดใช้งาน', '1111', 'staff', false]);

t('setup creates sheets', () => {
  ['ตั้งค่า', 'ผู้ใช้', 'ข้อมูล', 'บันทึก GPS'].forEach((s) => assert(g.book[s], s));
});
t('roster lists only active users, no PINs', () => {
  const r = g.api('roster');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data.users.map((u) => u.id), ['A01', 'B02']);
  assert(!JSON.stringify(r).includes('1234'));
});
let admin, staff;
t('wrong PIN rejected, right PIN hashes the sheet value', () => {
  assert.strictEqual(g.api('login', { id: 'B02', pin: '0000' }).ok, false);
  const r = g.api('login', { id: 'B02', pin: '5678' });
  assert.strictEqual(r.ok, true); staff = r.data.token;
  assert(String(users.data[2][2]).startsWith('h:'));
  assert.strictEqual(g.api('login', { id: 'B02', pin: '5678' }).ok, true, 'hashed PIN still works');
  admin = g.api('login', { id: 'A01', pin: '1234' }).data.token;
});
t('inactive user cannot log in', () => { assert.strictEqual(g.api('login', { id: 'C03', pin: '1111' }).ok, false); });
t('five wrong PINs lock the name', () => {
  for (let i = 0; i < 5; i++) g.api('login', { id: 'A01', pin: '9999' });
  const r = g.api('login', { id: 'A01', pin: '1234' });
  assert.strictEqual(r.ok, false); assert(/ล็อก/.test(r.error));
});
t('login creates staff docs', () => {
  const r = g.api('pull', {}, admin);
  const paths = r.data.docs.map((d) => d.path);
  assert(paths.includes('staff/A01') && paths.includes('staff/B02'));
});
t('no token -> auth error', () => { const r = g.api('pull', {}); assert.strictEqual(r.code, 'auth'); });
t('staff can write own profile and requests, not settings or logs', () => {
  assert.strictEqual(g.api('set', { path: 'staff/B02', data: { name: 'x', phone: '0' } }, staff).ok, true);
  assert.strictEqual(g.api('set', { path: 'staff/A01', data: { name: 'x' } }, staff).code, 'forbidden');
  assert.strictEqual(g.api('set', { path: 'config/settings', data: { start: '07:00' } }, staff).code, 'forbidden');
  assert.strictEqual(g.api('set', { path: 'logs/2026-01-01_B02', data: { in: '08:00' } }, staff).code, 'forbidden');
  assert.strictEqual(g.api('set', { path: 'requests/r1', data: { kind: 'leave', status: 'pending', createdBy: 'B02' } }, staff).ok, true);
  assert.strictEqual(g.api('set', { path: 'requests/r1', data: { kind: 'leave', status: 'approved', createdBy: 'B02' } }, staff).code, 'forbidden');
  assert.strictEqual(g.api('set', { path: 'requests/r1', data: { kind: 'leave', status: 'approved', createdBy: 'B02' } }, admin).ok, true);
  assert.strictEqual(g.api('del', { path: 'requests/r1' }, staff).code, 'forbidden');
});
t('evals hidden from staff', () => {
  assert.strictEqual(g.api('set', { path: 'evals/2569-1_B02', data: { work: 60 } }, admin).ok, true);
  assert(!g.api('pull', {}, staff).data.docs.some((d) => d.path.startsWith('evals/')));
  assert(g.api('pull', {}, admin).data.docs.some((d) => d.path.startsWith('evals/')));
  assert.strictEqual(g.api('set', { path: 'evals/2569-1_B02', data: { work: 70 } }, staff).code, 'forbidden');
});
t('incremental pull returns changes and deletions', () => {
  const first = g.api('pull', {}, admin).data;
  const since = new Date(new Date(first.now).getTime() - 1).toISOString();
  g.api('set', { path: 'trainings/t1', data: { title: 'อบรม' } }, staff);
  g.api('del', { path: 'trainings/t1' }, staff);
  const r = g.api('pull', { since }, admin).data.docs;
  assert(r.some((d) => d.path === 'trainings/t1' && d.deleted));
});
t('bad paths and huge docs rejected', () => {
  assert.strictEqual(g.api('set', { path: '../x', data: {} }, admin).ok, false);
  assert.strictEqual(g.api('set', { path: 'staff/A01', data: { photo: 'x'.repeat(50000) } }, admin).ok, false);
});
t('punch needs coordinates set', () => {
  const r = g.api('punch', { kind: 'in', lat: 16.4, lng: 103.5, acc: 10 }, staff);
  assert.strictEqual(r.ok, false); assert(/พิกัด/.test(r.error));
});
t('only admin sets location', () => {
  assert.strictEqual(g.api('setGeo', { lat: 16.5, lng: 103.5 }, staff).ok, false);
  const r = g.api('setGeo', { lat: 16.5, lng: 103.5, radius: 150 }, admin);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.data.set, true);
});
t('GPS owner list limits who can set location', () => {
  const st = g.book['ตั้งค่า'];
  st.getRange(7, 2).setValue('B02');
  assert.strictEqual(g.api('geo', {}, admin).data.canSet, false);
  assert.strictEqual(g.api('setGeo', { lat: 1, lng: 1 }, admin).code, 'forbidden');
  st.getRange(7, 2).setValue('A01');
  assert.strictEqual(g.api('geo', {}, admin).data.canSet, true);
  assert.strictEqual(g.api('setGeo', { lat: 16.5, lng: 103.5 }, admin).ok, true);
  st.getRange(7, 2).setValue('');
});
t('punch outside radius is refused and logged', () => {
  const r = g.api('punch', { kind: 'in', lat: 16.51, lng: 103.5, acc: 10 }, staff).data;
  assert.strictEqual(r.ok, false); assert(/นอกพื้นที่/.test(r.reason));
  const gps = g.book['บันทึก GPS'].data; assert.strictEqual(gps[gps.length - 1][10], 'ปฏิเสธ');
});
t('poor accuracy is refused', () => {
  assert.strictEqual(g.api('punch', { kind: 'in', lat: 16.5, lng: 103.5, acc: 500 }, staff).data.ok, false);
});
t('out before in is refused', () => {
  assert.strictEqual(g.api('punch', { kind: 'out', lat: 16.5, lng: 103.5, acc: 10 }, staff).data.ok, false);
});
t('punch inside radius writes the log once', () => {
  const r = g.api('punch', { kind: 'in', lat: 16.5004, lng: 103.5, acc: 15 }, staff).data;
  assert.strictEqual(r.ok, true); assert(r.meters < 60); assert.strictEqual(r.log.via, 'gps');
  assert.strictEqual(g.api('punch', { kind: 'in', lat: 16.5, lng: 103.5, acc: 15 }, staff).data.ok, false, 'second in refused');
  const out = g.api('punch', { kind: 'out', lat: 16.5, lng: 103.5, acc: 15 }, staff).data;
  assert.strictEqual(out.ok, true); assert(out.log.in && out.log.out);
  const docs = g.api('pull', {}, staff).data.docs.filter((d) => d.path === r.path);
  assert.strictEqual(docs.length, 1);
});
t('logout ends the session', () => {
  g.api('logout', {}, staff);
  assert.strictEqual(g.api('pull', {}, staff).code, 'auth');
});
console.log(n + ' tests passed');
