// ทดสอบหน้าเว็บกับ Code.gs จำลอง: node tests/ui.test.js  (ต้องมี playwright)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { load } = require('./gas-mock');
const ROOT = path.join(__dirname, '..');
const API = 'https://script.google.com/macros/s/TEST_ID/exec';
const SHOTS = process.env.SHOTS || '';

(async () => {
  const g = load(); g.setup();
  g.book['ผู้ใช้'].appendRow(['S01', 'ผู้ดูแลสมมติ', '1234', 'admin', true]);
  g.book['ผู้ใช้'].appendRow(['S02', 'เจ้าหน้าที่สมมติ', '5678', 'staff', true]);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ geolocation: { latitude: 16.5, longitude: 103.5, accuracy: 12 }, permissions: ['geolocation'], viewport: { width: 1100, height: 900 } });
  await ctx.route('https://app.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    if (p === 'config.js') return route.fulfill({ contentType: 'text/javascript', body: `window.HR_CONFIG={apiUrl:${JSON.stringify(API)},pollSeconds:30};` });
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ contentType: p.endsWith('.js') ? 'text/javascript' : 'text/html', body: fs.readFileSync(f) });
  });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route(API, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(g.post(route.request().postData())) }));
  const errors = [];
  async function open() {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('https://app.test/index.html');
    return page;
  }
  async function login(page, id, pin) {
    await page.waitForSelector('#hrId option[value="' + id + '"]', { state: 'attached' });
    await page.selectOption('#hrId', id); await page.fill('#hrPin', pin); await page.click('#hrGo');
    await page.waitForSelector('#hrLogin', { state: 'hidden' });
  }
  const shot = async (page, n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png') }); };

  // admin sets location
  let page = await open();
  await shot(page, 'login');
  await login(page, 'S01', '1234');
  await page.waitForSelector('.card');
  assert.strictEqual(await page.locator('.card').count(), 2, 'both staff auto-created');
  await page.goto('https://app.test/index.html#setup');
  await page.click('[data-act="setGeo"]');
  await page.waitForFunction(() => /ตั้งพิกัดแล้ว/.test(document.body.textContent));
  await shot(page, 'setup');
  await page.close();

  // staff punches in with GPS
  page = await open();
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await login(page, 'S02', '5678');
  await page.waitForSelector('.card');
  assert.strictEqual(await page.locator('[data-act="punch"][data-kind="in"]').count(), 1, 'only own card has buttons');
  await page.click('[data-act="punch"][data-kind="in"]');
  await page.waitForSelector('#punchGo:not([disabled])');
  await page.click('#punchGo');
  await page.waitForFunction(() => /ลงเวลาเข้า .* แล้ว/.test(document.querySelector('#toast').textContent));
  await shot(page, 'punched');
  const gps = g.book['บันทึก GPS'].data; assert.strictEqual(gps[gps.length - 1][10], 'สำเร็จ');
  // staff cannot see evals
  await page.goto('https://app.test/index.html#eval');
  await page.waitForFunction(() => /เฉพาะผู้ดูแลระบบ/.test(document.querySelector('#view').textContent));
  // leave request
  await page.goto('https://app.test/index.html#leave');
  await page.waitForTimeout(300);
  await shot(page, 'leave');
  // far away punch-out is refused
  await ctx.setGeolocation({ latitude: 16.6, longitude: 103.5, accuracy: 12 });
  await page.goto('https://app.test/index.html#today');
  await page.click('[data-act="punch"][data-kind="out"]');
  await page.waitForSelector('#punchGo:not([disabled])');
  await page.click('#punchGo');
  await page.waitForFunction(() => /นอกพื้นที่/.test(document.querySelector('#gpsInfo').textContent));
  await shot(page, 'refused');
  // phone layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-act="cancel"]');
  await page.waitForTimeout(200);
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!over, 'no horizontal scroll on phone');
  await shot(page, 'phone');
  await page.click('[data-act="logout"]');
  await page.waitForSelector('#hrLogin:not([hidden]) #hrId');
  await page.close();
  await browser.close();
  assert.deepStrictEqual(errors, []);
  console.log('ui tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
