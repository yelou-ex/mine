/**
 * functions/[key].txt.js — IndexNow key 文件（协议要求 GET /{key}.txt 明文返回 key 本身）
 * 仅当请求路径与配置的 INDEXNOW_KEY 完全一致时返回，其余 *.txt 走 context.next()
 * （静态文件照常，未命中则 404），不做目录枚举。
 */
export async function onRequest(context) {
  const { env, params } = context;
  const want = env && env.INDEXNOW_KEY;
  const got = params && params.key ? String(params.key) : '';
  if (want && got && got === want) {
    return new Response(want, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    });
  }
  return context.next();
}
