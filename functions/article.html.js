/**
 * functions/article.html.js — /article.html 路由补偿（UX 修复）
 * 平台对 .html 的 clean-URL 归一化会 308 跳 /article 且丢弃查询参数，
 * 导致旧链接 article.html?id=4 进入后丢失 ?id=4、页面显示“文章不存在”。
 * 此函数在静态资源之前接管 /article.html 请求，302 跳转到
 * /article[?原查询串]，把 query 参数完整保留给前端读取。
 * 站内新链接已改用 clean URL（/article?id=N），此函数专用于旧链接/书签/搜索缓存兜底。
 */
export function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const qs = url.search; // 含 ?id=N 等查询参数
  const location = '/article' + (qs ? qs : '');
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}
