/**
 * functions/article.js — /article?id=N 服务端预渲染（Bing Webmaster Guidelines 索引增强）
 *
 * 背景：文章页标题/正文原本全部由前端 JS 从 API 拉取，爬虫首抓（不执行 JS）只能拿到空壳，
 * 导致「页面没有可编制索引的内容 / 重复标题 / 软 404」类问题（指引 §8 / §9 / §13 / §21）。
 *
 * 本函数在静态 article.html 之前接管 /article 请求：
 *   - 无 id 参数        → 302 回首页（避免无 id 的低价值 URL 被当作有效页面）
 *   - 文章不存在/已删除 → 真 404（消除软 404，noindex）
 *   - 文章存在          → 预渲染：独立 <title>、meta description、OG 标签与正文 HTML
 *                         （markdown 服务端 marked 转 HTML，html 走既有白名单）直接写入页面源码；
 *                         浏览器 JS 仍会拉 API 重新渲染（结果一致，幂等），评论区/交互不受影响。
 * D1 异常时降级回静态壳（context.next()），不阻断页面浏览。
 */
import { marked } from 'marked';
import { ensureSchema, sanitizeHtml, mdToPlainText } from './_lib.mjs';

const SITE = 'yelou的个人博客';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// HTML → 纯文本摘要（与 [[path]].mjs 的 makeSummary 规则一致，截取长度不同）
function htmlToText(html, maxLen = 80) {
  const text = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

function fmtDate(s) {
  return String(s || '').replace('T', ' ').slice(0, 16);
}

const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>文章不存在 - ${SITE}</title>
<style>
  body { font-family: Arial, 'Microsoft YaHei', sans-serif; background: #f4f6f8; color: #34495e;
         margin: 0; text-align: center; padding: 90px 20px; }
  .code { font-size: 46px; font-weight: bold; color: #2c3e50; }
  a { color: #3498db; text-decoration: none; font-size: 15px; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="code">404</div>
  <p>您访问的文章不存在或已被删除。</p>
  <a href="/">← 返回首页</a>
</body>
</html>`;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.pathname !== '/article') return; // 只接管 /article（/article.html 由 article.html.js 处理）

  try {
    await ensureSchema(env);
    const idRaw = url.searchParams.get('id');
    // 无文章 id：空壳页无独立价值，引导回首页（§21 避免低价值 URL）
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      return new Response(null, { status: 302, headers: { Location: 'https://' + url.host + '/' } });
    }

    const row = await env.DB.prepare(
      'SELECT id, title, content, category, tags, link, format, created_at FROM articles WHERE id = ?'
    ).bind(Number(idRaw)).first();
    // 文章不存在/已删除：真 404（§9 内容删除要返回 404，避免软 404 被降权）
    if (!row) {
      return new Response(NOT_FOUND_HTML, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 预渲染静态壳（§8 关键内容不依赖客户端渲染；§13 每页独立 title/description）
    const base = await context.next();
    if (!base) {
      return new Response(NOT_FOUND_HTML, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const shell = await base.text();

    // 正文：markdown → marked 转 HTML；两者统一再过服务端白名单（含表格标签），防 XSS 载荷入库残留
    const bodyHtml = row.format === 'markdown'
      ? sanitizeHtml(String(marked.parse(String(row.content || ''))))
      : sanitizeHtml(String(row.content || ''));
    const desc = (row.format === 'markdown' ? mdToPlainText(row.content, 80) : htmlToText(row.content, 80))
      + ' - ' + SITE;
    const title = row.title + ' - ' + SITE;
    const dateStr = fmtDate(row.created_at);
    const tagsHtml = (row.tags || '').split(',').filter(Boolean)
      .map((t) => '<span class="tag">' + escHtml(t) + '</span>').join('');
    const prerender =
      '<article class="article-wrap">' +
      '<h1 class="article-title">' + escHtml(row.title) + '</h1>' +
      '<div class="article-meta">发布于: ' + escHtml(dateStr) + ' | 分类: ' + escHtml(row.category) +
      (row.format === 'markdown' ? ' | Markdown' : '') + '</div>' +
      (tagsHtml ? '<div class="article-tags">' + tagsHtml + '</div>' : '') +
      '<div class="table-scroll"><div class="article-body">' + bodyHtml + '</div></div>' +
      '</article>';

    // 壳内占位与前端 article.html 的静态默认值一一对应；任一处失配则原样返回静态壳（不阻断）
    let out = shell
      .replace('<title>文章详情 - ' + SITE + '</title>', '<title>' + escHtml(title) + '</title>')
      .replace('<meta name="description" content="杨楼的个人博客文章页：学习笔记与生活感悟。">',
        '<meta name="description" content="' + escHtml(desc) + '">')
      .replace('<meta property="og:title" content="文章详情 - ' + SITE + '">',
        '<meta property="og:title" content="' + escHtml(title) + '">')
      .replace('<meta property="og:description" content="杨楼的个人博客文章页：学习笔记与生活感悟。">',
        '<meta property="og:description" content="' + escHtml(desc) + '">')
      .replace('<meta property="og:url" content="https://yelou.pages.dev/article">',
        '<meta property="og:url" content="' + escHtml(url.href) + '">')
      .replace('<div id="articleWrap"></div>',
        '<div id="articleWrap" data-prerendered="1">' + prerender + '</div>');

    return new Response(out, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  } catch (e) {
    // D1 等异常：降级回静态壳（浏览器 JS 仍可正常加载文章），不阻断访问
    console.error('[article.js]', e && e.stack ? e.stack : String(e));
    try {
      const fallback = await context.next();
      if (fallback) return fallback;
    } catch { /* 忽略 */ }
    return new Response('系统繁忙，请稍后重试', { status: 503 });
  }
}
