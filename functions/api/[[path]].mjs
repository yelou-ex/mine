/**
 * functions/api/[[path]].js — Cloudflare Pages Functions 全量 API 路由
 * 对应《管理员登录与文章添加功能需求文档》v1.1 的全部 P0/P1 功能，
 * 逻辑与本地 Express 版（server.js）保持一致，运行于 Workers 无状态环境。
 */
import {
  json, parseCookies, sanitizeHtml, sanitizeLink, validateArticle, ensureSchema, mdToPlainText, indexNowUrls,
  hashPassword, verifyPassword, createSessionToken, verifySessionToken,
  makeCookie, getAdminSession, getCsrfCookie,
  logLogin, checkLocked, recordLoginFailure, clearLoginFailures,
  isDuplicateSubmit, sha256Fingerprint,
  SESSION_TTL_MS, ALLOWED_CATEGORIES,
  validateComment, COMMENT_DUP_WINDOW_MS, COMMENT_HOUR_LIMIT,
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
      
      let sql = 'SELECT id, title, category, tags, link, content, format, created_at FROM articles WHERE 1=1';
      const args = [];
      if (category) { sql += ' AND category = ?'; args.push(category); }
      if (keyword) { sql += ' AND title LIKE ?'; args.push(`%${keyword}%`); }
      if (tag) { sql += ' AND tags LIKE ?'; args.push(`%${tag}%`); }
      sql += ' ORDER BY created_at DESC, id DESC';
      
      const stmt = env.DB.prepare(sql);
      const rows = args.length ? await stmt.bind(...args).all() : await stmt.all();
      // link 字段出参做协议白名单过滤（防 javascript:/data: 等 XSS 载荷）；
      // 摘要按内容格式生成（markdown 走 md 语法剥离，html 走标签剥离）
      return json({ articles: rows.results.map((a) => ({
        ...a,
        link: sanitizeLink(a.link),
        summary: a.format === 'markdown' ? mdToPlainText(a.content) : makeSummary(a.content),
      })) });
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
        'SELECT id, title, content, category, tags, link, format, views, created_at FROM articles WHERE id = ?'
      ).bind(Number(detailMatch[1])).first();
      // 信息级加固：公开接口不透露“删除”操作的存在，统一为中性 404 文案
      if (!row) return json({ message: '文章不存在' }, 404);
      // 浏览次数 +1（写失败不影响本次读取，单独兜底）
      try {
        await env.DB.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').bind(Number(detailMatch[1])).run();
      } catch (e) { /* 忽略计数写失败 */ }
      // 文章点赞数（前端点赞按钮初始展示）
      const likeRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM likes WHERE target_type = 'article' AND target_id = ?"
      ).bind(Number(detailMatch[1])).first();
      return json({
        article: {
          ...row, link: sanitizeLink(row.link), views: (row.views || 0) + 1,
          likes: Number(likeRow && likeRow.c) || 0,
        },
      });
    }

    /* ---------- 前台评论（REQ-25 ~ 31 / BC-27 ~ 36） ---------- */
    const commentMatch = path.match(/^\/api\/articles\/(\d+)\/comments$/);
    if (commentMatch && method === 'GET') {
      const aid = Number(commentMatch[1]);
      const article = await env.DB.prepare('SELECT id FROM articles WHERE id = ?').bind(aid).first();
      if (!article) return json({ message: '文章不存在' }, 404); // BC-32（公开接口中性文案）
      // 数据最小化：公开接口不返回 email（评论邮箱仅存库供作者回信，后台 /api/admin/comments 仍可查）
      // parent_id：回复关系（0 = 顶级）；likes：每条评论的点赞数（前端点赞按钮展示）
      const rows = await env.DB.prepare(
        'SELECT id, nickname, content, created_at, parent_id FROM comments WHERE article_id = ? ORDER BY id ASC'
      ).bind(aid).all();
      let likeMap = {};
      const ids = rows.results.map((r) => r.id).filter(Boolean);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const likes = await env.DB.prepare(
          `SELECT target_id, COUNT(*) AS c FROM likes WHERE target_type = 'comment' AND target_id IN (${ph}) GROUP BY target_id`
        ).bind(...ids).all();
        likeMap = Object.fromEntries(likes.results.map((r) => [r.target_id, Number(r.c)]));
      }
      return json({
        comments: rows.results.map((r) => ({ ...r, likes: likeMap[r.id] || 0 })),
        count: rows.results.length,
      });
    }
    if (commentMatch && method === 'POST') {
      const aid = Number(commentMatch[1]);
      const article = await env.DB.prepare('SELECT id FROM articles WHERE id = ?').bind(aid).first();
      if (!article) return json({ message: '文章不存在' }, 404); // BC-32（公开接口中性文案）

      const body = await readBody(request);
      if (!body) return json({ message: '请求体格式错误' }, 400);
      const result = validateComment(body);
      if (result.error) return json({ message: result.error }, 400);
      const { nickname, email, content } = result.value;
      const ip = clientIp;

      // 回复目标（选填）：须存在且属于当前文章；仅允许一级嵌套（只能回复顶级评论）
      let parentId = 0;
      if (body.parent_id !== undefined && body.parent_id !== null && body.parent_id !== '') {
        parentId = Number(body.parent_id);
        if (!Number.isInteger(parentId) || parentId <= 0) {
          return json({ message: '回复目标无效' }, 400);
        }
        const parent = await env.DB.prepare(
          'SELECT id, article_id, parent_id FROM comments WHERE id = ?'
        ).bind(parentId).first();
        if (!parent) return json({ message: '被回复的评论不存在' }, 404);
        if (Number(parent.article_id) !== aid) return json({ message: '被回复的评论不属于当前文章' }, 400);
        if (Number(parent.parent_id) !== 0) return json({ message: '暂不支持多层回复，请回复顶级评论' }, 400);
      }

      // 防重复提交（REQ-30 / BC-33）：同 IP + 同文章 + 同回复目标 + 同内容，60 秒窗口（基于 UTC 纪元秒 created_ms，不受时区影响）
      const last = await env.DB.prepare(
        'SELECT created_ms FROM comments WHERE article_id = ? AND ip = ? AND content = ? AND parent_id = ? ORDER BY id DESC LIMIT 1'
      ).bind(aid, ip, content, parentId).first();
      if (last && last.created_ms && Date.now() - last.created_ms * 1000 < COMMENT_DUP_WINDOW_MS) {
        return json({ message: '请勿重复提交评论' }, 429);
      }
      // 按 IP 限流（REQ-31 / BC-34）：每小时最多 COMMENT_HOUR_LIMIT 条（同样基于 created_ms）
      const hourCutoff = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
      const hourCount = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM comments WHERE ip = ? AND created_ms >= ?'
      ).bind(ip, hourCutoff).first();
      if (hourCount && Number(hourCount.c) >= COMMENT_HOUR_LIMIT) {
        return json({ message: '评论过于频繁，请稍后再试' }, 429);
      }

      const ins = await env.DB.prepare(
        'INSERT INTO comments (article_id, nickname, email, content, ip, parent_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(aid, nickname, email, content, ip, parentId).run();
      const newId = ins && ins.meta ? Number(ins.meta.last_row_id) : 0;
      return json({ success: true, id: newId, message: parentId ? '回复发布成功' : '评论发布成功' });
    }

    /* ---------- 点赞切换（文章/评论：按 IP 幂等，再点取消；与本地 Express 版行为一致） ---------- */
    const articleLikeMatch = path.match(/^\/api\/articles\/(\d+)\/like$/);
    if (articleLikeMatch && method === 'POST') {
      const aid = Number(articleLikeMatch[1]);
      const article = await env.DB.prepare('SELECT id FROM articles WHERE id = ?').bind(aid).first();
      if (!article) return json({ message: '文章不存在' }, 404);
      const ip = clientIp;
      const existing = await env.DB.prepare(
        "SELECT id FROM likes WHERE target_type = 'article' AND target_id = ? AND ip = ?"
      ).bind(aid, ip).first();
      let liked;
      if (existing) {
        await env.DB.prepare('DELETE FROM likes WHERE id = ?').bind(existing.id).run();
        liked = false;
      } else {
        await env.DB.prepare("INSERT INTO likes (target_type, target_id, ip) VALUES ('article', ?, ?)")
          .bind(aid, ip).run();
        liked = true;
      }
      const c = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM likes WHERE target_type = 'article' AND target_id = ?"
      ).bind(aid).first();
      return json({ success: true, liked, likes: Number(c && c.c) || 0 });
    }

    const commentLikeMatch = path.match(/^\/api\/comments\/(\d+)\/like$/);
    if (commentLikeMatch && method === 'POST') {
      const cid = Number(commentLikeMatch[1]);
      const cm = await env.DB.prepare('SELECT id FROM comments WHERE id = ?').bind(cid).first();
      if (!cm) return json({ message: '评论不存在' }, 404);
      const ip = clientIp;
      const existing = await env.DB.prepare(
        "SELECT id FROM likes WHERE target_type = 'comment' AND target_id = ? AND ip = ?"
      ).bind(cid, ip).first();
      let liked;
      if (existing) {
        await env.DB.prepare('DELETE FROM likes WHERE id = ?').bind(existing.id).run();
        liked = false;
      } else {
        await env.DB.prepare("INSERT INTO likes (target_type, target_id, ip) VALUES ('comment', ?, ?)")
          .bind(cid, ip).run();
        liked = true;
      }
      const c = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM likes WHERE target_type = 'comment' AND target_id = ?"
      ).bind(cid).first();
      return json({ success: true, liked, likes: Number(c && c.c) || 0 });
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
        let sql = "SELECT id, title, category, tags, link, format, views, updated_at, created_at FROM articles WHERE 1=1";
        const args = [];
        if (keyword) { sql += ' AND title LIKE ?'; args.push(`%${keyword}%`); }
        if (category) { sql += ' AND category = ?'; args.push(category); }
        if (tag) { sql += ' AND tags LIKE ?'; args.push(`%${tag}%`); }
        sql += ' ORDER BY created_at DESC, id DESC';
        const stmt = env.DB.prepare(sql);
        const rows = args.length ? await stmt.bind(...args).all() : await stmt.all();
        return json({ articles: rows.results.map((a) => ({ ...a, link: sanitizeLink(a.link) })) });
      }
      // 提交文章（REQ-10 ~ 18）
      if (method === 'POST') {
        const auth = await requireAdminWrite(request, env);
        if (auth.error) return auth.error;
        const body = await readBody(request);
        if (!body) return json({ message: '请求体格式错误' }, 400);
        const result = validateArticle(body);
        if (result.error) return json({ message: result.error }, 400);
        const { title, content, category, tags, link, format } = result.value;

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
          'INSERT INTO articles (id, title, content, category, tags, link, format, created_at, updated_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))"
        ).bind(newId, title, content, category, tags, link, format).run();
        // IndexNow：新文章即时通知（未配置 key 时自动跳过）
        indexNowUrls(env, ['https://' + new URL(request.url).host + '/article?id=' + newId]);
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

      const { title, content, category, tags, link, format } = result.value;
      await env.DB.prepare(
        "UPDATE articles SET title = ?, content = ?, category = ?, tags = ?, link = ?, format = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).bind(title, content, category, tags, link, format, id).run();
      // IndexNow：内容更新即时通知
      indexNowUrls(env, ['https://' + new URL(request.url).host + '/article?id=' + id]);
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
        // 点赞清理：这些文章的全部评论点赞 + 文章点赞
        const cmRows = await env.DB.prepare(
          `SELECT id FROM comments WHERE article_id IN (${placeholders})`
        ).bind(...existIds).all();
        const cmIds = cmRows.results.map((r) => r.id);
        if (cmIds.length) {
          const cmPh = cmIds.map(() => '?').join(',');
          await env.DB.prepare(
            `DELETE FROM likes WHERE target_type = 'comment' AND target_id IN (${cmPh})`
          ).bind(...cmIds).run();
        }
        await env.DB.prepare(
          `DELETE FROM likes WHERE target_type = 'article' AND target_id IN (${placeholders})`
        ).bind(...existIds).run();
        await env.DB.prepare(`DELETE FROM comments WHERE article_id IN (${placeholders})`).bind(...existIds).run();
        await env.DB.prepare(`DELETE FROM articles WHERE id IN (${placeholders})`).bind(...existIds).run();
        // IndexNow：批量删除通知
        const host = new URL(request.url).host;
        indexNowUrls(env, existIds.map((i) => `https://${host}/article?id=${i}`), { deleteMode: true });
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
      // 级联清理点赞：该文章的评论点赞 + 文章点赞（先删点赞再删评论/文章）
      const cmIds = (await env.DB.prepare(
        'SELECT id FROM comments WHERE article_id = ?'
      ).bind(id).all()).results.map((r) => r.id);
      if (cmIds.length) {
        const cmPh = cmIds.map(() => '?').join(',');
        await env.DB.prepare(
          `DELETE FROM likes WHERE target_type = 'comment' AND target_id IN (${cmPh})`
        ).bind(...cmIds).run();
      }
      await env.DB.prepare("DELETE FROM likes WHERE target_type = 'article' AND target_id = ?").bind(id).run();
      await env.DB.prepare('DELETE FROM comments WHERE article_id = ?').bind(id).run(); // 级联清理评论
      await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
      // IndexNow：URL 删除通知（搜索引擎从索引移除）
      indexNowUrls(env, ['https://' + new URL(request.url).host + '/article?id=' + id], { deleteMode: true });
      return json({ success: true, message: '删除成功' });
    }

    /* ---------- 后台评论管理（REQ-32 / REQ-33 / BC-35） ---------- */
    if (path === '/api/admin/comments' && method === 'GET') {
      const session = await getAdminSession(request, env);
      if (!session) return unauthorized();
      const articleId = url.searchParams.get('articleId') || '';
      // 含回复关系（parent_id / 被回复人昵称）与回复数（删除提示用）
      let sql =
        'SELECT c.id, c.article_id, a.title AS article_title, c.nickname, c.email, c.content, c.ip, ' +
        'c.parent_id, p.nickname AS parent_nickname, ' +
        '(SELECT COUNT(*) FROM comments ch WHERE ch.parent_id = c.id) AS reply_count, c.created_at ' +
        'FROM comments c LEFT JOIN articles a ON a.id = c.article_id LEFT JOIN comments p ON p.id = c.parent_id';
      const args = [];
      if (articleId && Number.isInteger(Number(articleId)) && Number(articleId) > 0) {
        sql += ' WHERE c.article_id = ?';
        args.push(Number(articleId));
      }
      sql += ' ORDER BY c.id DESC';
      const stmt = env.DB.prepare(sql);
      const rows = args.length ? await stmt.bind(...args).all() : await stmt.all();
      return json({ comments: rows.results });
    }

    const adminCmMatch = path.match(/^\/api\/admin\/comments\/(\d+)$/);
    if (adminCmMatch && method === 'DELETE') {
      const auth = await requireAdminWrite(request, env);
      if (auth.error) return auth.error;
      const id = Number(adminCmMatch[1]);
      const row = await env.DB.prepare('SELECT id, parent_id FROM comments WHERE id = ?').bind(id).first();
      if (!row) return json({ message: '评论不存在或已被删除' }, 404);
      // 级联：顶级评论连同其全部回复一并删除，并清理它们对应的点赞
      const childIds = (await env.DB.prepare(
        'SELECT id FROM comments WHERE parent_id = ?'
      ).bind(id).all()).results.map((r) => r.id);
      const delIds = [id, ...childIds];
      const delPh = delIds.map(() => '?').join(',');
      await env.DB.prepare(
        `DELETE FROM likes WHERE target_type = 'comment' AND target_id IN (${delPh})`
      ).bind(...delIds).run();
      await env.DB.prepare(`DELETE FROM comments WHERE id IN (${delPh})`).bind(...delIds).run();
      return json({
        success: true,
        deleted: delIds.length,
        message: childIds.length ? `删除成功（连同 ${childIds.length} 条回复）` : '删除成功',
      });
    }

    return json({ message: '接口不存在' }, 404);
  } catch (e) {
    console.error('[functions]', e && e.stack ? e.stack : String(e));
    return json({ message: '系统繁忙，请稍后重试' }, 500); // BC-07 / BC-20 / BC-26
  }
}
