// Local black/white UI preview server.
// It mirrors Cloudflare Pages behavior closely enough for manual review:
// - /article -> article.html (client JS reads ?id=)
// - article.html -> 302 to /article
// - css/ js/ picture/ admin/ -> static files
// - admin pages -> /admin/login.html or /admin/dashboard.html based on URL
// - /api/* -> JSON stubs so the front pages render without a real DB
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  }, headers || {}));
  res.end(body);
}

function readStatic(relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(root, safe);
  if (!file.startsWith(root)) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

function contentNegotiatedPath(urlPath) {
  // Express-style: /x.html matches /x first, then /x.html
  if (urlPath === '/' || urlPath === '/index.html') return '/index.html';
  if (urlPath === '/article') return '/article.html';
  if (urlPath === '/article.html') return null; // 302 handled separately
  if (urlPath === '/admin') return '/admin/dashboard.html';
  if (urlPath === '/admin/') return '/admin/dashboard.html';
  if (urlPath === '/introduce') return '/introduce.html';
  if (urlPath === '/introduce.html') return null;
  if (urlPath === '/about') return '/introduce.html';
  return urlPath;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  const query = url.search;

  // Article clean URL -> static shell (client JS loads ?id= from location.search)
  if (pathname === '/article') {
    const file = readStatic('article.html');
    if (!file) return send(res, 404, 'article.html not found');
    return send(res, 200, fs.readFileSync(file, 'utf8'), { 'Content-Type': MIME['.html'] });
  }

  // /article.html -> 302 to /article (preserve query)
  if (pathname === '/article.html') {
    return send(res, 302, '', { Location: '/article' + query });
  }

  // /introduce.html -> 302 to /introduce (preserve query)
  if (pathname === '/introduce.html') {
    return send(res, 302, '', { Location: '/introduce' + query });
  }

  // Static API stubs for preview (no DB)
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/articles') {
      const articles = [
        {
          id: 1,
          title: '黑白主题改造预览',
          category: '博客',
          tags: '主题,UI,预览',
          link: '',
          format: 'html',
          content: '<h2>改造说明</h2><p>本次前台 UI 大换血加入了黑白主题切换。</p><ul><li>浅色：白底、黑字、方格背景</li><li>深色：黑底、白字、星空背景</li></ul><blockquote>切换开关在页头右侧。</blockquote>',
          summary: '本次前台 UI 大换血加入了黑白主题切换。',
          created_at: new Date().toISOString().replace('T', ' ').slice(0, 16),
          views: 1,
          likes: 0,
        },
        {
          id: 2,
          title: '关于页黑白化',
          category: '生活感悟',
          tags: '关于,UI',
          link: '',
          format: 'html',
          content: '<p>introduce.html 的紫色页头已改为黑白主题变量。</p>',
          summary: 'introduce.html 的紫色页头已改为黑白主题变量。',
          created_at: new Date().toISOString().replace('T', ' ').slice(0, 16),
          views: 1,
          likes: 0,
        },
      ];
      const keyword = (url.searchParams.get('keyword') || '').toLowerCase();
      const category = url.searchParams.get('category') || '';
      const tag = url.searchParams.get('tag') || '';
      const filtered = articles.filter((a) =>
        (!keyword || a.title.toLowerCase().includes(keyword) || (a.summary || '').toLowerCase().includes(keyword)) &&
        (!category || a.category === category) &&
        (!tag || (a.tags || '').includes(tag))
      );
      return send(res, 200, JSON.stringify({ articles: filtered }), { 'Content-Type': MIME['.json'] });
    }
    if (pathname === '/api/articles/tags') {
      return send(res, 200, JSON.stringify({ tags: [
        { name: '主题', count: 1 },
        { name: 'UI', count: 2 },
        { name: '预览', count: 1 },
        { name: '关于', count: 1 },
      ] }), { 'Content-Type': MIME['.json'] });
    }
    const articleMatch = pathname.match(/^\/api\/articles\/(\d+)$/);
    if (articleMatch) {
      const id = Number(articleMatch[1]);
      const found = [1, 2].find((x) => x === id);
      if (!found) return send(res, 404, JSON.stringify({ message: '文章不存在' }), { 'Content-Type': MIME['.json'] });
      return send(res, 200, JSON.stringify({
        article: {
          id,
          title: id === 1 ? '黑白主题改造预览' : '关于页黑白化',
          content: id === 1
            ? '<h2>改造说明</h2><p>本次前台 UI 大换血加入了黑白主题切换。</p><ul><li>浅色：白底、黑字、方格背景</li><li>深色：黑底、白字、星空背景</li></ul><blockquote>切换开关在页头右侧。</blockquote>'
            : '<p>introduce.html 的紫色页头已改为黑白主题变量。</p>',
          category: id === 1 ? '博客' : '生活感悟',
          tags: id === 1 ? '主题,UI,预览' : '关于,UI',
          link: '',
          format: 'html',
          views: 1,
          likes: 0,
          created_at: new Date().toISOString().replace('T', ' ').slice(0, 16),
        },
      }), { 'Content-Type': MIME['.json'] });
    }
    const commentMatch = pathname.match(/^\/api\/articles\/(\d+)\/comments$/);
    if (commentMatch) {
      if (req.method === 'POST') {
        return send(res, 200, JSON.stringify({ success: true, id: 100 + Number(commentMatch[1]), message: '评论发布成功（本地预览）' }), { 'Content-Type': MIME['.json'] });
      }
      return send(res, 200, JSON.stringify({
        comments: [
          {
            id: 1,
            nickname: '本地预览',
            content: '这是本地静态预览生成的示例评论。',
            created_at: new Date().toISOString(),
            parent_id: 0,
            likes: 0,
          },
        ],
        count: 1,
      }), { 'Content-Type': MIME['.json'] });
    }
    const likeMatch = pathname.match(/^\/api\/(articles|comments)\/(\d+)\/like$/);
    if (likeMatch) {
      return send(res, 200, JSON.stringify({ success: true, liked: true, likes: 1 }), { 'Content-Type': MIME['.json'] });
    }
    return send(res, 200, JSON.stringify({ message: '本地预览 API 桩' }), { 'Content-Type': MIME['.json'] });
  }

  const staticPath = contentNegotiatedPath(pathname);
  if (staticPath === null) {
    const target = url.pathname.endsWith('.html') ? url.pathname.replace(/\.html$/, '') : url.pathname;
    return send(res, 302, '', { Location: target + query });
  }

  const file = readStatic(staticPath.replace(/^\//, ''));
  if (!file) {
    return send(res, 404, 'Not Found: ' + pathname, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  const type = MIME[ext] || 'application/octet-stream';
  if (ext === '.html') {
    // Minimal Cloudflare Pages-like content negotiation: /admin/login.html -> /admin/login
    // Not needed here; serve as-is.
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
});

server.listen(port, () => {
  console.log('Black/white UI preview running at http://127.0.0.1:' + port + '/');
  console.log('Home: http://127.0.0.1:' + port + '/index.html');
  console.log('Article preview: http://127.0.0.1:' + port + '/article?id=1');
  console.log('About preview: http://127.0.0.1:' + port + '/introduce.html');
});
