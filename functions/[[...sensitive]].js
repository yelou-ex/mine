/**
 * functions/[[...sensitive]].js — Pages 兜底拦截：敏感文件 403（安全审计 22c0d741）
 *
 * 背景：Pages 将整个仓库根目录作为静态资源部署，/server.js、/db.js、/test-*.mjs、
 * /package.json 等开发/测试文件可被未授权下载（含完整后端逻辑与默认凭据）。
 *
 * 原理：根级 catch-all 函数是静态服务前最后一道函数——比它更具体的路由
 * （/api/* → api/[[path]].mjs、/article → article.js、/sitemap.xml、/*.txt）
 * 优先命中各自函数，本函数只看到「未认领」的请求：
 *   - 命中 isSensitivePath 黑名单 → 403（no-store，空响应体）
 *   - 其余一律 context.next() 透传 → 正常静态资源服务（零行为变化）
 *
 * 规则与本地 Express（server.js）及 _lib.mjs isSensitivePath 保持同步。
 */
import { isSensitivePath } from './_lib.mjs';

export function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // /api/* 永远透传（其专用函数更具体、本不应到达这里；双保险防止未来路由变更时误伤 API）
  if (url.pathname.startsWith('/api/')) return context.next();

  if (isSensitivePath(url.pathname)) {
    return new Response(null, {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return context.next();
}
