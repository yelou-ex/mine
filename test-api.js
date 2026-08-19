/**
 * API 功能测试脚本
 * 测试所有关键 API 端点
 */
const http = require('http');

const BASE_URL = 'http://localhost:3080';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 3080,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  console.log('=== API 功能测试 ===\n');

  // 1. 测试前台文章列表（无参数）
  try {
    const r = await request('GET', '/api/articles');
    console.log('1. GET /api/articles:', r.status === 200 ? '✓' : '✗', `- ${r.data.articles?.length || 0} 篇文章`);
  } catch (e) {
    console.log('1. GET /api/articles: ✗', e.message);
  }

  // 2. 测试前台文章列表（关键词搜索）
  try {
    const r = await request('GET', '/api/articles?keyword=个人');
    console.log('2. GET /api/articles?keyword=个人:', r.status === 200 ? '✓' : '✗', `- ${r.data.articles?.length || 0} 篇`);
  } catch (e) {
    console.log('2. GET /api/articles?keyword=个人: ✗', e.message);
  }

  // 3. 测试前台文章列表（标签筛选）
  try {
    const r = await request('GET', '/api/articles?tag=h');
    console.log('3. GET /api/articles?tag=h:', r.status === 200 ? '✓' : '✗', `- ${r.data.articles?.length || 0} 篇`);
  } catch (e) {
    console.log('3. GET /api/articles?tag=h: ✗', e.message);
  }

  // 4. 测试标签云API
  try {
    const r = await request('GET', '/api/articles/tags');
    console.log('4. GET /api/articles/tags:', r.status === 200 ? '✓' : '✗', `- ${r.data.tags?.length || 0} 个标签`);
  } catch (e) {
    console.log('4. GET /api/articles/tags: ✗', e.message);
  }

  // 5. 测试文章详情
  try {
    const r = await request('GET', '/api/articles/1');
    console.log('5. GET /api/articles/1:', r.status === 200 ? '✓' : '✗', `- ${r.data.article?.title || '未知'}`);
  } catch (e) {
    console.log('5. GET /api/articles/1: ✗', e.message);
  }

  // 6. 测试组合筛选
  try {
    const r = await request('GET', '/api/articles?category=博客&keyword=1');
    console.log('6. GET /api/articles?category=博客&keyword=1:', r.status === 200 ? '✓' : '✗', `- ${r.data.articles?.length || 0} 篇`);
  } catch (e) {
    console.log('6. GET /api/articles?category=博客&keyword=1: ✗', e.message);
  }

  console.log('\n=== 测试完成 ===');
}

test().catch(console.error);
