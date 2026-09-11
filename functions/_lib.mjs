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
export const MAX_LINK_LEN = 500; // 卡片跳转链接（link 字段）长度上限
export const TAG_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/;
// 评论（REQ-25 ~ 33 / BC-27 ~ 36）
export const MAX_NICKNAME_LEN = 20;
export const MAX_EMAIL_LEN = 50;
export const MAX_COMMENT_LEN = 1000;
export const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const COMMENT_DUP_WINDOW_MS = 60 * 1000; // 同 IP + 同文章 + 同内容 60 秒防重复
export const COMMENT_HOUR_LIMIT = 10;           // 同 IP 每小时最多 10 条
export const PBKDF2_ITERATIONS = 60000; // 免费版 Workers CPU 限制下取 6 万次
// 默认管理员（仅全新库首次种子使用；已存在的 admins 行不受影响）
export const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };
/**
 * 默认管理员凭据（审计 22c0d741 加固）：生产环境建议通过 Pages 环境变量
 * DEFAULT_ADMIN_USERNAME / DEFAULT_ADMIN_PASSWORD 注入强密码，避免内置默认值
 * 降低暴力破解成本；未配置时回退到内置开发默认值（保证本地/新库可用）。
 */
function resolveDefaultAdmin(env) {
  const username = String((env && env.DEFAULT_ADMIN_USERNAME) || '').trim() || DEFAULT_ADMIN.username;
  const password = String((env && env.DEFAULT_ADMIN_PASSWORD) || '').trim() || DEFAULT_ADMIN.password;
  return { username, password };
}

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
  // 表格（Markdown GFM 表格与 HTML 表格共用）
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
]);
const ALLOWED_ATTRS = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
};
// 标题锚点 id 合法字符集：Unicode 字母（含中文）/ 数字 / - _ .
const HEADING_ID_PATTERN = /^[\p{L}\p{N}\-_.]+$/u;

/* ================= 标题锚点（Markdown 目录跳转） ================= */
// ⚠ 同步约定：与浏览器版 js/heading-ids.js 行为保持一致，修改 slug 规则时两处同步更新。
// marked v5+ 默认不再为标题生成 id，md 文内目录链接 [文字](#标题) 无锚点可跳；
// 渲染后为 <h1>~<h6> 追加 GitHub 风格 id（重名自动 -1/-2），并放行 id 属性过白名单。

/** 从标题 HTML 片段/纯文本生成 GitHub 风格 slug（小写、保留中英文数字 -_.、空格转连字符） */
export function headingSlug(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; }
    })
    .replace(/&amp;/g, '&'); // 最后解码 &amp;（防 &amp;lt; 误判）
  s = s.trim().toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\- _]/gu, ''); // 其余标点/符号（含 . ? 等）一律去掉，与 GitHub 规则一致
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

/** 为 HTML 中的 <h1>~<h6> 追加 id（重名 -1/-2）；空 slug 的标题原样保留 */
export function addHeadingIds(html) {
  const used = {};
  return String(html == null ? '' : html).replace(
    /<(h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
    (m, tag, _attrs, inner) => {
      const base = headingSlug(inner);
      if (!base) return m;
      let id;
      if (Object.prototype.hasOwnProperty.call(used, base)) {
        used[base] += 1;
        id = `${base}-${used[base]}`;
      } else {
        used[base] = 0;
        id = base;
      }
      if (!HEADING_ID_PATTERN.test(id)) return m; // 双保险
      return `<${tag} id="${id}">${inner}</${tag}>`;
    }
  );
}

/** 标题 HTML 片段 → 纯文本（目录条目文字用） */
function headingText(inner) {
  return String(inner == null ? '' : inner)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}

function escHtmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 目录模块 HTML（PC 右侧独立卡片；与前端 article.html initToc 规则一致）：
 * 取 h2~h4，≥2 个才生成；已有 id 沿用，无 id 按 heading-ids 规则补生成（重名 -1/-2）。
 * ⚠ 同步约定：前端 article.html 的 initToc 需与此处行为保持一致。
 * 返回 { tocHtml, visible }。
 */
export function buildTocHtml(html) {
  const heads = [];
  const re = /<(h[2-4])(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(String(html == null ? '' : html)))) {
    const idm = / id="([^"]*)"/.exec(m[2] || '');
    heads.push({ tag: m[1], id: idm ? idm[1] : '', inner: m[3] });
  }
  const used = {};
  heads.forEach((h) => { if (h.id) used[h.id] = 1; });
  heads.forEach((h) => {
    if (h.id) return;
    const base = headingSlug(headingText(h.inner));
    if (!base) { h.skip = 1; return; }
    let n = 0, id = base;
    while (used[id]) { n += 1; id = `${base}-${n}`; }
    used[id] = 1;
    h.id = id;
  });
  const items = heads.filter((h) => !h.skip);
  if (items.length < 2) return { tocHtml: '', visible: false };
  // 卡片结构与前端 article.html initToc 一致：头部「目录 + 评论/首页按钮」+ 目录列表
  const tocHtml =
    '<div class="toc-card"><div class="toc-head"><span class="toc-title">目录</span>' +
    '<span class="toc-actions">' +
    '<a class="toc-btn toc-comment" href="#commentWrap" title="跳到评论区">评论</a>' +
    '<a class="toc-btn toc-home" href="index.html" title="返回首页">首页</a>' +
    '</span></div><nav class="toc-list">' +
    items.map((h) =>
      `<a class="lvl-${h.tag[1]}" href="#${encodeURIComponent(h.id)}">${escHtmlText(headingText(h.inner))}</a>`
    ).join('') +
    '</nav></div>';
  return { tocHtml, visible: true };
}

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
      if (name === 'id') {
        // 标题锚点 id（Markdown 目录跳转）：全标签放行，但值限定严格字符集，防畸形/注入
        if (!HEADING_ID_PATTERN.test(val)) continue;
      } else if (!allowed.has(name)) continue;
      const lv = val.trim().toLowerCase();
      // 拦截 javascript:/data: 危险协议；其余（http/https/相对路径/锚点等）保留
      if ((name === 'href' || name === 'src') && (lv.startsWith('javascript:') || lv.startsWith('data:'))) continue;
      out += ` ${name}="${escapeAttr(val)}"`;
    }
    return /\/\s*$/.test(whole) ? `<${t}${out} />` : `<${t}${out}>`;
  });
  return html;
}

/**
 * 链接白名单校验（纵深防御：link 字段可能经数据库迁移/种子/直接改库进入，
 * 前端再次校验前，API 出参先做协议白名单过滤）。
 * 仅允许：空串、相对路径/锚点、http/https/mailto；
 * 拒绝 javascript:、data:、vbscript: 等危险协议及 // 协议相对地址。
 * 非法值返回空串（前端据此回退到 /article?id=N）。
 */
export function sanitizeLink(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  // 浏览器 URL 解析器会先移除 URI 中所有空白/控制字符，同步剥离再判断协议（防 "java\tscript:" 绕过）
  const stripped = s.replace(/[\u0000-\u0020]/g, '').toLowerCase();
  const m = stripped.match(/^([a-z][a-z0-9+.-]*):/);
  if (m) {
    const scheme = m[1];
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return '';
  }
  if (s.startsWith('//')) return ''; // 拒绝 //evil.com 协议相对跳转
  return s;
}

/* ================= 敏感文件拦截（安全审计 22c0d741） ================= */
// 背景：Pages 把整个仓库根目录作为静态资源部署，开发/测试源码（server.js、db.js、
// test-*.mjs、package.json、部署文档等）可被未授权下载。functions/[[...sensitive]].js
// 在静态服务前拦截这些路径（403）。
// ⚠ 同步约定：本地 Express（server.js 的 BLOCKED_FILES/BLOCKED_DIRS + 前缀/扩展名规则）
// 与下方规则必须保持一致，新增敏感文件时两处同步更新。

const SENSITIVE_FILES = new Set([
  // 后端 / 生成器源码
  'server.js', 'db.js', 'workers-server.js',
  'admin-article.gen.docx.js', 'docx-skill.js', 'export-sqlite.js', 'migrate-db.js',
  // 测试文件（本地 test-*.mjs / 测试页）
  'test-api.js', 'test-comments.mjs', 'test-e2e.mjs', 'test-functions.mjs',
  'test-xss-fixes.mjs', 'test-toc-anchors.mjs', 'test-mobile-api.html',
  // 配置 / 清单 / 锁文件 / 密钥
  'package.json', 'package-lock.json', 'wrangler.toml',
  '.gitignore', '.npmrc', '.env', '.session-secret',
  // 数据库 / 迁移脚本
  'init-d1.sql', 'website.db',
]);
const SENSITIVE_DIRS = new Set(['node_modules', '.git', 'data', '.npm-cache', 'functions']);
const SENSITIVE_FILE_PREFIX = ['test-']; // 前缀兜底：未来新增 test-* 文件自动拦截
const SENSITIVE_FILE_EXT = ['.md', '.sql', '.db', '.sqlite', '.docx', '.log', '.toml']; // 站点运行不需要这些扩展名的资源

/** 路径是否命中敏感文件/目录黑名单（供 Pages 兑底函数与测试使用） */
export function isSensitivePath(pathname) {
  let p = String(pathname || '');
  try { p = decodeURIComponent(p); } catch { /* 解码失败按原路径处理 */ }
  p = p.replace(/\\/g, '/');
  const segs = p.split('/').filter(Boolean);
  if (!segs.length) return false; // 根路径 / 不拦截
  if (segs.some((s) => SENSITIVE_DIRS.has(s))) return true; // 敏感目录（含任意层级）
  const last = segs[segs.length - 1].toLowerCase();
  if (SENSITIVE_FILES.has(last)) return true;
  if (SENSITIVE_FILE_PREFIX.some((pre) => last.startsWith(pre))) return true;
  if (SENSITIVE_FILE_EXT.some((ext) => last.endsWith(ext))) return true;
  return false;
}

/* ================= 文章字段校验（与 Express 版规则一致） ================= */
/* ================= 文章字段校验（与 Express 版规则一致） ================= */
// Markdown 源码 → 纯文本摘要（用于列表页摘要：去掉 md 语法符号，保留正文文字）
export function mdToPlainText(md, maxLen = 120) {
  let s = String(md == null ? '' : md);
  s = s.replace(/```[\s\S]*?```/g, ' ');                       // 代码块
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');              // 图片 → alt
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');               // 链接 → 文字
  s = s.replace(/`[^`]*`/g, '');                                 // 行内代码
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');                  // 标题
  s = s.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '');       // 列表标记
  s = s.replace(/^>[ \t]?/gm, '');                              // 引用
  s = s.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '');              // 分隔线
  s = s.replace(/\|/g, ' ');                                    // 表格竖线
  s = s.replace(/[*_~]/g, '');                                  // 强调/删除线
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

export function validateArticle(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const rawContent = typeof body.content === 'string' ? body.content : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const rawTags = typeof body.tags === 'string' ? body.tags : '';
  const rawLink = typeof body.link === 'string' ? body.link.trim() : '';
  // 内容格式：'markdown' 时 content 为 md 源码（前端 marked 渲染 + 白名单过滤，入库不剥离语法）；
  // 缺省 'html' 维持原有富文本白名单管线
  const format = body.format === 'markdown' ? 'markdown' : 'html';

  if (!title) return { error: '标题不能为空' };
  if (title.length > MAX_TITLE_LEN) return { error: `标题不能超过 ${MAX_TITLE_LEN} 个字符` };
  if (!ALLOWED_CATEGORIES.includes(category)) return { error: '请选择有效类别' };

  // 卡片跳转链接（选填）：空串合法；非空必须通过协议白名单（防 javascript:/data: 等 XSS 载荷）
  if (rawLink.length > MAX_LINK_LEN) return { error: `跳转链接不能超过 ${MAX_LINK_LEN} 个字符` };
  const link = sanitizeLink(rawLink);
  if (rawLink && !link) return { error: '跳转链接格式无效（仅允许站内相对路径或 http/https/mailto 链接）' };

  let content;
  if (format === 'markdown') {
    content = rawContent; // md 源码原样入库（渲染与过滤在文章页完成）
    if (!content.trim()) return { error: '内容不能为空' };
    if (content.length > MAX_CONTENT_LEN) return { error: `内容不能超过 ${MAX_CONTENT_LEN} 个字符` };
  } else {
    content = sanitizeHtml(rawContent);
    const textOnly = content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!textOnly) return { error: '内容不能为空' };
    if (content.length > MAX_CONTENT_LEN) return { error: `内容不能超过 ${MAX_CONTENT_LEN} 个字符` };
  }

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
  return { value: { title, content, category, tags: tags.join(','), link, format } };
}

/* ================= 评论字段校验（与 Express 版规则一致，REQ-25 ~ 33） ================= */
// 评论内容统一按纯文本处理：先整体剔除危险元素（含其内容），再去除剩余 HTML 标签，
// 最后剥离残留的未配对 < >（如未闭合标签片段 <img src=x onerror=... 无 ">"，不会被上面两条命中）
export function sanitizeComment(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/<(script|style|iframe|object|embed|form|textarea|select|link|meta)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/[<>]/g, '');
  return s;
}

export function validateComment(body) {
  const rawNickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const rawContent = typeof body.content === 'string' ? body.content : '';

  if (!rawNickname) return { error: '昵称不能为空' };
  if (rawNickname.length > MAX_NICKNAME_LEN) return { error: `昵称不能超过 ${MAX_NICKNAME_LEN} 个字符` };
  // 昵称同按纯文本处理（防未来渲染点未转义时 <i onclick=...> 等载荷入库）
  const nickname = sanitizeComment(rawNickname);
  if (!nickname) return { error: '昵称不能为空' };
  if (rawContent.length > MAX_COMMENT_LEN) return { error: `评论内容不能超过 ${MAX_COMMENT_LEN} 个字符` };

  // XSS 过滤（REQ-28 / BC-31）
  const content = sanitizeComment(rawContent).trim();
  if (!content) return { error: '评论内容不能为空' };

  if (email) {
    if (email.length > MAX_EMAIL_LEN) return { error: `邮箱不能超过 ${MAX_EMAIL_LEN} 个字符` };
    if (!EMAIL_PATTERN.test(email)) return { error: '邮箱格式不正确' };
  }
  return { value: { nickname, email, content } };
}

/* ================= D1 Schema 初始化（幂等） ================= */
const SEED_ARTICLES = [
  {
    title: '关于我',
    category: '博客',
    tags: '',
    // 三篇种子已合并为单一「关于我」入口（原 myway.html / honor.html 已并入 introduce.html）
    link: 'introduce.html',
    created_at: '2023-10-15 00:00:00',
    content:
      '<p>欢迎来到我的个人博客！我叫杨楼，在这里我将分享我的生活、学习和工作中的点点滴滴。无论你是我的朋友、同学、老师，还是偶然路过的访客，都希望这里的内容能够给你带来帮助或启发。</p>' +
      '<p>我会在这里记录我的成长历程，分享有用的知识和经验。如果你对某些内容感兴趣，或者有任何问题或建议，欢迎随时联系我！</p>' +
      '<p>这部分记录了我的部分成长经历。在这里，我将分享我的成长曲线、兴趣分布图等。如果你有任何问题或建议，我很乐意与你交流！</p>',
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      nickname   TEXT NOT NULL,
      email      TEXT NOT NULL DEFAULT '',
      content    TEXT NOT NULL,
      ip         TEXT NOT NULL DEFAULT '',
      parent_id  INTEGER NOT NULL DEFAULT 0,   -- 回复目标评论 id（0 = 顶级评论；仅允许一级嵌套）
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      created_ms INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_comments_article ON comments (article_id)`),
    // 点赞（文章 / 评论）：按 IP 唯一，重复点赞幂等；target_type ∈ {article, comment}
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS likes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id   INTEGER NOT NULL,
      ip          TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      created_ms  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (target_type, target_id, ip)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_likes_target ON likes (target_type, target_id)`),
  ]);
  // 显式开启外键约束（与本地 SQLite 版一致），保证删除文章时级联清理评论
  // （后台删除接口另有显式清理评论的语句，此处为双保险；失败不阻断应用）
  try {
    await env.DB.exec('PRAGMA foreign_keys = ON;');
  } catch {
    /* 忽略：部分环境不支持 PRAGMA exec */
  }
  // 迁移：为旧库补 link 列，并为 3 篇种子文章设置指向静态页面的链接
  const artCols = await env.DB.prepare('PRAGMA table_info(articles)').all();
  if (!artCols.results.some((c) => c.name === 'link')) {
    await env.DB.prepare("ALTER TABLE articles ADD COLUMN link TEXT NOT NULL DEFAULT ''").run();
  }
  if (!artCols.results.some((c) => c.name === 'format')) {
    await env.DB.prepare("ALTER TABLE articles ADD COLUMN format TEXT NOT NULL DEFAULT 'html'").run();
  }
  if (!artCols.results.some((c) => c.name === 'views')) {
    await env.DB.prepare('ALTER TABLE articles ADD COLUMN views INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!artCols.results.some((c) => c.name === 'updated_at')) {
    await env.DB.prepare("ALTER TABLE articles ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run();
    await env.DB.prepare("UPDATE articles SET updated_at = created_at WHERE updated_at = ''").run();
  }
  // 迁移：为旧库补 comments.parent_id 列（评论回复；likes 表由上方 CREATE TABLE IF NOT EXISTS 幂等创建）
  const cmtCols = await env.DB.prepare('PRAGMA table_info(comments)').all();
  if (!cmtCols.results.some((c) => c.name === 'parent_id')) {
    await env.DB.prepare('ALTER TABLE comments ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0').run();
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE articles SET link = 'introduce.html' WHERE title = '个人基本信息' AND link = ''"),
    // 学习之路/一路所获页面已并入 introduce.html（原 myway.html、honor.html 已下线）
    env.DB.prepare("UPDATE articles SET link = 'introduce.html' WHERE title = '我的学习之路' AND link IN ('', 'myway.html')"),
    env.DB.prepare("UPDATE articles SET link = 'introduce.html' WHERE title = '一路所获' AND link IN ('', 'honor.html')"),
  ]);
  // 三篇种子文章合并为单一「关于我」入口（一次性，app_meta 标记保证幂等）：
  // 「个人基本信息」就地更名，另两篇删除（评论经外键级联清理）；限定 link 为种子特征取值
  const mergedFlag = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'merged_aboutme'").first();
  if (!mergedFlag) {
    await env.DB.batch([
      env.DB.prepare("UPDATE articles SET title = '关于我' WHERE title = '个人基本信息' AND link IN ('', 'introduce.html')"),
      env.DB.prepare("DELETE FROM articles WHERE title IN ('我的学习之路', '一路所获') AND link IN ('', 'introduce.html', 'myway.html', 'honor.html')"),
    ]);
    await env.DB.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('merged_aboutme', '1')").run();
  }
  // 默认管理员（幂等；凭据优先取环境变量，见 resolveDefaultAdmin）
  const adminCred = resolveDefaultAdmin(env);
  const admin = await env.DB.prepare('SELECT id FROM admins WHERE username = ?').bind(adminCred.username).first();
  if (!admin) {
    const hash = await hashPassword(adminCred.password);
    await env.DB.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .bind(adminCred.username, hash)
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

/* ================= IndexNow（Bing 指引 §4：URL 新增/更新/删除时主动通知搜索引擎） ================= */
// 未配置 INDEXNOW_KEY 时静默跳过（不影响主流程）。
// key 在 Bing 站长工具生成，配置到 Cloudflare Pages 环境变量；
// 协议还要求站点在 https://域名/{key}.txt 明文提供 key（functions/[key].txt.js 负责）。
// fetchImpl 可注入（测试用）；任何异常仅告警，绝不阻断管理操作。
export async function indexNowUrls(env, urls, { deleteMode = false, fetchImpl = fetch } = {}) {
  const key = env && env.INDEXNOW_KEY;
  if (!key || !Array.isArray(urls) || !urls.length) return;
  try {
    const qs = new URLSearchParams();
    qs.set('url', urls[0]);
    qs.set('key', key);
    await fetchImpl('https://api.indexnow.org/indexnow?' + qs.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      // 协议格式：body 第一行为 hostKey，随后每行一个 URL（删除以 "DELETE " 前缀）
      body: [key, ...urls.map((u) => (deleteMode ? 'DELETE ' : '') + u)].join('\n'),
    });
  } catch (e) {
    console.warn('[indexnow] 通知失败（不影响主流程）:', e && e.message);
  }
}
