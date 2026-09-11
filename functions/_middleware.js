/**
 * functions/_middleware.js — Pages 全局中间件钩子
 * 在 static 资源 / 具体 function / api 之前运行，做两件事：
 *
 *   1. 敏感文件兜底拦截（审计 22c0d741）
 *      Pages 把整个仓库根目录作为静态资源部署，/server.js、/db.js、
 *      /test-*.mjs、/package.json、/functions/...、/node_modules/... 等
 *      开发/测试文件会被未授权下载。isSensitivePath 命中 → 403（no-store），
 *      其余一律 next() 透传（零行为变化）。
 *      ⚠ 同步约定：与本地 Express（server.js）及 _lib.mjs 保持规则一致。
 *
 *   2. /article.html 路由补偿（从原 functions/article.html.js 迁入）
 *      Pages 对 .html 的 clean-URL 归一化会 308 跳 /article 且丢弃查询参数，
 *      导致旧链接 article.html?id=4 进入后丢失 ?id=4、显示"文章不存在"。
 *      此处 302 到 /article[?原查询串]，query 参数完整保留给前端读取。
 *      站内新链接已改用 clean URL（/article?id=N），此处专用于旧链接/书签/搜索缓存兜底。
 *
 * 说明：原 functions/[[...sensitive]].js（根级 catch-all 兜底）因 Pages Functions
 * 不支持双括号 nested 参数名（[[ ]] 嵌套 + rest）而无法构建，其拦截逻辑
 * 统一搬到本中间件；原 functions/article.html.js 的 302 逻辑也并入此处，
 * 两个文件均可删除。
 */
import { isSensitivePath } from './_lib.mjs';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // 1) /article.html → 302 到 /article（保留 query）
  if (url.pathname === '/article.html') {
    const qs = url.search;
    return new Response(null, {
      status: 302,
      headers: { Location: '/article' + (qs ? qs : '') },
    });
  }

  // 2) 敏感路径兜底拦截（任意深度，目录级、前缀、扩展名全在 isSensitivePath 内）
  if (isSensitivePath(url.pathname)) {
    return new Response(null, {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // 其余一律透传（静态资源 / /api/* / /article 等由更具体的路由处理）
  return context.next();
}
