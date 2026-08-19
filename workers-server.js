/**
 * workers-server.js — Cloudflare Workers 版本的后端服务端
 * 适配 Cloudflare D1 数据库 + Workers Runtime
 * 
 * API 路由清单：
 * - GET  /api/articles           前台文章列表（支持 keyword/category/tag）
 * - GET  /api/articles/:id       前台文章详情
 * - GET  /api/articles/tags      标签统计（标签云）
 * - POST /api/login              管理员登录
 * - POST /api/logout             登出
 * - GET  /api/auth/status        登录状态
 * - GET  /api/csrf-token         获取 CSRF Token
 * - GET  /api/admin/articles     后台文章列表（支持 keyword/category/tag）
 * - POST /api/admin/articles     创建文章
 * - PUT  /api/admin/articles/:id 更新文章
 * - DELETE /api/admin/articles/:id 删除文章
 * - POST /api/admin/articles/batch-delete 批量删除
 */

const ALLOWED_CATEGORIES = ['博客', '学习笔记', '生活感悟'];
const MAX_TITLE_LEN = 100;
const MAX_CONTENT_LEN = 50000;
const MAX_TAG_COUNT = 5;
const MAX_TAG_LEN = 20;
const TAG_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/;

// Session 存储（Workers 内存，生产环境建议用 KV）
const sessions = new Map();
const loginAttempts = new Map();

// 生成 CSRF Token
function generateCsrfToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// 密码哈希（使用 Web Crypto API）
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

// 验证密码（简化版，生产环境建议用 bcryptjs 的 WASM 版本）
async function verifyPassword(password, hash) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const currentHash = await crypto.subtle.digest('SHA-256', data);
  const currentHashStr = btoa(String.fromCharCode(...new Uint8Array(currentHash)));
  return currentHashStr === hash;
}

// 生成文章摘要
function makeSummary(content, maxLen = 120) {
  const text = String(content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

// 获取 Session
function getSession(cookieHeader) {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sidCookie = cookies.find(c => c.startsWith('sid='));
  if (!sidCookie) return null;
  const sessionId = sidCookie.split('=')[1];
  return sessions.get(sessionId) || null;
}

// 设置 Session Cookie
function setSessionCookie(sessionId) {
  return `sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 60}`;
}

// 检查管理员登录状态
function isAdminLoggedIn(session) {
  return session && session.adminId !== undefined;
}

// 验证 CSRF Token
function verifyCsrf(request, session) {
  const token = request.headers.get('X-CSRF-Token') || '';
  return token === session?.csrfToken;
}

// 文章字段校验
function validateArticle(body) {
  const title = (body.title || '').trim();
  const rawContent = body.content || '';
  const category = (body.category || '').trim();
  const rawTags = body.tags || '';

  if (!title) return { error: '标题不能为空' };
  if (title.length > MAX_TITLE_LEN) return { error: `标题不能超过 ${MAX_TITLE_LEN} 个字符` };
  if (!ALLOWED_CATEGORIES.includes(category)) return { error: '请选择有效类别' };
  if (!rawContent.trim()) return { error: '内容不能为空' };
  if (rawContent.length > MAX_CONTENT_LEN) return { error: `内容不能超过 ${MAX_CONTENT_LEN} 个字符` };

  let tags = [];
  if (rawTags.trim()) {
    tags = rawTags.split(/[,，]/).map(t => t.trim()).filter(Boolean);
    if (tags.length > MAX_TAG_COUNT) return { error: `标签最多 ${MAX_TAG_COUNT} 个` };
    for (const t of tags) {
      if (t.length > MAX_TAG_LEN) return { error: `单个标签不能超过 ${MAX_TAG_LEN} 个字符` };
      if (!TAG_PATTERN.test(t)) return { error: '标签仅允许中文/英文/数字/下划线/连字符' };
    }
    tags = [...new Set(tags)];
  }

  return { value: { title, content: rawContent, category, tags: tags.join(',') } };
}

// 主请求处理函数
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 读取 Cookie
  const cookieHeader = request.headers.get('Cookie') || '';
  const session = getSession(cookieHeader);

  // 后台页面访问控制
  if (path.startsWith('/admin/')) {
    if (path === '/admin/login.html') {
      return new Response(null, { status: 302, headers: { Location: '/admin/' } });
    }
    if (!isAdminLoggedIn(session) && path !== '/admin/login.html') {
      return new Response(JSON.stringify({ message: '未登录或会话已过期' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // ========== API 路由分发 ==========
  
  // 前台文章列表（支持 keyword/category/tag 筛选）
  if (path === '/api/articles' && method === 'GET') {
    return await handleGetArticles(request, env);
  }

  // 前台文章详情
  if (path.startsWith('/api/articles/') && method === 'GET') {
    const id = parseInt(path.split('/').pop());
    if (isNaN(id)) {
      return new Response(JSON.stringify({ message: '文章不存在或已被删除' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    return await handleGetArticle(id, env);
  }

  // 标签统计（标签云）
  if (path === '/api/articles/tags' && method === 'GET') {
    return await handleGetTags(env);
  }

  // 后台文章列表（支持 keyword/category/tag 筛选）
  if (path === '/api/admin/articles' && method === 'GET') {
    if (!isAdminLoggedIn(session)) {
      return new Response(JSON.stringify({ message: '未登录' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
    return await handleAdminGetArticles(request, env, session);
  }

  // 后台创建文章
  if (path === '/api/admin/articles' && method === 'POST') {
    if (!isAdminLoggedIn(session) || !verifyCsrf(request, session)) {
      return new Response(JSON.stringify({ message: '未授权' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }
    return await handleCreateArticle(request, env, session);
  }

  // 后台更新文章
  const updateMatch = path.match(/^\/api\/admin\/articles\/(\d+)$/);
  if (updateMatch && method === 'PUT') {
    if (!isAdminLoggedIn(session) || !verifyCsrf(request, session)) {
      return new Response(JSON.stringify({ message: '未授权' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }
    const id = parseInt(updateMatch[1]);
    return await handleUpdateArticle(id, request, env, session);
  }

  // 后台删除文章
  const deleteMatch = path.match(/^\/api\/admin\/articles\/(\d+)$/);
  if (deleteMatch && method === 'DELETE') {
    if (!isAdminLoggedIn(session) || !verifyCsrf(request, session)) {
      return new Response(JSON.stringify({ message: '未授权' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }
    const id = parseInt(deleteMatch[1]);
    return await handleDeleteArticle(id, env, session);
  }

  // 后台批量删除
  if (path === '/api/admin/articles/batch-delete' && method === 'POST') {
    if (!isAdminLoggedIn(session) || !verifyCsrf(request, session)) {
      return new Response(JSON.stringify({ message: '未授权' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }
    return await handleBatchDelete(request, env, session);
  }

  // 登录相关
  if (path === '/api/login' && method === 'POST') {
    return await handleLogin(request, env);
  }

  if (path === '/api/logout' && method === 'POST') {
    return handleLogout(session);
  }

  if (path === '/api/auth/status' && method === 'GET') {
    return handleAuthStatus(session);
  }

  if (path === '/api/csrf-token' && method === 'GET') {
    if (!isAdminLoggedIn(session)) {
      return new Response(JSON.stringify({ message: '未登录' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ csrfToken: session.csrfToken }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 404 - 接口不存在
  return new Response(JSON.stringify({ 
    message: '接口不存在',
    path: path,
    method: method
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ==================== 前台 API ====================

// 获取前台文章列表（支持 keyword/category/tag）
async function handleGetArticles(request, env) {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '';
    const keyword = url.searchParams.get('keyword') || '';
    const tag = url.searchParams.get('tag') || '';

    let sql = 'SELECT id, title, category, tags, link, content, created_at FROM articles WHERE 1=1';
    const params = [];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (keyword) {
      sql += ' AND title LIKE ?';
      params.push('%' + keyword + '%');
    }
    if (tag) {
      sql += ' AND tags LIKE ?';
      params.push('%' + tag + '%');
    }
    sql += ' ORDER BY created_at DESC, id DESC';

    const result = await env.DB.prepare(sql).all(params);
    const articles = result.results.map(a => ({ ...a, summary: makeSummary(a.content) }));

    return new Response(JSON.stringify({ articles }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[articles.list]', e);
    return new Response(JSON.stringify({ message: '系统繁忙，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 获取文章详情
async function handleGetArticle(id, env) {
  try {
    const article = await env.DB.prepare(
      'SELECT id, title, content, category, tags, link, created_at FROM articles WHERE id = ?'
    ).get(id);
    
    if (!article) {
      return new Response(JSON.stringify({ message: '文章不存在或已被删除' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ article }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[articles.detail]', e);
    return new Response(JSON.stringify({ message: '系统繁忙，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 获取标签统计（标签云）
async function handleGetTags(env) {
  try {
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

    return new Response(JSON.stringify({ tags }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[articles.tags]', e);
    return new Response(JSON.stringify({ message: '系统繁忙，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ==================== 后台 API ====================

// 获取后台文章列表（支持 keyword/category/tag）
async function handleAdminGetArticles(request, env, session) {
  try {
    const url = new URL(request.url);
    const keyword = url.searchParams.get('keyword') || '';
    const category = url.searchParams.get('category') || '';
    const tag = url.searchParams.get('tag') || '';

    let sql = "SELECT id, title, category, tags, link, created_at FROM articles WHERE link = ''";
    const params = [];
    
    if (keyword) {
      sql += ' AND title LIKE ?';
      params.push('%' + keyword + '%');
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (tag) {
      sql += ' AND tags LIKE ?';
      params.push('%' + tag + '%');
    }
    sql += ' ORDER BY created_at DESC, id DESC';

    const result = await env.DB.prepare(sql).all(params);
    return new Response(JSON.stringify({ articles: result.results }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[admin.articles.list]', e);
    return new Response(JSON.stringify({ message: '系统繁忙，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 创建文章
async function handleCreateArticle(request, env, session) {
  try {
    const body = await request.json();
    const result = validateArticle(body);
    if (result.error) {
      return new Response(JSON.stringify({ message: result.error }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const { title, content, category, tags } = result.value;

    // 获取最小可用 id
    const nextRow = await env.DB.prepare(`
      SELECT t.id FROM (
        SELECT 1 AS id
        UNION ALL
        SELECT id + 1 FROM articles
      ) t
      WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = t.id)
      ORDER BY t.id LIMIT 1
    `).get();
    const newId = nextRow?.id || 1;

    await env.DB.prepare(
      'INSERT INTO articles (id, title, content, category, tags) VALUES (?, ?, ?, ?, ?)'
    ).run(newId, title, content, category, tags);

    return new Response(JSON.stringify({ success: true, id: newId, message: '发布成功' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[admin.articles.create]', e);
    return new Response(JSON.stringify({ message: '发布失败，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 更新文章
async function handleUpdateArticle(id, request, env, session) {
  try {
    const body = await request.json();
    const result = validateArticle(body);
    if (result.error) {
      return new Response(JSON.stringify({ message: result.error }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证文章存在
    const row = await env.DB.prepare('SELECT id FROM articles WHERE id = ?').get(id);
    if (!row) {
      return new Response(JSON.stringify({ message: '文章不存在或已被删除' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    const { title, content, category, tags } = result.value;
    await env.DB.prepare(
      'UPDATE articles SET title = ?, content = ?, category = ?, tags = ? WHERE id = ?'
    ).run(title, content, category, tags, id);

    return new Response(JSON.stringify({ success: true, message: '更新成功' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[admin.articles.update]', e);
    return new Response(JSON.stringify({ message: '更新失败，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 删除文章
async function handleDeleteArticle(id, env, session) {
  try {
    const row = await env.DB.prepare('SELECT id FROM articles WHERE id = ?').get(id);
    if (!row) {
      return new Response(JSON.stringify({ message: '文章不存在或已被删除' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }
    await env.DB.prepare('DELETE FROM articles WHERE id = ?').run(id);
    return new Response(JSON.stringify({ success: true, message: '删除成功' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[admin.articles.delete]', e);
    return new Response(JSON.stringify({ message: '删除失败，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 批量删除
async function handleBatchDelete(request, env, session) {
  try {
    const body = await request.json();
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) {
      return new Response(JSON.stringify({ message: '请选择要删除的文章' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const placeholders = ids.map(() => '?').join(',');
    const existing = await env.DB.prepare(`SELECT id FROM articles WHERE id IN (${placeholders})`).all(ids);
    const existIds = existing.results.map(r => r.id);

    if (existIds.length) {
      await env.DB.prepare(`DELETE FROM articles WHERE id IN (${placeholders})`).run(...existIds);
    }

    return new Response(JSON.stringify({ 
      success: true, 
      deleted: existIds.length, 
      message: `删除成功（${existIds.length} 篇）`
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[admin.articles.batchDelete]', e);
    return new Response(JSON.stringify({ message: '删除失败，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ==================== 认证 API ====================

// 登录处理
async function handleLogin(request, env) {
  try {
    const body = await request.json();
    const username = (body.username || '').trim();
    const password = body.password || '';

    if (!username || !password) {
      return new Response(JSON.stringify({ message: '请输入用户名和密码' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const key = username.toLowerCase();
    const now = Date.now();
    const rec = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };

    // 账户锁定检查
    if (rec.lockedUntil > now) {
      const minutes = Math.ceil((rec.lockedUntil - now) / 60000);
      return new Response(JSON.stringify({ message: `账户已锁定，请 ${minutes} 分钟后再试` }), {
        status: 423, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 查询管理员
    const admin = await env.DB.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin) {
      rec.count += 1;
      if (rec.count >= 5) {
        rec.lockedUntil = now + 15 * 60 * 1000;
        rec.count = 0;
      }
      loginAttempts.set(key, rec);
      return new Response(JSON.stringify({ message: '用户名或密码错误' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }

    const ok = await verifyPassword(password, admin.password_hash);
    if (!ok) {
      rec.count += 1;
      if (rec.count >= 5) {
        rec.lockedUntil = now + 15 * 60 * 1000;
        rec.count = 0;
      }
      loginAttempts.set(key, rec);
      return new Response(JSON.stringify({ message: '用户名或密码错误' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }

    loginAttempts.delete(key);

    // 创建 Session
    const sessionId = generateCsrfToken();
    const newSession = {
      adminId: admin.id,
      username: admin.username,
      loginAt: now,
      csrfToken: generateCsrfToken()
    };
    sessions.set(sessionId, newSession);

    return new Response(JSON.stringify({ success: true, username: admin.username }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(sessionId)
      }
    });
  } catch (e) {
    console.error('[login]', e);
    return new Response(JSON.stringify({ message: '系统繁忙，请稍后重试' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 登出处理
function handleLogout(session) {
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'sid=; Path=/; Max-Age=0'
    }
  });
}

// 登录状态
function handleAuthStatus(session) {
  if (!session || !isAdminLoggedIn(session)) {
    return new Response(JSON.stringify({ loggedIn: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({
    loggedIn: true,
    username: session.username
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// Workers 入口
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
