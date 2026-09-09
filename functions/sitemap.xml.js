/**
 * functions/sitemap.xml.js — 动态 sitemap（对搜索引擎友好）
 * 显式托管 /sitemap.xml（不再落入 catch-all 返回首页），内容 =
 *   固定静态页（首页 / 关于 / 学习之路 / 荣誉）+ 后台发布的全部文章（/article?id=N）。
 * 数据库异常时降级只输出静态页，不阻断响应。
 */
import { ensureSchema } from './_lib.mjs';

const BASE = 'https://yelou.pages.dev';

// 固定静态页（lastmod 仅作提示值，使用与种子文章一致的时间）
const STATIC_PAGES = [
  { loc: `${BASE}/`, lastmod: '2025-01-01' },
  { loc: `${BASE}/introduce.html`, lastmod: '2023-10-15' },
  { loc: `${BASE}/myway.html`, lastmod: '2023-10-10' },
  { loc: `${BASE}/honor.html`, lastmod: '2023-10-05' },
];

export async function onRequest(context) {
  const { env } = context;
  const urls = STATIC_PAGES.slice();

  try {
    await ensureSchema(env);
    // 仅收录可被读者打开的文章（link 非空的固定页面已单独收录，避免重复）
    const rows = await env.DB.prepare(
      "SELECT id, created_at FROM articles WHERE link = '' ORDER BY id"
    ).all();
    for (const r of rows.results) {
      const lastmod = String(r.created_at || '').slice(0, 10) || STATIC_PAGES[0].lastmod;
      urls.push({ loc: `${BASE}/article?id=${r.id}`, lastmod });
    }
  } catch (e) {
    console.error('[sitemap.xml] D1 读取失败，降级输出静态页', e);
  }

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`
      )
      .join('\n') +
    '\n</urlset>\n';

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}
