/* ตัวเชื่อมหน้าเว็บกับ Apps Script
 * จำลอง API แบบ window.claude.use("db" | "user" | "downloads") ที่แอปเดิมใช้ เพื่อให้โค้ดหน้าจอแทบไม่ต้องแก้
 * ข้อมูลทั้งหมดดึงมาเก็บในหน่วยความจำ แล้วดึงเฉพาะส่วนที่เปลี่ยนทุก pollSeconds วินาที
 */
(function () {
  "use strict";
  var CFG = window.HR_CONFIG || {};
  var URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  var TOKEN_KEY = "hr.token", USER_KEY = "hr.user";
  var store = new Map();          // path -> data
  var listeners = new Set();      // functions re-run after every change
  var since = "", me = null, token = null, pollTimer = null, pulling = null;

  function sget(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function sset(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} }

  function apiErr(msg, code) { var e = new Error(msg); e.code = code || "error"; return e; }
  async function call(action, params) {
    var url = String(CFG.apiUrl || "").trim();
    if (!URL_RE.test(url)) throw apiErr("ยังไม่ได้ตั้งค่า API ใน config.js", "config");
    var ctrl = new AbortController(), t = setTimeout(function () { ctrl.abort(); }, 60000), res;
    try {
      res = await fetch(url, { method: "POST", credentials: "omit", redirect: "follow", signal: ctrl.signal,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ action: action, token: token, params: params || {} }) });
    } catch (e) {
      throw apiErr(e.name === "AbortError" ? "เชื่อมต่อนานเกินไป ลองใหม่อีกครั้ง" : "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ต", "network");
    } finally { clearTimeout(t); }
    var body; try { body = JSON.parse(await res.text()); } catch (_) { throw apiErr("เซิร์ฟเวอร์ไม่ได้ตอบเป็น JSON ตรวจ URL ใน config.js", "config"); }
    if (!body || body.ok !== true) {
      var err = apiErr((body && body.error) || "ทำรายการไม่สำเร็จ", body && body.code);
      if (err.code === "auth") { signOut(true); }
      throw err;
    }
    return body.data;
  }

  /* ---------- sync ---------- */
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.warn(e); } }); }
  function applyDocs(docs) {
    docs.forEach(function (d) { if (d.deleted) store.delete(d.path); else store.set(d.path, d.data); });
  }
  async function pull() {
    if (pulling) return pulling;
    pulling = (async function () {
      try {
        // ย้อนกลับ 5 วินาทีกันพลาดข้อมูลที่บันทึกพร้อมกัน (ข้อมูลซ้ำทับกันได้ไม่เป็นไร)
        var s = since ? new Date(new Date(since).getTime() - 5000).toISOString() : "";
        var r = await call("pull", { since: s });
        if (!since) store.clear();
        applyDocs(r.docs); since = r.now;
        if (r.me) { me = r.me; sset(USER_KEY, JSON.stringify(me)); }
        notify();
      } finally { pulling = null; }
    })();
    return pulling;
  }
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () { if (!document.hidden) pull().catch(function (e) { console.warn(e); }); }, Math.max(10, Number(CFG.pollSeconds) || 30) * 1000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && token) pull().catch(function () {}); });
  }

  /* ---------- Firestore-like facade ---------- */
  function snapDoc(path) {
    var data = store.get(path);
    return { id: path.split("/").slice(1).join("/"), exists: data !== undefined, data: function () { return data === undefined ? undefined : JSON.parse(JSON.stringify(data)); } };
  }
  function query(col, conds) {
    function run() {
      var docs = [];
      store.forEach(function (v, p) {
        if (p.split("/")[0] !== col) return;
        for (var i = 0; i < conds.length; i++) {
          var c = conds[i], x = v[c[0]];
          if (c[1] === "==" && !(x === c[2])) return;
          if (c[1] === ">=" && !(x >= c[2])) return;
          if (c[1] === "<=" && !(x <= c[2])) return;
          if (c[1] === ">" && !(x > c[2])) return;
          if (c[1] === "<" && !(x < c[2])) return;
        }
        docs.push(snapDoc(p));
      });
      return { docs: docs, size: docs.length, empty: !docs.length };
    }
    return {
      where: function (f, op, v) { return query(col, conds.concat([[f, op, v]])); },
      get: async function () { return run(); },
      onSnapshot: function (cb) { var fn = function () { cb(run()); }; listeners.add(fn); setTimeout(fn, 0); return function () { listeners.delete(fn); }; }
    };
  }
  function docRef(path) {
    return {
      get: async function () { return snapDoc(path); },
      onSnapshot: function (cb) { var fn = function () { cb(snapDoc(path)); }; listeners.add(fn); setTimeout(fn, 0); return function () { listeners.delete(fn); }; },
      set: async function (body) {
        var prev = store.get(path), clean = JSON.parse(JSON.stringify(body));
        store.set(path, clean); notify();
        try { await call("set", { path: path, data: clean }); }
        catch (e) { if (prev === undefined) store.delete(path); else store.set(path, prev); notify(); throw writeErr(e); }
      },
      delete: async function () {
        var prev = store.get(path); store.delete(path); notify();
        try { await call("del", { path: path }); }
        catch (e) { if (prev !== undefined) store.set(path, prev); notify(); throw writeErr(e); }
      }
    };
  }
  function writeErr(e) { if (e.code === "forbidden") window.HR.toast && window.HR.toast(e.message); return e; }
  var db = { collection: function (c) { return query(c, []); }, doc: docRef };

  var userApi = {
    id: async function () { return me && me.id; },
    name: async function () { return me && me.name; },
    canEdit: async function () { return !!(me && me.role === "admin"); },
    can: async function () { return true; }
  };
  var downloads = {
    save: async function (o) {
      var a = document.createElement("a"), u = URL.createObjectURL(o.data);
      a.href = u; a.download = o.filename || "download"; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1000);
    }
  };

  /* ---------- login screen ---------- */
  var readyResolve, ready = new Promise(function (r) { readyResolve = r; });
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function overlay() {
    var o = document.getElementById("hrLogin");
    if (!o) { o = document.createElement("div"); o.id = "hrLogin"; o.className = "login"; document.body.appendChild(o); }
    o.hidden = false; return o;
  }
  async function showLogin(msg) {
    var o = overlay();
    if (!URL_RE.test(String(CFG.apiUrl || "").trim())) {
      o.innerHTML = '<div class="login-card"><h2>ยังไม่ได้เชื่อมกับ Google Sheets</h2><p class="muted">ผู้ดูแลต้องใส่ URL ของ Apps Script ในไฟล์ <b>hr/config.js</b> ตามคู่มือติดตั้งก่อน</p><div class="acts"><button class="primary" data-hr="demo">ดูตัวอย่างการใช้งาน</button></div></div>';
      return;
    }
    o.innerHTML = '<div class="login-card"><h2>เข้าสู่ระบบ</h2><p class="muted">กำลังโหลดรายชื่อ…</p></div>';
    var list;
    try { list = (await call("roster")).users; }
    catch (e) { o.innerHTML = '<div class="login-card"><h2>เชื่อมต่อไม่ได้</h2><p class="muted">' + esc(e.message) + '</p><div class="acts"><button data-hr="demo">ดูตัวอย่าง</button><button class="primary" data-hr="retry">ลองใหม่</button></div></div>'; return; }
    var last = sget("hr.lastId") || "";
    var logo = document.querySelector("img.logo"), unit = document.getElementById("unitName");
    o.innerHTML = '<form class="login-card" id="hrForm"><div class="login-head">' + (logo ? '<img src="' + logo.src + '" alt="">' : "") +
      '<div><div class="muted">ระบบบุคลากรและลงเวลา</div><h2>' + esc(unit ? unit.textContent : "") + '</h2></div></div>' +
      '<label class="f">ชื่อ<select id="hrId" required><option value="">— เลือกชื่อของคุณ —</option>' +
      list.map(function (u) { return '<option value="' + esc(u.id) + '"' + (u.id === last ? " selected" : "") + ">" + esc(u.name) + "</option>"; }).join("") +
      '</select></label><label class="f">PIN<input id="hrPin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4,6}" maxlength="6" required></label>' +
      '<p class="login-msg" id="hrMsg" role="alert">' + esc(msg || "") + '</p>' +
      '<div class="acts"><button type="button" class="ghost" data-hr="demo">ดูตัวอย่าง</button><button class="primary" type="submit" id="hrGo">เข้าสู่ระบบ</button></div>' +
      (list.length ? "" : '<p class="muted">ยังไม่มีรายชื่อในชีต ผู้ใช้</p>') + '</form>';
    var f = document.getElementById("hrForm");
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var id = document.getElementById("hrId").value, pin = document.getElementById("hrPin").value, m = document.getElementById("hrMsg"), b = document.getElementById("hrGo");
      b.disabled = true; m.textContent = "กำลังตรวจสอบ…";
      try {
        var r = await call("login", { id: id, pin: pin });
        token = r.token; me = r.user; sset(TOKEN_KEY, token); sset(USER_KEY, JSON.stringify(me)); sset("hr.lastId", id);
        await afterLogin();
      } catch (err) { m.textContent = err.message; b.disabled = false; }
    });
    setTimeout(function () { var el = document.getElementById(last ? "hrPin" : "hrId"); if (el) el.focus(); }, 0);
  }
  async function afterLogin() {
    var o = document.getElementById("hrLogin");
    try { since = ""; await pull(); }
    catch (e) { if (e.code !== "auth") showLogin(e.message); return; }
    if (o) o.hidden = true;
    startPolling(); readyResolve(db);
  }
  function signOut(expired) {
    token = null; me = null; since = ""; sset(TOKEN_KEY, null); sset(USER_KEY, null); clearInterval(pollTimer);
    if (expired) { store.clear(); notify(); showLogin("หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่"); }
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-hr]"); if (!b) return;
    var a = b.dataset.hr;
    if (a === "retry") showLogin();
    if (a === "demo") { var o = document.getElementById("hrLogin"); if (o) o.hidden = true; window.HR.onDemo && window.HR.onDemo(); }
    if (a === "login") showLogin();
  });

  /* ---------- public ---------- */
  window.HR = {
    call: call, pull: pull, me: function () { return me; },
    logout: async function () { try { await call("logout"); } catch (_) {} signOut(false); location.reload(); },
    login: showLogin, toast: null, onDemo: null,
    punch: async function (kind, pos) {
      var r = await call("punch", { kind: kind, lat: pos && pos.lat, lng: pos && pos.lng, acc: pos && pos.acc });
      if (r.ok && r.path) { store.set(r.path, r.log); notify(); }
      return r;
    },
    geo: function () { return call("geo"); },
    applyDoc: function (path, data) { if (data == null) store.delete(path); else store.set(path, data); notify(); },
    setGeo: function (p) { return call("setGeo", p); }
  };
  window.claude = {
    use: function (name) {
      if (name === "db") return ready;
      if (name === "user") return ready.then(function () { return userApi; });
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.reject(apiErr("ไม่มีความสามารถนี้", "unavailable"));
    }
  };

  function boot() {
    token = sget(TOKEN_KEY);
    try { me = JSON.parse(sget(USER_KEY) || "null"); } catch (_) { me = null; }
    if (token && URL_RE.test(String(CFG.apiUrl || "").trim())) afterLogin(); else showLogin();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
