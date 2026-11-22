'use strict';
/* ====================================================================
   AQUATIC: сайт + сервер аккаунтов.
   Только встроенные модули Node.js, ничего устанавливать не нужно.
   Запуск: node server.js
   ==================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней

/* ---------------- конфиг ---------------- */
function loadConfig() {
  const def = { port: 3000, host: '0.0.0.0', adminNick: 'SHADOW', adminPassword: '' };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return Object.assign(def, raw);
  } catch (e) {
    return def;
  }
}
const config = loadConfig();
const PORT = Number(process.env.PORT || config.port) || 3000;
const HOST = process.env.HOST || config.host || '0.0.0.0';

/* ---------------- хранилище (JSON-файл) ---------------- */
let db = { users: {}, roles: [], sessions: {} };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.users = parsed.users || {};
    db.roles = parsed.roles || [];
    db.sessions = parsed.sessions || {};
  } catch (e) { /* первый запуск */ }

  const builtins = [
    { id: 'player', name: 'Игрок', color: '#8FA3BC', builtin: true },
    { id: 'admin', name: 'Админ', color: '#FF5D5D', builtin: true }
  ];
  builtins.forEach(function (b) {
    const existing = db.roles.find(function (r) { return r.id === b.id; });
    if (!existing) db.roles.unshift(b);
    else existing.builtin = true;
  });

  const now = Date.now();
  Object.keys(db.sessions).forEach(function (k) {
    if (db.sessions[k].exp < now) delete db.sessions[k];
  });
}

function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------------- пароли ---------------- */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return salt.toString('hex') + ':' + key.toString('hex');
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const salt = Buffer.from(parts[0], 'hex');
  const expected = Buffer.from(parts[1], 'hex');
  const key = await scrypt(password, salt, 64);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
const DUMMY_HASH = '00000000000000000000000000000000:' + '00'.repeat(64);

/* ---------------- админ SHADOW ---------------- */
async function ensureAdmin() {
  const nick = String(config.adminNick || 'SHADOW');
  const key = nick.toLowerCase();
  let u = db.users[key];
  let changed = false;

  if (!u) {
    u = db.users[key] = {
      nick: nick,
      email: '',
      hash: '',
      roleId: 'admin',
      owner: true,
      created: Date.now()
    };
    changed = true;
  }
  if (!u.owner || u.roleId !== 'admin') { u.owner = true; u.roleId = 'admin'; changed = true; }

  const pw = String(config.adminPassword || '');
  if (pw) {
    const same = u.hash ? await verifyPassword(pw, u.hash) : false;
    if (!same) { u.hash = await hashPassword(pw); changed = true; db.sessions = {}; }
  } else if (!u.hash) {
    console.warn('! Для админа ' + nick + ' не задан пароль. Впишите adminPassword в config.json и перезапустите сервер.');
  }
  if (changed) saveDb();
  console.log('Админ ' + nick + ' готов.');
}

/* ---------------- утилиты ---------------- */
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function roleOf(id) {
  return db.roles.find(function (r) { return r.id === id; }) || db.roles[0];
}
function isAdminUser(u) { return !!u && (u.owner === true || u.roleId === 'admin'); }
function publicUser(u, withMail) {
  const r = roleOf(u.roleId);
  const out = {
    nick: u.nick,
    role: { id: r.id, name: r.name, color: r.color },
    isAdmin: isAdminUser(u),
    isOwner: u.owner === true
  };
  if (withMail) out.email = u.email;
  return out;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(data);
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > 10 * 1024) { reject(new HttpError(413, 'Слишком большой запрос.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch (e) { reject(new HttpError(400, 'Некорректные данные.')); }
    });
    req.on('error', reject);
  });
}

/* ограничение частоты запросов */
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const key = bucket + ':' + ip;
  const now = Date.now();
  const list = (hits.get(key) || []).filter(function (t) { return now - t < windowMs; });
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}
setInterval(function () {
  const now = Date.now();
  hits.forEach(function (list, k) {
    const fresh = list.filter(function (t) { return now - t < 15 * 60 * 1000; });
    if (fresh.length) hits.set(k, fresh); else hits.delete(k);
  });
}, 5 * 60 * 1000).unref();

/* сессии */
function createSession(u) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha256(token)] = { nick: u.nick.toLowerCase(), exp: Date.now() + SESSION_TTL };
  saveDb();
  return token;
}
function authUser(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer ([a-f0-9]{64})$/.exec(h);
  if (!m) return null;
  const s = db.sessions[sha256(m[1])];
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.nick] || null;
}
function requireUser(req) {
  const u = authUser(req);
  if (!u) throw new HttpError(401, 'Войдите в аккаунт.');
  return u;
}
function requireAdmin(req) {
  const u = requireUser(req);
  if (!isAdminUser(u)) throw new HttpError(403, 'Нужны права администратора.');
  return u;
}

/* ---------------- API ---------------- */
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'unknown';
  const method = req.method;
  const p = url.pathname;

  /* --- регистрация --- */
  if (method === 'POST' && p === '/api/register') {
    if (limited(ip, 'reg', 8, 10 * 60 * 1000)) throw new HttpError(429, 'Слишком много попыток. Подождите немного.');
    const b = await readJson(req);
    const nick = String(b.nick || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!NICK_RE.test(nick)) throw new HttpError(400, 'Ник: от 3 до 16 символов, только латиница, цифры и _.');
    if (!MAIL_RE.test(email) || email.length > 100) throw new HttpError(400, 'Проверьте адрес почты.');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Пароль должен быть от 8 до 128 символов.');
    if (db.users[nick.toLowerCase()]) throw new HttpError(409, 'Этот ник уже занят.');
    const mailTaken = Object.keys(db.users).some(function (k) { return db.users[k].email === email; });
    if (mailTaken) throw new HttpError(409, 'Эта почта уже используется.');

    const u = db.users[nick.toLowerCase()] = {
      nick: nick, email: email, hash: await hashPassword(password),
      roleId: 'player', owner: false, created: Date.now()
    };
    const token = createSession(u);
    return send(res, 201, { token: token, user: publicUser(u, true) });
  }

  /* --- вход --- */
  if (method === 'POST' && p === '/api/login') {
    if (limited(ip, 'login', 10, 10 * 60 * 1000)) throw new HttpError(429, 'Слишком много попыток входа. Подождите несколько минут.');
    const b = await readJson(req);
    const login = String(b.login || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!login || !password) throw new HttpError(400, 'Введите ник и пароль.');
    let u = db.users[login];
    if (!u) {
      u = Object.keys(db.users).map(function (k) { return db.users[k]; })
        .find(function (x) { return x.email && x.email === login; });
    }
    const ok = await verifyPassword(password, u && u.hash ? u.hash : DUMMY_HASH);
    if (!u || !u.hash || !ok) throw new HttpError(401, 'Неверный ник или пароль.');
    const token = createSession(u);
    return send(res, 200, { token: token, user: publicUser(u, true) });
  }

  /* --- выход --- */
  if (method === 'POST' && p === '/api/logout') {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer ([a-f0-9]{64})$/.exec(h);
    if (m) { delete db.sessions[sha256(m[1])]; saveDb(); }
    return send(res, 200, { ok: true });
  }

  /* --- мой профиль --- */
  if (method === 'GET' && p === '/api/me') {
    const u = requireUser(req);
    return send(res, 200, { user: publicUser(u, true) });
  }

  /* ================= админка ================= */
  if (p.indexOf('/api/admin/') === 0) {
    const actor = requireAdmin(req);

    /* список игроков */
    if (method === 'GET' && p === '/api/admin/users') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const list = Object.keys(db.users).map(function (k) { return db.users[k]; })
        .filter(function (u) { return !q || u.nick.toLowerCase().indexOf(q) !== -1 || (u.email || '').indexOf(q) !== -1; })
        .sort(function (a, b) { return b.created - a.created; })
        .slice(0, 500)
        .map(function (u) {
          return { nick: u.nick, email: u.email, roleId: u.roleId, owner: u.owner === true, created: u.created };
        });
      return send(res, 200, { users: list, canGrantAdmin: actor.owner === true });
    }

    /* список привилегий */
    if (method === 'GET' && p === '/api/admin/roles') {
      return send(res, 200, { roles: db.roles, canGrantAdmin: actor.owner === true });
    }

    /* создать привилегию */
    if (method === 'POST' && p === '/api/admin/roles') {
      const b = await readJson(req);
      const name = String(b.name || '').trim();
      const color = String(b.color || '').trim();
      if (name.length < 2 || name.length > 20) throw new HttpError(400, 'Название: от 2 до 20 символов.');
      if (!COLOR_RE.test(color)) throw new HttpError(400, 'Цвет должен быть в формате #RRGGBB.');
      if (db.roles.length >= 30) throw new HttpError(400, 'Достигнут лимит привилегий (30).');
      if (db.roles.some(function (r) { return r.name.toLowerCase() === name.toLowerCase(); })) {
        throw new HttpError(409, 'Привилегия с таким названием уже есть.');
      }
      const role = { id: 'r_' + crypto.randomBytes(4).toString('hex'), name: name, color: color.toUpperCase(), builtin: false };
      db.roles.push(role);
      saveDb();
      return send(res, 201, { role: role });
    }

    /* изменить / удалить привилегию */
    let m = /^\/api\/admin\/roles\/([A-Za-z0-9_]+)$/.exec(p);
    if (m) {
      const role = db.roles.find(function (r) { return r.id === m[1]; });
      if (!role) throw new HttpError(404, 'Привилегия не найдена.');

      if (method === 'PATCH') {
        const b = await readJson(req);
        if (b.color !== undefined) {
          if (!COLOR_RE.test(String(b.color))) throw new HttpError(400, 'Цвет должен быть в формате #RRGGBB.');
          role.color = String(b.color).toUpperCase();
        }
        if (b.name !== undefined) {
          if (role.builtin) throw new HttpError(400, 'Название встроенной привилегии менять нельзя.');
          const name = String(b.name).trim();
          if (name.length < 2 || name.length > 20) throw new HttpError(400, 'Название: от 2 до 20 символов.');
          const dup = db.roles.some(function (r) { return r.id !== role.id && r.name.toLowerCase() === name.toLowerCase(); });
          if (dup) throw new HttpError(409, 'Привилегия с таким названием уже есть.');
          role.name = name;
        }
        saveDb();
        return send(res, 200, { role: role });
      }

      if (method === 'DELETE') {
        if (role.builtin) throw new HttpError(400, 'Встроенную привилегию удалить нельзя.');
        Object.keys(db.users).forEach(function (k) {
          if (db.users[k].roleId === role.id) db.users[k].roleId = 'player';
        });
        db.roles = db.roles.filter(function (r) { return r.id !== role.id; });
        saveDb();
        return send(res, 200, { ok: true });
      }
    }

    /* выдать привилегию игроку */
    m = /^\/api\/admin\/users\/([A-Za-z0-9_]{3,16})\/role$/.exec(p);
    if (method === 'POST' && m) {
      const b = await readJson(req);
      const target = db.users[m[1].toLowerCase()];
      if (!target) throw new HttpError(404, 'Игрок не найден.');
      if (target.owner) throw new HttpError(403, 'Привилегию владельца менять нельзя.');
      const role = db.roles.find(function (r) { return r.id === String(b.roleId || ''); });
      if (!role) throw new HttpError(400, 'Такой привилегии нет.');
      const touchesAdmin = role.id === 'admin' || target.roleId === 'admin';
      if (touchesAdmin && !actor.owner) {
        throw new HttpError(403, 'Выдавать и снимать роль «Админ» может только владелец.');
      }
      target.roleId = role.id;
      saveDb();
      return send(res, 200, { ok: true, nick: target.nick, role: { id: role.id, name: role.name, color: role.color } });
    }

    throw new HttpError(404, 'Не найдено.');
  }

  throw new HttpError(404, 'Не найдено.');
}

/* ---------------- статические файлы ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { message: 'Метод не поддерживается.' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, { message: 'Некорректный адрес.' }); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file.indexOf(PUBLIC + path.sep) !== 0) return send(res, 403, { message: 'Доступ запрещён.' });

  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY));
      return res.end('Страница не найдена');
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, Object.assign({
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': ['.html', '.css', '.js'].indexOf(path.extname(file)) !== -1 ? 'no-cache' : 'public, max-age=3600'
    }, SECURITY));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- сервер ---------------- */
const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.indexOf('/api/') === 0) {
      Object.keys(SECURITY).forEach(function (k) { res.setHeader(k, SECURITY[k]); });
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { message: err.message });
    console.error(err);
    send(res, 500, { message: 'Ошибка сервера. Попробуйте позже.' });
  }
});

loadDb();
ensureAdmin().then(function () {
  server.listen(PORT, HOST, function () {
    console.log('AQUATIC запущен: http://localhost:' + PORT);
  });
}).catch(function (e) {
  console.error('Не удалось запустить сервер:', e);
  process.exit(1);
});
