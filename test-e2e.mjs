/**
 * test-e2e.mjs — 端到端测试脚本（对应需求文档验收标准 AC-01 ~ AC-14）
 * 运行前提：服务器已启动（node server.js，默认 3000 端口）
 * 运行方式：node test-e2e.mjs
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';
let cookie = '';
let passed = 0;
let failed = 0;

async function api(path, { method = 'GET', body, csrf, noFollow } = {}) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: noFollow ? 'manual' : 'follow',
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text, location: res.headers.get('location') };
}

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function run() {
  /* ---------- 前台公开接口 ---------- */
  console.log('\n[1] 前台公开接口');
  let r = await api('/api/articles');
  check('文章列表 200 且含种子文章', r.status === 200 && r.data.articles.length >= 3, `got ${r.status}`);

  r = await api('/api/articles/1');
  check('文章详情 200', r.status === 200 && !!r.data.article, `got ${r.status}`);

  r = await api('/api/articles?category=博客');
  check('按类别过滤生效', r.status === 200 && r.data.articles.every((a) => a.category === '博客'), `got ${r.status}`);

  /* ---------- 未授权访问拦截（AC-04 / AC-11） ---------- */
  console.log('\n[2] 未授权访问拦截');
  r = await api('/admin/dashboard.html', { noFollow: true });
  check('未登录访问后台页 → 302 重定向登录页', r.status === 302 && /\/admin\/login\.html/.test(r.location || ''), `got ${r.status} ${r.location}`);

  r = await api('/admin/login.html');
  check('登录页可匿名访问 200', r.status === 200, `got ${r.status}`);

  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>' } });
  check('未登录提交文章 → 401', r.status === 401, `got ${r.status}`);

  r = await api('/api/admin/articles/1', { method: 'DELETE' });
  check('未登录删除文章 → 401', r.status === 401, `got ${r.status}`);

  r = await api('/api/csrf-token');
  check('未登录获取 CSRF → 401', r.status === 401, `got ${r.status}`);

  /* ---------- 敏感文件保护 ---------- */
  console.log('\n[3] 敏感文件保护');
  for (const p of ['/server.js', '/db.js', '/data/website.db', '/package.json', '/node_modules/express/package.json', '/.git/config']) {
    r = await api(p);
    check(`${p} → 403`, r.status === 403, `got ${r.status}`);
  }
  r = await api('/script.js');
  check('script.js 正常 200', r.status === 200, `got ${r.status}`);

  /* ---------- 登录（AC-01/02/03） ---------- */
  console.log('\n[4] 登录流程');
  r = await api('/api/login', { method: 'POST', body: { username: '   ', password: '' } });
  check('空白提交 → 400「请输入用户名和密码」', r.status === 400 && r.data.message === '请输入用户名和密码', `got ${r.status} ${r.text}`);

  r = await api('/api/login', { method: 'POST', body: { username: 'nobody', password: 'x' } });
  check('用户名不存在 → 401 统一提示', r.status === 401 && r.data.message === '用户名或密码错误', `got ${r.status} ${r.text}`);

  r = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrongpass' } });
  check('密码错误 → 401 统一提示（防枚举）', r.status === 401 && r.data.message === '用户名或密码错误', `got ${r.status} ${r.text}`);

  r = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  check('正确凭据 → 200 登录成功', r.status === 200 && r.data.success === true, `got ${r.status} ${r.text}`);
  check('登录后 Set-Cookie（HttpOnly 会话）', cookie.length > 0, cookie);

  r = await api('/api/auth/status');
  check('登录状态查询 → loggedIn', r.status === 200 && r.data.loggedIn === true, `got ${r.status} ${r.text}`);

  r = await api('/api/csrf-token');
  const csrf = r.data && r.data.csrfToken;
  check('登录后获取 CSRF Token', r.status === 200 && !!csrf, `got ${r.status}`);

  /* ---------- 文章添加与校验（AC-06/08/10） ---------- */
  console.log('\n[5] 文章添加与字段校验');
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'E2E测试文章', category: '学习笔记', content: '<p>这是<b>测试</b>内容</p>', tags: '测试,学习,学习' }, csrf });
  check('合法文章 → 200 发布成功', r.status === 200 && r.data.success && r.data.message === '发布成功', `got ${r.status} ${r.text}`);
  const newId = r.data && r.data.id;

  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'E2E测试文章', category: '学习笔记', content: '<p>这是<b>测试</b>内容</p>', tags: '测试,学习,学习' }, csrf });
  check('5 秒内重复提交 → 429', r.status === 429, `got ${r.status} ${r.text}`);

  r = await api('/api/admin/articles', { method: 'POST', body: { title: '', category: '博客', content: '<p>x</p>' }, csrf });
  check('标题为空 → 400', r.status === 400, `got ${r.status}`);
  r = await api('/api/admin/articles', { method: 'POST', body: { title: '长'.repeat(101), category: '博客', content: '<p>x</p>' }, csrf });
  check('标题超长(>100) → 400', r.status === 400, `got ${r.status}`);
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '非法类别', content: '<p>x</p>' }, csrf });
  check('非法类别 → 400', r.status === 400, `got ${r.status}`);
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '   <p>  </p>  ' }, csrf });
  check('内容仅空白/空标签 → 400', r.status === 400, `got ${r.status}`);
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>', tags: 'a,b,c,d,e,f' }, csrf });
  check('标签超过 5 个 → 400', r.status === 400, `got ${r.status}`);
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>', tags: '非法!!标签' }, csrf });
  check('标签含非法字符 → 400', r.status === 400, `got ${r.status}`);

  // XSS 过滤（AC-08 / BC-18）
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'XSS过滤测试', category: '博客', content: '<p>安全内容</p><script>alert(1)</script><img src="x" onerror="alert(2)"><iframe src="evil"></iframe>', tags: '安全' }, csrf });
  check('XSS 载荷提交成功（白名单过滤后入库）', r.status === 200, `got ${r.status} ${r.text}`);
  if (r.status === 200) {
    const xssId = r.data.id;
    const detail = await api('/api/articles/' + xssId);
    const c = detail.data.article.content;
    check('入库内容已去除 script/iframe/onerror', !/script|iframe|onerror/i.test(c) && c.includes('安全内容'), `content=${c}`);
    r = await api('/api/admin/articles/' + xssId, { method: 'DELETE', csrf });
    check('清理 XSS 测试文章', r.status === 200, `got ${r.status}`);
  }

  // 缺 CSRF（AC 相关 / BC-11）
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>' } });
  check('缺 CSRF Token → 403', r.status === 403, `got ${r.status}`);

  /* ---------- 文章列表与删除（AC-11/12/13/14） ---------- */
  console.log('\n[6] 文章列表与删除');
  r = await api('/api/admin/articles?keyword=E2E');
  check('后台检索标题命中', r.status === 200 && r.data.articles.some((a) => a.id === newId), `got ${r.status}`);

  r = await api('/api/admin/articles/' + newId, { method: 'DELETE', csrf });
  check('删除成功 → 200', r.status === 200 && r.data.message === '删除成功', `got ${r.status} ${r.text}`);

  r = await api('/api/articles/' + newId);
  check('删除后前台详情 → 404（立即下架）', r.status === 404, `got ${r.status}`);

  r = await api('/api/admin/articles/999999', { method: 'DELETE', csrf });
  check('删除不存在的文章 → 404「文章不存在或已被删除」', r.status === 404 && r.data.message === '文章不存在或已被删除', `got ${r.status} ${r.text}`);

  // 批量删除
  const ids = [];
  for (let i = 0; i < 2; i++) {
    r = await api('/api/admin/articles', { method: 'POST', body: { title: `批量删除测试${i}`, category: '生活感悟', content: '<p>batch</p>' }, csrf });
    ids.push(r.data.id);
  }
  r = await api('/api/admin/articles/batch-delete', { method: 'POST', body: { ids }, csrf });
  check('批量删除 2 篇 → 200', r.status === 200 && r.data.deleted === 2, `got ${r.status} ${r.text}`);
  r = await api('/api/admin/articles/batch-delete', { method: 'POST', body: { ids: [] }, csrf });
  check('批量删除空选择 → 400', r.status === 400, `got ${r.status}`);

  /* ---------- 防暴力破解（AC-09） ---------- */
  console.log('\n[7] 防暴力破解');
  const victim = 'attacker' + Date.now();
  let lockStatus = 0;
  for (let i = 1; i <= 6; i++) {
    r = await api('/api/login', { method: 'POST', body: { username: victim, password: 'bad' } });
    if (i < 5) {
      if (r.status !== 401) lockStatus = -1; // 前 4 次应为普通失败
    } else {
      lockStatus = r.status; // 第 5 次起应为 423 锁定
    }
  }
  check('连续 5 次失败后锁定（第5/6次 423）', lockStatus === 423, `got ${lockStatus}`);
  if (lockStatus === 423) check('锁定提示文案', /账户已锁定/.test(r.data.message || ''), r.text);

  /* ---------- 退出登录（REQ-05） ---------- */
  console.log('\n[8] 退出登录');
  r = await api('/api/logout', { method: 'POST' });
  check('退出 → 200', r.status === 200, `got ${r.status}`);
  r = await api('/api/auth/status');
  check('退出后状态 → loggedIn:false', r.status === 200 && r.data.loggedIn === false, `got ${r.status} ${r.text}`);
  r = await api('/api/admin/articles', { method: 'POST', body: { title: 'x', category: '博客', content: '<p>x</p>' } });
  check('退出后提交 → 401', r.status === 401, `got ${r.status}`);

  /* ---------- 汇总 ---------- */
  console.log(`\n========================================`);
  console.log(`通过 ${passed} 项 / 失败 ${failed} 项`);
  console.log(`========================================`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
