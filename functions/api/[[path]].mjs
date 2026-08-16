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
    if (path === '/api/articles' && method === 'GET') {
      const category = url.searchParams.get('category') || '';
      if (category) {
        const rows = await env.DB.prepare(
          'SELECT id, title, category, tags, link, created_at FROM articles WHERE category = ? ORDER BY created_at DESC, id DESC'
        ).bind(category).all();
        return json({ articles: rows.results });
      }
      const rows = await env.DB.prepare(
        'SELECT id, title, category, tags, link, created_at FROM articles ORDER BY created_at DESC, id DESC'
      ).all();
      return json({ articles: rows.results });
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
        let sql = 'SELECT id, title, category, tags, link, created_at FROM articles WHERE 1=1';
        const args = [];
        if (keyword) { sql += ' AND title LIKE ?'; args.push(`%${keyword}%`); }
        if (category) { sql += ' AND category = ?'; args.push(category); }
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
        const info = await env.DB.prepare(
          'INSERT INTO articles (title, content, category, tags) VALUES (?, ?, ?, ?)'
        ).bind(title, content, category, tags).run();
        return json({ success: true, id: info.meta.last_row_id, message: '发布成功' });
      }
      return json({ message: '接口不存在' }, 404);
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
