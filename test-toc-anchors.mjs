/**
 * test-toc-anchors.mjs — Markdown 文内目录锚点跳转回归测试
 *
 * 缺陷：md 文章目录链接（如 [1. 开始](#1-开始)）点击不跳转。
 * 根因：① marked v5+ 默认不再为标题生成 slug id；② 各层 XSS 白名单（DOMPurify /
 * 本地回退渲染器 / 服务端 sanitizeHtml / Express sanitize-html）均不放行 id 属性。
 * 修复：js/heading-ids.js + functions/_lib.mjs 为 <h1>~<h6> 生成 GitHub 风格 id
 * （重名 -1/-2），各白名单层同步放行 id（值限定字符集）。
 *
 * 运行：node test-toc-anchors.mjs
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDomPurify from 'dompurify';
import { marked } from 'marked';
import { addHeadingIds, headingSlug, sanitizeHtml, buildTocHtml } from './functions/_lib.mjs';

const md = [
  '# 教程指南',
  '',
  '## 目录',
  '- [1. 开始](#1-开始)',
  '- [1. 开始（重复标题）](#1-开始-1)',
  '- [What is X?](#what-is-x)',
  '',
  '## 1. 开始',
  '正文一',
  '',
  '## 1. 开始',
  '正文二',
  '',
  '### What is X?',
  '正文三',
].join('\n');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('1) slug 规则（GitHub 风格：小写、去标点、空格转连字符、保留中文）');
check('What is X? → what-is-x', () => assert.equal(headingSlug('What is X?'), 'what-is-x'));
check('1. 开始 → 1-开始（点号按标点去除）', () => assert.equal(headingSlug('1. 开始'), '1-开始'));
check('中文 标题 → 中文-标题', () => assert.equal(headingSlug('  中文 标题 '), '中文-标题'));
check('剥离内联标签: Hello <em>world</em> → hello-world', () => assert.equal(headingSlug('Hello <em>world</em>'), 'hello-world'));
check('实体解码: A &amp; B → a-b', () => assert.equal(headingSlug('A &amp; B'), 'a-b'));

console.log('2) addHeadingIds：标题追加 id，重名 -1/-2');
const rendered = addHeadingIds(marked.parse(md));
check('首个 h2 id="1-开始"', () => assert.match(rendered, /<h2 id="1-开始">/));
check('重名 h2 id="1-开始-1"', () => assert.match(rendered, /<h2 id="1-开始-1">/));
check('h3 id="what-is-x"', () => assert.match(rendered, /<h3 id="what-is-x">/));
check('代码块内的伪标题不被误加 id', () => {
  const code = addHeadingIds(marked.parse('```html\n<h2>fake</h2>\n```\n'));
  assert.ok(!/id=/.test(code), code);
});

console.log('3) 服务端白名单 sanitizeHtml：放行合法 id，剥离危险属性/值');
const clean = sanitizeHtml(rendered);
check('保留 h2 id="1-开始"', () => assert.match(clean, /<h2 id="1-开始">/));
check('保留 h3 id="what-is-x"', () => assert.match(clean, /<h3 id="what-is-x">/));
check('剥离 on* 事件属性', () => assert.ok(!/onerror|onload/i.test(sanitizeHtml('<img src="a" onerror="alert(1)">'))));
check('剥离畸形 id 值（引号/空格）', () => {
  const out = sanitizeHtml('<h2 id="a b">t</h2>');
  assert.ok(!/id=/.test(out), out);
});

console.log('4) DOMPurify（article.html 同款白名单 + id）：保留锚点');
const { window } = new JSDOM('');
const DOMPurify = createDomPurify(window);
const purify = (html) => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'del', 's',
    'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'colspan', 'rowspan', 'id'],
});
check('DOMPurify 保留 h2 锚点 id', () => assert.match(purify(rendered), /<h2 id="1-开始">/));
check('DOMPurify 保留目录 <a href="#..."> 链接（CJK 百分号编码，浏览器跳转前会解码，与 id 一致）', () => {
  const out = purify(rendered);
  assert.match(out, /<a href="#1-(%E5%BC%80%E5%A7%8B|开始)">/);
  // 编码形式与 id="1-开始" 指向同一目标（片段按 URL 规则解码后匹配）
  assert.equal(decodeURIComponent(out.match(/<a href="#([^"]+)">/)[1]), '1-开始');
});
check('DOMPurify 仍剥离 script', () => assert.ok(!/<script/i.test(purify(rendered + '<script>x</script>'))));

console.log('5) 浏览器端管线（js/marked.js UMD + js/heading-ids.js + DOMPurify，与 article.html 一致）');
{
  const fs = await import('node:fs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  w.eval(fs.readFileSync('./js/marked.js', 'utf8'));
  w.eval(fs.readFileSync('./js/heading-ids.js', 'utf8'));
  // jsdom  realm 隔离：UMD 挂在 realm 内 globalThis 上，经 eval 取回（真实浏览器经 <script> 挂 window，等效）
  const markedApi = w.eval('globalThis.marked');
  const addIdsApi = w.eval('globalThis.addHeadingIds');
  const DOMPurify = createDomPurify(w);
  const md5 = ['## 目录', '- [1. 开始](#1-开始)', '', '## 1. 开始', '正文'].join('\n');
  const out = DOMPurify.sanitize(addIdsApi(markedApi.parse(md5)), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'del', 's',
      'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'colspan', 'rowspan', 'id'],
  });
  check('浏览器管线产出含标题 id', () => assert.match(out, /<h2 id="1-开始">/));
  check('目录链接指向存在的 id（点击可跳转）', () => {
    const doc = new JSDOM(out).window.document;
    const href = doc.querySelector('li a').getAttribute('href');
    const target = doc.getElementById(decodeURIComponent(href.slice(1)));
    assert.ok(target && target.tagName === 'H2', '目标 ' + target);
  });
}

console.log('6) buildTocHtml（PC 目录模块预渲染，与前端 initToc 同规则）');
{
  const md6 = addHeadingIds(marked.parse('## 目录\n## Part One\n正文一\n## Part Two\n正文二\n### Sub\n正文三'));
  const toc6 = buildTocHtml(md6);
  check('≥2 个 h2~h4 → 生成 TOC', () => assert.equal(toc6.visible, true));
  check('条目含 h2/h3 层级 class', () => {
    assert.match(toc6.tocHtml, /class="lvl-2"/);
    assert.match(toc6.tocHtml, /class="lvl-3"/);
  });
  check('href 指向已生成 id（CJK 百分号编码）', () => {
    assert.match(toc6.tocHtml, /href="#%E7%9B%AE%E5%BD%95"/); // 目录
    assert.match(toc6.tocHtml, /href="#sub"/);
  });
  check('html 文章无 id 标题 → 补生成（与前端一致）', () => {
    const t = buildTocHtml('<h2>One</h2><h2>One</h2><h3>Two</h3>');
    assert.equal(t.visible, true);
    assert.match(t.tocHtml, /href="#one"/);
    assert.match(t.tocHtml, /href="#one-1"/);
    assert.match(t.tocHtml, /href="#two"/);
  });
  check('<2 个标题 → 不生成（目录隐藏）', () => {
    assert.equal(buildTocHtml('<h2>Only</h2>').visible, false);
    assert.equal(buildTocHtml('<p>无标题</p>').visible, false);
  });
}

console.log('\n全部通过：' + passed + ' 项 ✅');
