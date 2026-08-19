/**
 * functions/api/[[path]].js — Cloudflare Pages Functions 全量 API 路由
 * 对应《管理员登录与文章添加功能需求文档》v1.1 的全部 P0/P1 功能，
 * 逻辑与本地 Express 版（server.js）保持一致，运行于 Workers 无状态环境。
 */
import {
  json, parseCookies, sanitizeHtml, validateArticle, ensureSchema,
  hashPassword, verifyPassword, createSessionToken, verifySessionToken,
  makeCookie, getAdminSession, getCsrfCookie,
  logLogin, checkLocked, recordLoginFailure, clearLoginFailures,
  isDuplicateSubmit, sha256Fingerprint,
  SESSION_TTL_MS, ALLOWED_CATEGORIES,
} from '../_lib.mjs';

let schemaPromise = null;
function getSchema(env) {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(env).catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

/** 从请求读取 JSON body（非法 JSON 返回 null） */
async function readBody(request) {
  try {
    const ct = request.headers.get('Content-Type') || '';
    if (!ct.includes('application/json')) return {};
    return await request.json();
  } catch {
    return null;
  }
}

/** 未登录统一响应 */
function unauthorized() {
  return json({ message: '未登录或会话已过期' }, 401);
}

/** 管理员 + CSRF 双提交校验（写接口） */
async function requireAdminWrite(request, env) {
  const session = await getAdminSession(request, env);
  if (!session) return { error: unauthorized() };
  const headerToken = (request.headers.get('X-CSRF-Token') || '').trim();
  const cookieToken = getCsrfCookie(request);
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return { error: json({ message: '安全校验失败，请刷新页面重试' }, 403) };
  }
  return { session };
}

/* ================= 路由分发 ================= */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const clientIp = request.headers.get('CF-Connecting-IP') || '';

  try {
    await getSchema(env);

    /* ---------- 登录（REQ-01 ~ 08） ---------- */
    if (path === '/api/login' && method === 'POST') {
      const body = await readBody(request);
      if (!body) return json({ message: '请求体格式错误' }, 400);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) return json({ message: '请输入用户名和密码' }, 400); // BC-01

      const key = username.toLowerCase();
      const lock = await checkLocked(env, key);
      if (lock.locked) { // BC-04
        await logLogin(env, username, false, clientIp);
        const minutes = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
        return json({ message: `账户已锁定，请 ${minutes} 分钟后再试` }, 423);
      }

      const admin = await env.DB.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?').bind(username).first();
      const ok = admin ? await verifyPassword(password, admin.password_hash) : false;

      if (!ok) { // BC-02 / BC-03 统一提示
        const res = await recordLoginFailure(env, key);
        await logLogin(env, username, false, clientIp);
        if (res.lockedNow) return json({ message: '账户已锁定，请 15 分钟后再试' }, 423);
        return json({ message: '用户名或密码错误' }, 401);
      }

      await clearLoginFailures(env, key);
      await logLogin(env, username, true, clientIp);

      const isSecure = url.protocol === 'https:';
      const sid = await createSessionToken(admin.id, admin.username, env);
      const csrf = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
      const res = json({ success: true, username: admin.username });
      res.headers.append('Set-Cookie', makeCookie('sid', sid, { httpOnly: true, isSecure }));
      res.headers.append('Set-Cookie', makeCookie('csrf', csrf, { httpOnly: false, isSecure }));
      return res;
    }

    /* ---------- 退出登录（REQ-05） ---------- */
    if (path === '/api/logout' && method === 'POST') {
      const res = json({ success: true });
      res.headers.append('Set-Cookie', makeCookie('sid', '', { httpOnly: true, maxAgeSec: 0 }));
      res.headers.append('Set-Cookie', makeCookie('csrf', '', { httpOnly: false, maxAgeSec: 0 }));
      return res;
    }

    /* ---------- 修改密码（管理员 + CSRF） ---------- */
    if (path === '/api/admin/change-password' && method === 'POST') {
      const auth = await requireAdminWrite(request, env);
      if (auth.error) return auth.error;
      const body = await readBody(request);
      if (!body) return json({ message: '请求体格式错误' }, 400);
      const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (!oldPassword || !newPassword) return json({ message: '请填写旧密码和新密码' }, 400);
      if (newPassword.length < 6 || newPassword.length > 64) return json({ message: '新密码长度需为 6-64 个字符' }, 400);
      if (newPassword === oldPassword) return json({ message: '新密码不能与旧密码相同' }, 400);
      const admin = await env.DB.prepare('SELECT id, password_hash FROM admins WHERE id = ?').bind(auth.session.adminId).first();
      if (!admin) return unauthorized();
      const ok = await verifyPassword(oldPassword, admin.password_hash);
      if (!ok) return json({ message: '旧密码不正确' }, 400);
      const hash = await hashPassword(newPassword);
      await env.DB.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').bind(hash, admin.id).run();
      return json({ success: true, message: '密码修改成功' });
    }

    /* ---------- 登录状态 / CSRF 下发 ---------- */
    if (path === '/api/auth/status') {
      const session = await getAdminSession(request, env);
      return json(session ? { loggedIn: true, username: session.username } : { loggedIn: false });
    }

    if (path === '/api/csrf-token') {
      const session = await getAdminSession(request, env);
      if (!session) return unauthorized();
      const token = getCsrfCookie(request);
      if (!token) return json({ message: '安全校验失败，请刷新页面重试' }, 403);
      return json({ csrfToken: token });
    }

    /* ---------- 前台公开接口 ---------- */
    // 生成文章内容摘要（剥离 HTML，截取纯文本）
    const makeSummary = (content, maxLen = 120) => {
      const text = String(content || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
    };
    if (path === '/api/articles' && method === 'GET') {
      const category = url.searchParams.get('category') || '';
      const keyword = url.searchParams.get('keyword') || '';
      const tag = url.searchParams.get('tag') || '';
      
      let sql = 'SELECT id, title, category, tags, link, content, created_at FROM articles WHERE 1=1';
      const args = [];
      if (category) { sql += ' AND category = ?'; args.push(category); }
      if (keyword) { sql += ' AND title LIKE ?'; args.push(`%${keyword}%`); }
      if (tag) { sql += ' AND tags LIKE ?'; args.push(`%${tag}%`); }
      sql += ' ORDER BY created_at DESC, id DESC';
      
      const stmt = env.DB.prepare(sql);
      const rows = args.length ? await stmt.bind(...args).all() : await stmt.all();
      return json({ articles: rows.results.map((a) => ({ ...a, summary: makeSummary(a.content) })) });
    }

    // 标签统计（标签云）
    if (path === '/api/articles/tags' && method === 'GET') {
      const result = await env.DB.prepare("SELECT tags FROM articles WHERE tags != ''").all();
      const tagCount = {};
      for (const row of result.results) {
        const tags = (row.tags || '').split(',').filter(Boolean);
        for (const t of tags) {
          tagCount[t] = (tagCount[t] || 0) + 1;
        }
      }
      const tags = Object.entries(tagCount)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count }));
      return json({ tags });
    }

    const detailMatch = path.match(/^\/api\/articles\/(\d+)$/);
    if (detailMatch && method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT id, title, content, category, tags, link, created_at FROM articles WHERE id = ?'
      ).bind(Number(detailMatch[1])).first();
      if (!row) return json({ message: '文章不存在或已被删除' }, 404);
      return json({ article: row });
    }

    /* ---------- 后台管理接口（管理员 + CSRF） ---------- */
    if (path === '/api/admin/articles') {
      // 管理列表（REQ-19）
      if (method === 'GET') {
        const session = await getAdminSession(request, env);
        if (!session) return unauthorized();
        const keyword = url.searchParams.get('keyword') || '';
        const category = url.searchParams.get('category') || '';
        const tag = url.searchParams.get('tag') || '';
        let sql = "SELECT id, title, category, tags, link, created_at FROM articles WHERE link = ''";
        const args = [];
        if (keyword) { sql += ' AND title LIKE ?'; args.push(`%${keyword}%`); }
        if (category) { sql += ' AND category = ?'; args.push(category); }
        if (tag) { sql += ' AND tags LIKE ?'; args.push(`%${tag}%`); }
        sql += ' ORDER BY created_at DESC, id DESC';
        const stmt = env.DB.prepare(sql);
        const rows = args.length ? await stmt.bind(...args).all() : await stmt.all();
        return json({ articles: rows.results });
      }
      // 提交文章（REQ-10 ~ 18）
      if (method === 'POST') {
        const auth = await requireAdminWrite(request, env);
        if (auth.error) return auth.error;
        const body = await readBody(request);
        if (!body) return json({ message: '请求体格式错误' }, 400);
        const result = validateArticle(body);
        if (result.error) return json({ message: result.error }, 400);
        const { title, content, category, tags } = result.value;

        const fingerprint = await sha256Fingerprint(`${title}\u0000${content.slice(0, 300)}`);
        if (await isDuplicateSubmit(env, fingerprint)) {
          return json({ message: '请勿重复提交' }, 429); // BC-19
        }
        // 取最小可用 id：删除文章后 id 复用（如删了 4，下一篇仍为 4）
        const nextRow = await env.DB.prepare(
          `SELECT t.id FROM (
             SELECT 1 AS id
             UNION ALL
             SELECT id + 1 FROM articles
           ) t
           WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = t.id)
           ORDER BY t.id LIMIT 1`
        ).first();
        const newId = nextRow ? nextRow.id : 1;
        await env.DB.prepare(
          'INSERT INTO articles (id, title, content, category, tags) VALUES (?, ?, ?, ?, ?)'
        ).bind(newId, title, content, category, tags).run();
        return json({ success: true, id: newId, message: '发布成功' });
      }
      return json({ message: '接口不存在' }, 404);
    }

    // 更新文章（PUT /api/admin/articles/:id）
    const adminUpdateMatch = path.match(/^\/api\/admin\/articles\/(\d+)$/);
    if (adminUpdateMatch && method === 'PUT') {
      const auth = await requireAdminWrite(request, env);
      if (auth.error) return auth.error;
      const id = Number(adminUpdateMatch[1]);
      const body = await readBody(request);
      if (!body) return json({ message: '请求体格式错误' }, 400);
      const result = validateArticle(body);
      if (result.error) return json({ message: result.error }, 400);

      // 验证文章存在
      const row = await env.DB.prepare('SELECT id FROM articles WHERE id = ?').bind(id).first();
      if (!row) return json({ message: '文章不存在或已被删除' }, 404);

      const { title, content, category, tags } = result.value;
      await env.DB.prepare(
        'UPDATE articles SET title = ?, content = ?, category = ?, tags = ? WHERE id = ?'
      ).bind(title, content, category, tags, id).run();
      return json({ success: true, message: '更新成功' });
    }

    // 批量删除（REQ-23 / REQ-24）
    if (path === '/api/admin/articles/batch-delete' && method === 'POST') {
      const auth = await requireAdminWrite(request, env);
      if (auth.error) return auth.error;
      const body = await readBody(request);
      if (!body) return json({ message: '请求体格式错误' }, 400);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      if (!ids.length) return json({ message: '请选择要删除的文章' }, 400);
      const placeholders = ids.map(() => '?').join(',');
      const existing = await env.DB.prepare(`SELECT id FROM articles WHERE id IN (${placeholders})`).bind(...ids).all();
      const existIds = existing.results.map((r) => r.id);
      if (existIds.length) {
        await env.DB.prepare(`DELETE FROM articles WHERE id IN (${placeholders})`).bind(...existIds).run();
      }
      return json({ success: true, deleted: existIds.length, message: `删除成功（${existIds.length} 篇）` });
    }

    // 删除单篇（REQ-21 / REQ-22 / REQ-24）
    const adminDelMatch = path.match(/^\/api\/admin\/articles\/(\d+)$/);
    if (adminDelMatch && method === 'DELETE') {
      const auth = await requireAdminWrite(request, env);
      if (auth.error) return auth.error;
      const id = Number(adminDelMatch[1]);
      const row = await env.DB.prepare('SELECT id FROM articles WHERE id = ?').bind(id).first();
      if (!row) return json({ message: '文章不存在或已被删除' }, 404); // BC-23
      await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
      return json({ success: true, message: '删除成功' });
    }

    return json({ message: '接口不存在' }, 404);
  } catch (e) {
    console.error('[functions]', e && e.stack ? e.stack : String(e));
    return json({ message: '系统繁忙，请稍后重试' }, 500); // BC-07 / BC-20 / BC-26
  }
}
