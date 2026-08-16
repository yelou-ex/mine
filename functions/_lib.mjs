/**
 * _lib.js — Cloudflare Pages Functions 共享工具库
 * 运行环境：Workers 运行时（标准 Web API，无任何 Node 依赖）
 * 职责：
 *   - D1 数据库 schema 初始化（幂等）与默认管理员
 *   - PBKDF2 密码哈希（Web Crypto，替代 bcrypt——免费版 Workers CPU 限制 10ms）
 *   - 无状态签名会话（HMAC-SHA256 Cookie）+ CSRF 双提交 Cookie
 *   - 文章字段校验、XSS 白名单过滤、防暴力破解、防重复提交
 */
export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟
export const MAX_FAILED_ATTEMPTS = 5; // 连续失败次数
export const LOCK_MS = 15 * 60 * 1000; // 锁定 15 分钟
export const DUP_SUBMIT_WINDOW_MS = 5 * 1000; // 防重复提交窗口
export const ALLOWED_CATEGORIES = ['博客', '学习笔记', '生活感悟'];
export const MAX_TITLE_LEN = 100;
export const MAX_CONTENT_LEN = 50000;
export const MAX_TAG_COUNT = 5;
export const MAX_TAG_LEN = 20;
export const TAG_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/;
export const PBKDF2_ITERATIONS = 60000; // 免费版 Workers CPU 限制下取 6 万次
export const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

/* ================= 基础工具 ================= */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

export function toB64(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

export function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 常数时间比较（替代 timingSafeEqual） */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ================= 密码哈希（PBKDF2，Web Crypto） ================= */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = Number(parts[1]);
    const salt = fromB64(parts[2]);
    const expect = fromB64(parts[3]);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        key,
        expect.length * 8
      )
    );
    return safeEqual(bits, expect);
  } catch {
    return false;
  }
}

/* ================= 签名会话（无状态 HMAC Cookie，Web Crypto） ================= */
function getSecret(env) {
  if (env && env.SESSION_SECRET) return env.SESSION_SECRET;
  // 未配置环境变量时使用模块级随机密钥（每次实例重启后旧会话失效，仅作兜底）
  return 'personal-website-dev-fallback-secret';
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return toB64(sig);
}

export async function createSessionToken(adminId, username, env) {
  const payload = btoa(JSON.stringify({ adminId, username, exp: Date.now() + SESSION_TTL_MS }));
  const sig = await hmacSign(payload, getSecret(env));
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token, env) {
  try {
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return null;
    const expect = await hmacSign(payload, getSecret(env));
    if (!safeEqual(new Uint8Array(fromB64(sig)), new Uint8Array(fromB64(expect)))) return null;
    const data = JSON.parse(atob(payload));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function makeCookie(name, value, { httpOnly = false, maxAgeSec = SESSION_TTL_MS / 1000, isSecure = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  parts.push(maxAgeSec > 0 ? `Max-Age=${Math.floor(maxAgeSec)}` : 'Max-Age=0');
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

export async function getAdminSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  if (!cookies.sid) return null;
  return verifySessionToken(cookies.sid, env);
}

export function getCsrfCookie(request) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  return cookies.csrf || '';
}

/* ================= XSS 白名单过滤（轻量，服务端第一道） ================= */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'del', 's',
  'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
]);
const ALLOWED_ATTRS = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title']),
};

function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sanitizeHtml(input) {
  let html = String(input == null ? '' : input);
  // 1. 删除危险元素及其内容
  html = html.replace(/<(script|iframe|object|embed|style|link|meta|form|input|button|textarea|select)[\s\S]*?<\/\1\s*>/gi, '');
  // 2. 删除自闭合危险元素
  html = html.replace(/<(script|iframe|object|embed|link|meta|input)\b[^>]*\/?>/gi, '');
  // 3. 逐个标签白名单过滤
  html = html.replace(/<(\/?) *([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (whole, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return ''; // 非白名单标签删除（保留文本内容）
    if (close) return `</${t}>`;
    const allowed = ALLOWED_ATTRS[t] || new Set();
    let out = '';
    const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m;
    while ((m = attrRe.exec(attrs))) {
      const name = m[1].toLowerCase();
      const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] || '';
      if (name.startsWith('on')) continue; // 事件属性
      if (name === 'style') continue;
      if (!allowed.has(name)) continue;
      const lv = val.trim().toLowerCase();
      if ((name === 'href' || name === 'src') && (lv.startsWith('javascript:') || lv.startsWith('data:'))) continue;
      if (name === 'href' && !/^(#|mailto:|https?:)/.test(lv) && !lv.startsWith('/')) continue;
      if (name === 'src' && !/^(https?:|\/)/.test(lv)) continue;
      out += ` ${name}="${escapeAttr(val)}"`;
    }
    return /\/\s*$/.test(whole) ? `<${t}${out} />` : `<${t}${out}>`;
  });
  return html;
}

/* ================= 文章字段校验（与 Express 版规则一致） ================= */
export function validateArticle(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const rawContent = typeof body.content === 'string' ? body.content : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const rawTags = typeof body.tags === 'string' ? body.tags : '';

  if (!title) return { error: '标题不能为空' };
  if (title.length > MAX_TITLE_LEN) return { error: `标题不能超过 ${MAX_TITLE_LEN} 个字符` };
  if (!ALLOWED_CATEGORIES.includes(category)) return { error: '请选择有效类别' };

  const content = sanitizeHtml(rawContent);
  const textOnly = content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (!textOnly) return { error: '内容不能为空' };
  if (content.length > MAX_CONTENT_LEN) return { error: `内容不能超过 ${MAX_CONTENT_LEN} 个字符` };

  let tags = [];
  if (rawTags.trim()) {
    tags = rawTags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    if (tags.length > MAX_TAG_COUNT) return { error: `标签最多 ${MAX_TAG_COUNT} 个` };
    for (const t of tags) {
      if (t.length > MAX_TAG_LEN) return { error: `单个标签不能超过 ${MAX_TAG_LEN} 个字符` };
      if (!TAG_PATTERN.test(t)) return { error: '标签仅允许中文/英文/数字/下划线/连字符' };
    }
    tags = [...new Set(tags)];
  }
  return { value: { title, content, category, tags: tags.join(',') } };
}

/* ================= D1 Schema 初始化（幂等） ================= */
const SEED_ARTICLES = [
  {
    title: '个人基本信息',
    category: '博客',
    tags: '',
    link: 'introduce.html',
    created_at: '2023-10-15 00:00:00',
    content:
      '<p>欢迎来到我的个人博客！我叫杨楼，在这里我将分享我的生活、学习和工作中的点点滴滴。无论你是我的朋友、同学、老师，还是偶然路过的访客，都希望这里的内容能够给你带来帮助或启发。</p>' +
      '<p>我会在这里记录我的成长历程，分享有用的知识和经验。如果你对某些内容感兴趣，或者有任何问题或建议，欢迎随时联系我！</p>',
  },
  {
    title: '我的学习之路',
    category: '博客',
    tags: '',
    link: 'myway.html',
    created_at: '2023-10-10 00:00:00',
    content:
      '<p>这部分记录了我的部分成长经历。</p>' +
      '<p>在这里，我将分享我的成长曲线、兴趣分布图等。如果你有任何问题或建议，我很乐意与你交流！</p>',
  },
  {
    title: '一路所获',
    category: '博客',
    tags: '',
    link: 'honor.html',
    created_at: '2023-10-05 00:00:00',
    content: '<p>这里是一些我曾经获得的荣誉。</p>',
  },
];

export async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      success INTEGER NOT NULL,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
      username TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS recent_submits (
      fingerprint TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )`),
  ]);
  // 迁移：为旧库补 link 列，并为 3 篇种子文章设置指向原有静态页面的链接
  const artCols = await env.DB.prepare('PRAGMA table_info(articles)').all();
  if (!artCols.results.some((c) => c.name === 'link')) {
    await env.DB.prepare("ALTER TABLE articles ADD COLUMN link TEXT NOT NULL DEFAULT ''").run();
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE articles SET link = 'introduce.html' WHERE title = '个人基本信息' AND link = ''"),
    env.DB.prepare("UPDATE articles SET link = 'myway.html' WHERE title = '我的学习之路' AND link = ''"),
    env.DB.prepare("UPDATE articles SET link = 'honor.html' WHERE title = '一路所获' AND link = ''"),
  ]);
  // 默认管理员（幂等）
  const admin = await env.DB.prepare('SELECT id FROM admins WHERE username = ?').bind(DEFAULT_ADMIN.username).first();
  if (!admin) {
    const hash = await hashPassword(DEFAULT_ADMIN.password);
    await env.DB.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .bind(DEFAULT_ADMIN.username, hash)
      .run();
  }
  // 种子文章：仅首次（seeded 标记不存在时）且文章表为空时插入，删光后不复活
  const seeded = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'seeded'").first();
  if (!seeded) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM articles').first();
    if (count.c === 0) {
      const ins = env.DB.prepare(
        'INSERT INTO articles (title, content, category, tags, link, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      await env.DB.batch(SEED_ARTICLES.map((a) => ins.bind(a.title, a.content, a.category, a.tags, a.link, a.created_at)));
    }
    await env.DB.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', '1')").run();
  }
}

/* ================= 登录失败锁定 / 防重复提交（D1 持久化） ================= */
export async function logLogin(env, username, success, ip) {
  await env.DB.prepare('INSERT INTO login_logs (username, success, ip) VALUES (?, ?, ?)')
    .bind(username || '', success ? 1 : 0, ip || '')
    .run();
}

export async function checkLocked(env, username) {
  const row = await env.DB.prepare('SELECT failed_count, locked_until FROM login_attempts WHERE username = ?')
    .bind(username).first();
  if (row && row.locked_until && Date.now() < row.locked_until) return { locked: true, lockedUntil: row.locked_until };
  return { locked: false, count: row ? row.failed_count : 0 };
}

export async function recordLoginFailure(env, username) {
  const row = await env.DB.prepare('SELECT failed_count FROM login_attempts WHERE username = ?')
    .bind(username).first();
  const count = ((row && row.failed_count) || 0) + 1;
  if (count >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = Date.now() + LOCK_MS;
    await env.DB.prepare(
      'INSERT INTO login_attempts (username, failed_count, locked_until) VALUES (?, 0, ?) ' +
      'ON CONFLICT(username) DO UPDATE SET failed_count = 0, locked_until = ?'
    ).bind(username, lockedUntil, lockedUntil).run();
    return { lockedNow: true };
  }
  await env.DB.prepare(
    'INSERT INTO login_attempts (username, failed_count) VALUES (?, ?) ' +
    'ON CONFLICT(username) DO UPDATE SET failed_count = ?'
  ).bind(username, count, count).run();
  return { lockedNow: false };
}

export async function clearLoginFailures(env, username) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE username = ?').bind(username).run();
}

export async function isDuplicateSubmit(env, fingerprint) {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM recent_submits WHERE created_at < ?').bind(now - DUP_SUBMIT_WINDOW_MS).run();
  const row = await env.DB.prepare('SELECT created_at FROM recent_submits WHERE fingerprint = ?').bind(fingerprint).first();
  if (row && now - row.created_at < DUP_SUBMIT_WINDOW_MS) return true;
  await env.DB.prepare(
    'INSERT INTO recent_submits (fingerprint, created_at) VALUES (?, ?) ' +
    'ON CONFLICT(fingerprint) DO UPDATE SET created_at = ?'
  ).bind(fingerprint, now, now).run();
  return false;
}

export async function sha256Fingerprint(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toB64(digest);
}
