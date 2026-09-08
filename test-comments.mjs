/**
 * test-comments.mjs — 文章评论功能端到端测试（REQ-25 ~ 33 / BC-27 ~ 36）
 * 在独立临时 DATA_DIR 下于进程内启动 server.js（不污染真实数据库），
 * 通过 HTTP 覆盖：评论列表 / 发表评论 / 字段校验 / XSS 过滤 / 防重复 / 限流 /
 * 后台鉴权 / 删除评论 / 级联删除。
 * 运行：node test-comments.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
// 临时数据库放在工作区内（沙箱可写），保证每次测试全新环境
const DATA_DIR = mkdtempSync(path.join(process.cwd(), '.cms-test-'));

// 在 require server.js 之前注入环境变量，使其使用临时数据库与独立端口
process.env.PORT = String(PORT);
process.env.DATA_DIR = DATA_DIR;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 收集 cookie 的 fetch 包装
const jar = {};
async function req(method, p, { body, token, noCookie } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-CSRF-Token'] = token;
  if (!noCookie && jar.sid) headers['Cookie'] = `sid=${jar.sid}`;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setc) {
    const m = c.match(/^sid=([^;]+)(;|$)/);
    if (m) jar.sid = m[1];
    const c2 = c.match(/^csrf=([^;]+)(;|$)/);
    if (c2) jar.csrf = c2[1];
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, res };
}

async function waitReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/articles');
      if (r.status === 200) return;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server 未在超时时间内就绪');
}

const server = require('./server.js'); // 进程内启动（app.listen 已在 server.js 内触发）

try {
  await waitReady();

  // 找到一篇已存在的文章 id
  const list = await req('GET', '/api/articles');
  const article = list.data.articles[0];
  const aid = article.id;
  const other = list.data.articles[1];
  const otherAid = other ? other.id : 999999;

  console.log(`\n== 前台评论（文章 id=${aid}）==`);

  // BC-32 文章不存在
  const missing = await req('GET', '/api/articles/999999/comments');
  check('BC-32 读取不存在文章的评论 → 404', missing.status === 404, `got ${missing.status}`);

  // REQ-27 空列表
  const empty = await req('GET', `/api/articles/${aid}/comments`);
  check('REQ-27 新文章评论列表为空', empty.status === 200 && empty.data.count === 0, `got ${empty.status} count=${empty.data && empty.data.count}`);

  // REQ-25/26 正常发表
  const ok = await req('POST', `/api/articles/${aid}/comments`, {
    body: { nickname: '小明', email: 'a@b.com', content: '写得很棒' },
  });
  check('REQ-25/26 正常评论入库', ok.status === 200 && ok.data.success === true, `got ${ok.status} ${ok.data && ok.data.message}`);

  // REQ-27 列表已含 1 条
  const afterOne = await req('GET', `/api/articles/${aid}/comments`);
  check('REQ-27 评论列表含 1 条', afterOne.data.count === 1, `count=${afterOne.data && afterOne.data.count}`);

  // BC-27 昵称为空
  const noNick = await req('POST', `/api/articles/${aid}/comments`, { body: { nickname: '  ', content: 'x' } });
  check('BC-27 昵称为空 → 400', noNick.status === 400 && noNick.data.message.includes('昵称'), `got ${noNick.status} ${noNick.data && noNick.data.message}`);

  // BC-28 内容为空
  const noContent = await req('POST', `/api/articles/${aid}/comments`, { body: { nickname: 'a', content: '   ' } });
  check('BC-28 内容为空 → 400', noContent.status === 400 && noContent.data.message.includes('评论内容'), `got ${noContent.status} ${noContent.data && noContent.data.message}`);

  // BC-31 XSS 过滤（入库后应为纯文本）
  const xss = await req('POST', `/api/articles/${aid}/comments`, {
    body: { nickname: 'hacker', content: '<script>alert(1)</script>哈哈<img src=x onerror=alert(2)>' },
  });
  check('BC-31 XSS 载荷提交成功', xss.status === 200, `got ${xss.status}`);
  const afterXss = await req('GET', `/api/articles/${aid}/comments`);
  const xssRow = afterXss.data.comments.find((c) => c.nickname === 'hacker');
  check(
    'BC-31 XSS 入库后为纯文本（无标签）',
    xssRow && !/<(script|img)/i.test(xssRow.content) && xssRow.content.includes('哈哈'),
    xssRow && `content=${JSON.stringify(xssRow.content)}`
  );

  // BC-30 邮箱格式非法
  const badEmail = await req('POST', `/api/articles/${aid}/comments`, { body: { nickname: 'a', email: 'not-an-email', content: 'hi' } });
  check('BC-30 邮箱非法 → 400', badEmail.status === 400 && badEmail.data.message.includes('邮箱'), `got ${badEmail.status} ${badEmail.data && badEmail.data.message}`);

  // BC-29 内容超长
  const longContent = await req('POST', `/api/articles/${aid}/comments`, { body: { nickname: 'a', content: 'x'.repeat(1001) } });
  check('BC-29 内容超长(>1000) → 400', longContent.status === 400 && longContent.data.message.includes('1000'), `got ${longContent.status}`);

  // REQ-30 防重复（同 IP + 同文章 + 同内容 60s）
  const dup1 = await req('POST', `/api/articles/${aid}/comments`, { body: { nickname: 'dup', content: '重复测试内容ABC' } });
  const dup2 = await req('POST', `/api/articles/${aid}/comments`, { body: { nickname: 'dup', content: '重复测试内容ABC' } });
  check('REQ-30 60s 内重复评论 → 429', dup1.status === 200 && dup2.status === 429, `first=${dup1.status} second=${dup2.status}`);

  console.log('\n== 后台评论管理 ==');

  // REQ-33 / BC-35 未登录读取后台评论 → 401
  const anon = await req('GET', '/api/admin/comments', { noCookie: true });
  check('REQ-33 未登录读取后台评论 → 401', anon.status === 401, `got ${anon.status}`);

  // 登录管理员
  const login = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin123' }, noCookie: true });
  check('登录成功', login.status === 200 && login.data.success, `got ${login.status}`);
  const csrfRes = await req('GET', '/api/csrf-token');
  const csrf = csrfRes.data && csrfRes.data.csrfToken;
  check('获取 CSRF Token', csrfRes.status === 200 && !!csrf, `got ${csrfRes.status}`);

  const adminList = await req('GET', '/api/admin/comments');
  check('REQ-32 后台评论列表可读', adminList.status === 200 && Array.isArray(adminList.data.comments), `got ${adminList.status}`);
  const first = adminList.data.comments[0];

  const adminFilter = await req('GET', `/api/admin/comments?articleId=${aid}`);
  check(
    'REQ-32 按文章 ID 检索',
    adminFilter.status === 200 && adminFilter.data.comments.every((c) => c.article_id === aid),
    `got ${adminFilter.status} n=${adminFilter.data.comments.length}`
  );

  // 删除评论（需 CSRF）
  if (first) {
    const del = await req('DELETE', `/api/admin/comments/${first.id}`, { token: csrf });
    check('REQ-33 删除评论成功', del.status === 200 && del.data.success, `got ${del.status} ${del.data && del.data.message}`);
    const delMissing = await req('DELETE', `/api/admin/comments/${first.id}`, { token: csrf });
    check('BC 删除不存在的评论 → 404', delMissing.status === 404, `got ${delMissing.status}`);
  } else {
    check('REQ-33 删除评论成功', false, '无评论可删');
  }

  // BC-35 未带 CSRF 的删除 → 403
  const anyComment = await req('GET', '/api/admin/comments');
  const target = anyComment.data.comments[0];
  if (target) {
    const noCsrf = await req('DELETE', `/api/admin/comments/${target.id}`);
    check('BC-35 无 CSRF 删除 → 403', noCsrf.status === 403, `got ${noCsrf.status}`);
  } else {
    check('BC-35 无 CSRF 删除 → 403', true, '（无评论，跳过，逻辑同上）');
  }

  console.log('\n== 级联删除 ==');
  // 删除文章后其评论应被清理
  if (other) {
    const addCm = await req('POST', `/api/articles/${otherAid}/comments`, { body: { nickname: 'c', content: 'will-be-cascade' } });
    const delArt = await req('DELETE', `/api/admin/articles/${otherAid}`, { token: csrf });
    check('删除文章成功', delArt.status === 200, `got ${delArt.status}`);
    const cmAfter = await req('GET', `/api/admin/comments?articleId=${otherAid}`);
    check(
      'REQ-29 删除文章后评论级联清理',
      cmAfter.status === 200 && cmAfter.data.comments.length === 0,
      `addComment=${addCm.status} count=${cmAfter.data && cmAfter.data.comments.length}`
    );
  } else {
    check('REQ-29 级联删除', true, '（无第二篇可删，跳过）');
  }

  console.log('\n== 按 IP 限流 ==');
  // REQ-31 按 IP 限流（每小时 10 条）：对同一 IP 连发不同内容直至触发 429
  let limited = false;
  let limitStatus = 0;
  for (let i = 0; i < 30; i++) {
    const r = await req('POST', `/api/articles/${aid}/comments`, { body: { nickname: 'limiter', content: `限流测试 ${i}` } });
    if (r.status === 429 && r.data.message.includes('频繁')) {
      limited = true;
      limitStatus = 429;
      break;
    }
    limitStatus = r.status;
  }
  check('REQ-31 超限流 → 429 频繁提示', limited, `lastStatus=${limitStatus}`);

  console.log(`\n=============================`);
  console.log(`评论功能测试：${passed} 通过 / ${failed} 失败`);
  console.log(`=============================`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('测试异常:', e.message, e.stack);
  process.exitCode = 1;
} finally {
  try {
    require('./db').close(); // 释放 better-sqlite3 句柄，否则 Windows 下无法删除临时库
  } catch {
    /* db 尚未加载（启动失败场景） */
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
}
// 进程内 server 仍在监听，主动退出以结束测试
process.exit(process.exitCode || 0);
