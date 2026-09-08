/**
 * test-functions.mjs — Cloudflare Pages Functions 端到端测试
 * 用 better-sqlite3 模拟 D1 接口，直接调用 functions/api/[[path]].js 的 onRequest
 * 运行方式：node test-functions.mjs
 */
import Database from 'better-sqlite3';
import { onRequest } from './functions/api/[[path]].mjs';

/* ================= Mock D1（实现 prepare/bind/all/first/run/batch） ================= */
class MockStmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  // 与 D1 一致：bind 返回持有本次参数的新语句（每次绑定独立，batch 中逐条生效）
  bind(...args) {
    const s = new MockStmt(this.db, this.sql);
    s.args = args;
    return s;
  }
  async all() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return { results: rows, success: true };
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.args);
    return row === undefined ? null : row;
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
  }
}
class MockDB {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new MockStmt(this.db, sql);
  }
  async exec(sql) {
    // D1 的 exec 支持多语句/PRAGMA；内存库用 better-sqlite3 等价执行，失败则忽略（不影响用例）
    try {
      this.db.exec(sql);
    } catch {
      /* pragma 类语句在内存库中可忽略 */
    }
    return [];
  }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

/* ================= 请求模拟 ================= */
let jar = {}; // cookie jar
function applyCookies(setCookies) {
  for (const c of setCookies || []) {
    const pair = c.split(';')[0];
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (/Max-Age=0/.test(c)) delete jar[name];
    else jar[name] = decodeURIComponent(value); // 与浏览器存储原始值一致
  }
}
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(path, { method = 'GET', body, csrf, headers = {} } = {}) {
  const h = new Headers(headers);
  const ck = cookieHeader();
  if (ck) h.set('Cookie', ck);
  if (csrf) h.set('X-CSRF-Token', csrf);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const request = new Request('https://test.local' + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const response = await onRequest({
    request,
    env: { DB: new MockDB(db), SESSION_SECRET: 'test-secret' },
    params: {},
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  applyCookies(setCookies);
  return { status: response.status, data, text, setCookies };
}

/* ================= 用例 ================= */
const db = new Database(':memory:');
let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log('\n[1] 初始化与前台');
let r = await call('/api/articles');
check('文章列表 200 且含 3 篇种子', r.status === 200 && r.data.articles.length === 3, `got ${r.status} n=${r.data.articles && r.data.articles.length}`);
r = await call('/api/articles/1');
check('文章详情 200', r.status === 200 && !!r.data.article, `got ${r.status}`);
r = await call('/api/articles?category=博客');
check('类别过滤生效', r.status === 200 && r.data.articles.every((a) => a.category === '博客'), `got ${r.status}`);

console.log('\n[2] 未授权拦截');
r = await call('/api/admin/articles');
check('未登录管理列表 → 401', r.status === 401, `got ${r.status}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>' } });
check('未登录提交 → 401', r.status === 401, `got ${r.status}`);
r = await call('/api/admin/articles/1', { method: 'DELETE' });
check('未登录删除 → 401', r.status === 401, `got ${r.status}`);
r = await call('/api/csrf-token');
check('未登录 CSRF → 401', r.status === 401, `got ${r.status}`);

console.log('\n[3] 登录流程');
r = await call('/api/login', { method: 'POST', body: { username: '  ', password: '' } });
check('空白提交 → 400', r.status === 400 && r.data.message === '请输入用户名和密码', `got ${r.status}`);
r = await call('/api/login', { method: 'POST', body: { username: 'nobody', password: 'x' } });
check('用户名不存在 → 401 统一提示', r.status === 401 && r.data.message === '用户名或密码错误', `got ${r.status}`);
r = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
check('密码错误 → 401 统一提示', r.status === 401 && r.data.message === '用户名或密码错误', `got ${r.status}`);
r = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
check('正确凭据 → 200', r.status === 200 && r.data.success, `got ${r.status} ${r.text}`);
check('签发 sid+csrf cookie', r.setCookies.some((c) => c.startsWith('sid=')) && r.setCookies.some((c) => c.startsWith('csrf=')), JSON.stringify(r.setCookies));
r = await call('/api/auth/status');
check('状态 → loggedIn', r.status === 200 && r.data.loggedIn === true, `got ${r.status}`);
r = await call('/api/csrf-token');
const csrf = r.data && r.data.csrfToken;
check('获取 CSRF Token', r.status === 200 && !!csrf && csrf === jar.csrf, `got ${r.status} ${r.text}`);

console.log('\n[4] 文章提交与校验');
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'CF测试文章', category: '学习笔记', content: '<p>这是<b>测试</b>内容</p>', tags: '测试,学习,学习' }, csrf });
check('合法文章 → 200 发布成功', r.status === 200 && r.data.success && r.data.message === '发布成功', `got ${r.status} ${r.text}`);
const newId = r.data && r.data.id;
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'CF测试文章', category: '学习笔记', content: '<p>这是<b>测试</b>内容</p>', tags: '测试,学习,学习' }, csrf });
check('5 秒内重复提交 → 429', r.status === 429, `got ${r.status} ${r.text}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: '', category: '博客', content: '<p>x</p>' }, csrf });
check('标题为空 → 400', r.status === 400, `got ${r.status}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: '长'.repeat(101), category: '博客', content: '<p>x</p>' }, csrf });
check('标题超长 → 400', r.status === 400, `got ${r.status}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '非法', content: '<p>x</p>' }, csrf });
check('非法类别 → 400', r.status === 400, `got ${r.status}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '  <p> </p> ' }, csrf });
check('内容空 → 400', r.status === 400, `got ${r.status}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>', tags: 'a,b,c,d,e,f' }, csrf });
check('标签超 5 个 → 400', r.status === 400, `got ${r.status}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>', tags: 'bad!!' }, csrf });
check('标签非法字符 → 400', r.status === 400, `got ${r.status}`);

// XSS
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'XSS测试', category: '博客', content: '<p>安全内容</p><script>alert(1)</script><img src=x onerror=alert(2)><iframe src=evil></iframe>', tags: '安全' }, csrf });
check('XSS 载荷提交成功', r.status === 200, `got ${r.status} ${r.text}`);
if (r.status === 200) {
  const xssId = r.data.id;
  const d = await call('/api/articles/' + xssId);
  const c = d.data.article.content;
  check('内容已去 script/iframe/onerror', !/script|iframe|onerror/i.test(c) && c.includes('安全内容'), `content=${c}`);
  await call('/api/admin/articles/' + xssId, { method: 'DELETE', csrf });
}

// 缺 CSRF
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>' } });
check('缺 CSRF → 403', r.status === 403, `got ${r.status}`);

console.log('\n[5] 列表检索与删除');
r = await call('/api/admin/articles?keyword=CF');
check('检索命中', r.status === 200 && r.data.articles.some((a) => a.id === newId), `got ${r.status}`);
r = await call('/api/admin/articles/' + newId, { method: 'DELETE', csrf });
check('删除成功', r.status === 200 && r.data.message === '删除成功', `got ${r.status} ${r.text}`);
r = await call('/api/articles/' + newId);
check('删除后前台 404', r.status === 404, `got ${r.status}`);
r = await call('/api/admin/articles/99999', { method: 'DELETE', csrf });
check('删除不存在 → 404 提示', r.status === 404 && r.data.message === '文章不存在或已被删除', `got ${r.status} ${r.text}`);

const ids = [];
for (let i = 0; i < 2; i++) {
  r = await call('/api/admin/articles', { method: 'POST', body: { title: `批量${i}`, category: '生活感悟', content: '<p>b</p>' }, csrf });
  ids.push(r.data.id);
}
r = await call('/api/admin/articles/batch-delete', { method: 'POST', body: { ids }, csrf });
check('批量删除 2 篇', r.status === 200 && r.data.deleted === 2, `got ${r.status} ${r.text}`);
r = await call('/api/admin/articles/batch-delete', { method: 'POST', body: { ids: [] }, csrf });
check('批量删除空选 → 400', r.status === 400, `got ${r.status}`);

console.log('\n[5.5] 评论功能（REQ-25 ~ 33 / BC-27 ~ 36）');
// 先验证未登录拦截（清空会话）
jar = {};
r = await call('/api/admin/comments');
check('未登录后台评论列表 → 401', r.status === 401, `got ${r.status}`);
r = await call('/api/admin/comments/1', { method: 'DELETE' });
check('未登录删除评论 → 401', r.status === 401, `got ${r.status}`);
// 重新登录
r = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
check('重新登录成功', r.status === 200, `got ${r.status}`);
r = await call('/api/csrf-token');
const cmsf = r.data && r.data.csrfToken;

// BC-32 文章不存在
r = await call('/api/articles/999999/comments');
check('BC-32 读取不存在文章的评论 → 404', r.status === 404, `got ${r.status}`);
// REQ-27 空列表
r = await call('/api/articles/1/comments');
check('REQ-27 评论列表初始为空', r.status === 200 && r.data.count === 0, `got ${r.status} count=${r.data && r.data.count}`);
// REQ-25/26 正常评论
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: '测试君', email: 't@e.com', content: '写得很棒' } });
check('REQ-25/26 正常评论入库', r.status === 200 && r.data.success, `got ${r.status} ${r.text}`);
// BC-27 昵称空
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: '  ', content: 'x' } });
check('BC-27 昵称为空 → 400', r.status === 400 && /昵称/.test(r.data.message || ''), `got ${r.status} ${r.text}`);
// BC-28 内容空
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: 'a', content: '   ' } });
check('BC-28 内容为空 → 400', r.status === 400 && /评论内容/.test(r.data.message || ''), `got ${r.status} ${r.text}`);
// BC-31 XSS 过滤
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: 'hacker', content: '<script>alert(1)</script>哈哈' } });
check('BC-31 XSS 载荷提交成功', r.status === 200, `got ${r.status}`);
{
  const d = await call('/api/articles/1/comments');
  const xssRow = d.data.comments.find((c) => c.nickname === 'hacker');
  check('BC-31 入库后为纯文本', !!xssRow && !xssRow.content.includes('<') && xssRow.content.includes('哈哈'), `content=${xssRow && JSON.stringify(xssRow.content)}`);
}
// BC-30 邮箱非法
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: 'a', email: 'not-email', content: 'hi' } });
check('BC-30 邮箱非法 → 400', r.status === 400 && /邮箱/.test(r.data.message || ''), `got ${r.status} ${r.text}`);
// BC-29 超长
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: 'a', content: 'x'.repeat(1001) } });
check('BC-29 内容超长 → 400', r.status === 400 && /1000/.test(r.data.message || ''), `got ${r.status}`);
// REQ-30 防重复
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: 'dup', content: 'CF重复测试ABC' } });
const dupFirst = r.status;
r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: 'dup', content: 'CF重复测试ABC' } });
check('REQ-30 60s 内重复 → 429', dupFirst === 200 && r.status === 429, `first=${dupFirst} second=${r.status}`);
// REQ-29 级联删除（先于限流测试，避免占用 IP 限流配额）
{
  const c2 = await call('/api/articles/2/comments', { method: 'POST', body: { nickname: 'c', content: 'will-be-cascade' } });
  const delArt = await call('/api/admin/articles/2', { method: 'DELETE', csrf: cmsf });
  const cmAfter = await call('/api/admin/comments?articleId=2');
  check(
    'REQ-29 删除文章后评论级联清理',
    c2.status === 200 && delArt.status === 200 && cmAfter.status === 200 && cmAfter.data.comments.length === 0,
    `post=${c2.status} delArt=${delArt.status} count=${cmAfter.data && cmAfter.data.comments.length}`
  );
}
// REQ-31 限流（每小时 10 条）
let limited = false;
let limitStatus = 0;
for (let i = 0; i < 30; i++) {
  r = await call('/api/articles/1/comments', { method: 'POST', body: { nickname: 'limiter', content: `CF限流测试 ${i}` } });
  if (r.status === 429 && /频繁/.test(r.data.message || '')) {
    limited = true;
    break;
  }
  limitStatus = r.status;
}
check('REQ-31 超限流 → 429 频繁提示', limited, `lastStatus=${limitStatus}`);
// REQ-32 后台列表与检索
r = await call('/api/admin/comments');
check('REQ-32 后台评论列表', r.status === 200 && Array.isArray(r.data.comments) && r.data.comments.length > 0, `got ${r.status} n=${r.data.comments && r.data.comments.length}`);
const firstCm = r.data.comments[0];
r = await call('/api/admin/comments?articleId=1');
check('REQ-32 按文章 ID 检索', r.status === 200 && r.data.comments.every((c) => c.article_id === 1), `got ${r.status}`);
check('检索结果含文章标题', r.status === 200 && r.data.comments.every((c) => c.article_title === '个人基本信息'), `first=${JSON.stringify(r.data.comments[0] && r.data.comments[0].article_title)}`);
// REQ-33 / BC-35 删除评论
r = await call('/api/admin/comments/' + firstCm.id, { method: 'DELETE', csrf: cmsf });
check('REQ-33 删除评论成功', r.status === 200 && r.data.success, `got ${r.status} ${r.text}`);
r = await call('/api/admin/comments/' + firstCm.id, { method: 'DELETE', csrf: cmsf });
check('删除不存在的评论 → 404', r.status === 404, `got ${r.status}`);
const anotherCm = (await call('/api/admin/comments')).data.comments[0];
if (anotherCm) {
  r = await call('/api/admin/comments/' + anotherCm.id, { method: 'DELETE' });
  check('BC-35 无 CSRF 删除 → 403', r.status === 403, `got ${r.status}`);
} else {
  check('BC-35 无 CSRF 删除 → 403', true, '（无剩余评论，跳过）');
}

console.log('\n[6] 防暴力破解');
const victim = 'hacker' + Date.now();
let lockStatus = 0;
for (let i = 1; i <= 6; i++) {
  r = await call('/api/login', { method: 'POST', body: { username: victim, password: 'bad' } });
  if (i < 5) { if (r.status !== 401) lockStatus = -1; }
  else lockStatus = r.status;
}
check('连续 5 次失败后锁定', lockStatus === 423, `got ${lockStatus}`);
r = await call('/api/login', { method: 'POST', body: { username: victim, password: 'bad' } });
check('锁定提示文案', r.status === 423 && /账户已锁定/.test(r.data.message || ''), r.text);

console.log('\n[7] 退出登录');
r = await call('/api/logout', { method: 'POST' });
check('退出 → 200', r.status === 200, `got ${r.status}`);
r = await call('/api/auth/status');
check('退出后未登录', r.status === 200 && r.data.loggedIn === false, `got ${r.status} ${r.text}`);
r = await call('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>' } });
check('退出后提交 → 401', r.status === 401, `got ${r.status}`);

console.log(`\n========================================`);
console.log(`通过 ${passed} 项 / 失败 ${failed} 项`);
console.log(`========================================`);
db.close();
process.exit(failed ? 1 : 0);
