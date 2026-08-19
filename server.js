/**
 * server.js — 个人主页网站后台服务端
 * 实现《管理员登录与文章添加功能需求文档》v1.1 的全部 P0 / P1 需求：
 *   - 管理员登录（bcrypt 校验 / Session 会话 / 滑动续期 / 防暴力破解 / 登录日志）
 *   - 权限管理（页面访问控制 / 提交身份校验 / CSRF Token / 会话时效校验）
 *   - 文章添加（字段校验 / XSS 白名单过滤 / 防重复提交）
 *   - 文章列表与删除（检索 / 二次确认由前端实现 / 删除身份校验 / 批量删除）
 * 启动：node server.js  （默认端口 3000，可用环境变量 PORT 覆盖）
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sanitizeHtml = require('sanitize-html');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/* ================= 配置常量（字段校验规则集中配置，便于维护） ================= */
const SESSION_TTL_MS = 30 * 60 * 1000;        // 会话默认 30 分钟，滑动续期
const MAX_FAILED_ATTEMPTS = 5;                // 连续失败次数
const LOCK_MS = 15 * 60 * 1000;               // 锁定 15 分钟
const DUP_SUBMIT_WINDOW_MS = 5 * 1000;        // 服务端防重复提交窗口
const ALLOWED_CATEGORIES = ['博客', '学习笔记', '生活感悟'];
const MAX_TITLE_LEN = 100;
const MAX_CONTENT_LEN = 50000;
const MAX_TAG_COUNT = 5;
const MAX_TAG_LEN = 20;
const TAG_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/; // 中文/英文/数字/下划线/连字符

// 内容 XSS 白名单（去除 script、事件属性、iframe 等）
const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'del', 's',
    'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'code', 'pre',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
};

/* ================= Session Secret（首次启动生成并持久化） ================= */
function getSessionSecret() {
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
  const file = path.join(dataDir, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret);
  return secret;
}

/* ================= 中间件 ================= */
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Express 5 兼容：无请求体时 req.body 为 undefined，统一补为 {}
app.use((req, res, next) => {
  if (!req.body) req.body = {};
  next();
});

// 生产环境强制 HTTPS（HSTS），本地 http 直连不受影响
if (IS_PROD) {
  // 部署平台（Railway/Render/Zeabur 等）在应用前有 TLS 终止代理，
  // 信任一级代理以便正确识别 HTTPS 协议与客户端 IP
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      return next();
    }
    return res.redirect('https://' + req.headers.host + req.originalUrl);
  });
}

// Session 管理：HttpOnly Cookie、30 分钟滑动续期（rolling）
app.use(
  session({
    name: 'sid',
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    },
  })
);

// 登录失败计数（内存，按用户名，含不存在的账户，统一防枚举）
const loginAttempts = new Map(); // key: username 小写 -> { count, lockedUntil }

// 防重复提交记录（按会话 + 内容指纹，5 秒窗口）
const recentSubmits = new Map(); // key: sessionId -> { key, time }

/* ================= 工具函数 ================= */
function logLogin(username, success, ip) {
  try {
    db.prepare('INSERT INTO login_logs (username, success, ip) VALUES (?, ?, ?)').run(
      username || '',
      success ? 1 : 0,
      ip || ''
    );
  } catch (e) {
    console.error('[logLogin]', e.message);
  }
}

function isSessionValid(req) {
  return !!(req.session && req.session.adminId);
}

// 写接口：校验管理员身份 + CSRF Token（REQ-10 / REQ-12 / REQ-21 / REQ-24）
function requireAdminWrite(req, res, next) {
  if (!isSessionValid(req)) {
    logLogin(req.session && req.session.username, false, req.ip);
    return res.status(401).json({ message: '未登录或会话已过期，请重新登录' });
  }
  const token =
    (req.headers['x-csrf-token'] || '').trim() ||
    (req.body && req.body._csrf ? String(req.body._csrf) : '');
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ message: '安全校验失败，请刷新页面重试' });
  }
  next();
}

// 文章字段校验（前端 + 后端双重校验；校验规则见 5.3.2）
function validateArticle(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const rawContent = typeof body.content === 'string' ? body.content : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const rawTags = typeof body.tags === 'string' ? body.tags : '';

  if (!title) return { error: '标题不能为空' };
  if (title.length > MAX_TITLE_LEN) return { error: `标题不能超过 ${MAX_TITLE_LEN} 个字符` };

  if (!ALLOWED_CATEGORIES.includes(category)) return { error: '请选择有效类别' };

  // XSS 白名单过滤（REQ-17）
  const content = sanitizeHtml(rawContent, SANITIZE_OPTIONS);
  const textOnly = content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (!textOnly) return { error: '内容不能为空' };
  if (content.length > MAX_CONTENT_LEN) return { error: `内容不能超过 ${MAX_CONTENT_LEN} 个字符` };

  // 标签：逗号分隔、去空白、去重、格式校验
  let tags = [];
  if (rawTags.trim()) {
    tags = rawTags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length > MAX_TAG_COUNT) return { error: `标签最多 ${MAX_TAG_COUNT} 个` };
    for (const t of tags) {
      if (t.length > MAX_TAG_LEN) return { error: `单个标签不能超过 ${MAX_TAG_LEN} 个字符` };
      if (!TAG_PATTERN.test(t)) return { error: '标签仅允许中文/英文/数字/下划线/连字符' };
    }
    tags = [...new Set(tags)];
  }

  return { value: { title, content, category, tags: tags.join(',') } };
}

/* ================= 页面访问控制（REQ-09 / BC-08） ================= */
// 后台页面：未登录重定向登录页并回跳；后台 API：未登录返回 401/403
app.use('/admin', (req, res, next) => {
  const p = req.path;
  if (p === '/') return res.redirect('/admin/dashboard.html');
  const isPublic = p === '/login.html';
  if (isPublic || isSessionValid(req)) return next();
  if (p.startsWith('/api/')) {
    return res.status(401).json({ message: '未登录或会话已过期' });
  }
  const nextUrl = encodeURIComponent(req.originalUrl || '/admin/dashboard.html');
  return res.redirect(`/admin/login.html?next=${nextUrl}`);
});

// 静态资源白名单：拒绝源码 / 数据库 / 配置文件被下载（安全要求）
const BLOCKED_FILES = new Set([
  'server.js', 'db.js', 'package.json', 'package-lock.json',
  'admin-article.gen.docx.js', 'docx-skill.js', '111',
  '.session-secret', 'website.db',
]);
const BLOCKED_DIRS = new Set(['node_modules', '.git', 'data']);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let urlPath = req.path;
  try {
    urlPath = decodeURIComponent(req.path);
  } catch (e) {
    return res.status(400).end();
  }
  const segs = urlPath.split('/').filter(Boolean);
  if (segs.length) {
    if (BLOCKED_DIRS.has(segs[0])) return res.status(403).end();
    if (BLOCKED_FILES.has(segs[segs.length - 1])) return res.status(403).end();
  }
  next();
});
app.use(express.static(__dirname)); // 前台 + 后台静态页面

/* ================= 登录 API（REQ-01 ~ 08） ================= */
app.post('/api/login', async (req, res) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    // 防空白提交（REQ-02 / BC-01）
    if (!username || !password) {
      return res.status(400).json({ message: '请输入用户名和密码' });
    }

    const key = username.toLowerCase();
    const now = Date.now();
    const rec = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };

    // 账户锁定（REQ-08 / BC-04）
    if (rec.lockedUntil > now) {
      logLogin(username, false, req.ip);
      const minutes = Math.ceil((rec.lockedUntil - now) / 60000);
      return res.status(423).json({ message: `账户已锁定，请 ${minutes} 分钟后再试` });
    }
    if (rec.lockedUntil && rec.lockedUntil <= now) {
      rec.count = 0;
      rec.lockedUntil = 0;
    }

    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    const ok = admin ? await bcrypt.compare(password, admin.password_hash) : false;

    if (!ok) {
      // 统一提示（REQ-03 / BC-02 / BC-03），失败计数 +1
      rec.count += 1;
      if (rec.count >= MAX_FAILED_ATTEMPTS) {
        // 第 5 次失败即触发锁定并告知（REQ-08 / BC-04 / AC-09）
        rec.lockedUntil = now + LOCK_MS;
        rec.count = 0;
        loginAttempts.set(key, rec);
        logLogin(username, false, req.ip);
        return res.status(423).json({ message: '账户已锁定，请 15 分钟后再试' });
      }
      loginAttempts.set(key, rec);
      logLogin(username, false, req.ip);
      return res.status(401).json({ message: '用户名或密码错误' });
    }

    loginAttempts.delete(key);
    logLogin(username, true, req.ip);

    // 登录成功：轮换 Session ID 防会话固定（REQ-04）
    req.session.regenerate((err) => {
      if (err) {
        console.error('[session.regenerate]', err);
        return res.status(500).json({ message: '系统繁忙，请稍后重试' });
      }
      req.session.adminId = admin.id;
      req.session.username = admin.username;
      req.session.loginAt = now;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.json({ success: true, username: admin.username });
    });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ message: '系统繁忙，请稍后重试' }); // BC-07 不泄露内部错误
  }
});

// 退出登录（REQ-05）
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ success: true });
  });
});

// 修改密码（管理员 + CSRF）
app.post('/api/admin/change-password', requireAdminWrite, async (req, res) => {
  try {
    const oldPassword = typeof req.body.oldPassword === 'string' ? req.body.oldPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: '请填写旧密码和新密码' });
    }
    if (newPassword.length < 6 || newPassword.length > 64) {
      return res.status(400).json({ message: '新密码长度需为 6-64 个字符' });
    }
    if (newPassword === oldPassword) {
      return res.status(400).json({ message: '新密码不能与旧密码相同' });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
    if (!admin) return res.status(401).json({ message: '未登录或会话已过期' });
    const ok = await bcrypt.compare(oldPassword, admin.password_hash);
    if (!ok) return res.status(400).json({ message: '旧密码不正确' });
    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
    res.json({ success: true, message: '密码修改成功' });
  } catch (e) {
    console.error('[change-password]', e);
    res.status(500).json({ message: '系统繁忙，请稍后重试' });
  }
});

// 当前登录状态 / CSRF Token 下发
app.get('/api/auth/status', (req, res) => {
  if (!isSessionValid(req)) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: req.session.username });
});

app.get('/api/csrf-token', (req, res) => {
  if (!isSessionValid(req)) return res.status(401).json({ message: '未登录或会话已过期' });
  res.json({ csrfToken: req.session.csrfToken });
});

/* ================= 前台文章 API（公开只读） ================= */
// 生成文章内容摘要（剥离 HTML，截取纯文本）
function makeSummary(content, maxLen = 120) {
  const text = String(content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

app.get('/api/articles', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  try {
    const withSummary = (rows) =>
      rows.map((a) => ({ ...a, summary: makeSummary(a.content) }));
    if (category) {
      const rows = db
        .prepare(
          'SELECT id, title, category, tags, link, content, created_at FROM articles WHERE category = ? ORDER BY created_at DESC, id DESC'
        )
        .all(category);
      return res.json({ articles: withSummary(rows) });
    }
    const rows = db
      .prepare('SELECT id, title, category, tags, link, content, created_at FROM articles ORDER BY created_at DESC, id DESC')
      .all();
    res.json({ articles: withSummary(rows) });
  } catch (e) {
    console.error('[articles.list]', e);
    res.status(500).json({ message: '系统繁忙，请稍后重试' });
  }
});

app.get('/api/articles/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: '文章不存在或已被删除' });
  try {
    const row = db
      .prepare('SELECT id, title, content, category, tags, link, created_at FROM articles WHERE id = ?')
      .get(id);
    if (!row) return res.status(404).json({ message: '文章不存在或已被删除' });
    res.json({ article: row });
  } catch (e) {
    console.error('[articles.detail]', e);
    res.status(500).json({ message: '系统繁忙，请稍后重试' });
  }
});

/* ================= 后台文章 API（管理员 + CSRF） ================= */
// 文章管理列表（含检索：标题关键字 / 类别）（REQ-19）
app.get('/api/admin/articles', (req, res) => {
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  try {
    // 后台列表只显示可管理的普通文章（link 非空的固定页面不可在后台管理）
    let sql = "SELECT id, title, category, tags, link, created_at FROM articles WHERE link = ''";
    const params = [];
    if (keyword) {
      sql += ' AND title LIKE ?';
      params.push(`%${keyword}%`);
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    const rows = db.prepare(sql).all(...params);
    res.json({ articles: rows });
  } catch (e) {
    console.error('[admin.articles.list]', e);
    res.status(500).json({ message: '系统繁忙，请稍后重试' });
  }
});

// 提交文章（REQ-10 ~ 18）
app.post('/api/admin/articles', requireAdminWrite, (req, res) => {
  try {
    const result = validateArticle(req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    const { title, content, category, tags } = result.value;

    // 防重复提交（REQ-18 / BC-19）：同一会话 5 秒内相同内容拒绝
    const sid = req.session.id;
    const now = Date.now();
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${title}\u0000${content.slice(0, 300)}`)
      .digest('hex');
    const prev = recentSubmits.get(sid);
    if (prev && prev.key === fingerprint && now - prev.time < DUP_SUBMIT_WINDOW_MS) {
      return res.status(429).json({ message: '请勿重复提交' });
    }
    recentSubmits.set(sid, { key: fingerprint, time: now });
    // 清理过期记录
    for (const [k, v] of recentSubmits) {
      if (now - v.time > DUP_SUBMIT_WINDOW_MS) recentSubmits.delete(k);
    }

    // 取最小可用 id：删除文章后 id 复用（如删了 4，下一篇仍为 4）
    const nextRow = db
      .prepare(
        `SELECT t.id FROM (
           SELECT 1 AS id
           UNION ALL
           SELECT id + 1 FROM articles
         ) t
         WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = t.id)
         ORDER BY t.id LIMIT 1`
      )
      .get();
    const newId = nextRow ? nextRow.id : 1;

    db.prepare('INSERT INTO articles (id, title, content, category, tags) VALUES (?, ?, ?, ?, ?)')
      .run(newId, title, content, category, tags);
    res.json({ success: true, id: newId, message: '发布成功' });
  } catch (e) {
    console.error('[admin.articles.create]', e);
    res.status(500).json({ message: '发布失败，请稍后重试' }); // BC-20 保留表单内容由前端处理
  }
});

// 更新文章（REQ-25 / REQ-26）
app.put('/api/admin/articles/:id', requireAdminWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: '文章不存在或已被删除' });
  }
  try {
    const result = validateArticle(req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    const { title, content, category, tags } = result.value;

    // 验证文章存在
    const row = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: '文章不存在或已被删除' });

    db.prepare(
      'UPDATE articles SET title = ?, content = ?, category = ?, tags = ? WHERE id = ?'
    ).run(title, content, category, tags, id);
    res.json({ success: true, message: '更新成功' });
  } catch (e) {
    console.error('[admin.articles.update]', e);
    res.status(500).json({ message: '更新失败，请稍后重试' });
  }
});

// 删除文章（REQ-21 / REQ-22 / BC-23 / BC-26）
app.delete('/api/admin/articles/:id', requireAdminWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: '文章不存在或已被删除' });
  }
  try {
    const row = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: '文章不存在或已被删除' });
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    res.json({ success: true, message: '删除成功' });
  } catch (e) {
    console.error('[admin.articles.delete]', e);
    res.status(500).json({ message: '删除失败，请稍后重试' });
  }
});

// 批量删除（REQ-23）
app.post('/api/admin/articles/batch-delete', requireAdminWrite, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return res.status(400).json({ message: '请选择要删除的文章' });
    const placeholders = ids.map(() => '?').join(',');
    const tx = db.transaction(() => {
      const existing = db.prepare(`SELECT id FROM articles WHERE id IN (${placeholders})`).all(...ids);
      const existIds = existing.map((r) => r.id);
      if (existIds.length) {
        db.prepare(`DELETE FROM articles WHERE id IN (${placeholders})`).run(...existIds);
      }
      return existIds.length;
    });
    const deleted = tx();
    res.json({ success: true, deleted, message: `删除成功（${deleted} 篇）` });
  } catch (e) {
    console.error('[admin.articles.batchDelete]', e);
    res.status(500).json({ message: '删除失败，请稍后重试' });
  }
});

/* ================= 错误兜底 ================= */
app.use((req, res) => {
  res.status(404).json({ message: '接口不存在' });
});

app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  // body-parser 错误（非法 JSON / 请求体超限）应返回 4xx 而非 500
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(err.statusCode || 400).json({ message: '请求体格式错误' });
  }
  res.status(500).json({ message: '系统繁忙，请稍后重试' });
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  个人主页网站已启动`);
  console.log(`  前台首页    : http://localhost:${PORT}/`);
  console.log(`  后台登录页  : http://localhost:${PORT}/admin/login.html`);
  console.log(`  默认管理员  : admin / admin123（请尽快修改）`);
  console.log(`========================================`);
});
