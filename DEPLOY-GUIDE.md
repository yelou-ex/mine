# Cloudflare Workers 部署指南

## 前置条件

1. 安装 Cloudflare Wrangler CLI：
   ```bash
   npm install -g wrangler
   ```

2. 登录 Cloudflare：
   ```bash
   wrangler login
   ```

## 部署步骤

### 1. 创建 D1 数据库

在 Cloudflare Dashboard 中创建 D1 数据库，或使用命令：
```bash
wrangler d1 create personal-website-db
```

记录返回的 `database_id`，然后更新 `wrangler.toml` 中的 `database_id` 字段。

### 2. 初始化数据库表结构

```bash
wrangler d1 execute personal-website-db --file=init-d1.sql
```

### 3. 部署 Workers

```bash
wrangler deploy
```

## API 接口说明

### 前台接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/articles` | GET | 获取文章列表，支持 `?category=` `?keyword=` `?tag=` |
| `/api/articles/:id` | GET | 获取文章详情 |
| `/api/articles/tags` | GET | 获取标签统计 |

### 后台接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/login` | POST | 管理员登录 |
| `/api/logout` | POST | 登出 |
| `/api/auth/status` | GET | 登录状态 |
| `/api/csrf-token` | GET | 获取 CSRF Token |
| `/api/admin/articles` | GET | 文章列表 |
| `/api/admin/articles` | POST | 创建文章 |
| `/api/admin/articles/:id` | PUT | 更新文章 |
| `/api/admin/articles/:id` | DELETE | 删除文章 |
| `/api/admin/articles/batch-delete` | POST | 批量删除 |

## 安全加固（审计 22c0d741：静态部署泄露开发/测试源码）

**背景**：Pages 将整个仓库根目录作为静态资源部署，`/server.js`、`/db.js`、`/test-*.mjs`、`/package.json`、部署文档等开发文件曾可被未授权下载（含完整后端逻辑与默认凭据 admin/admin123——生产库已改密，此处为纵深加固）。

**已实施**：

1. **Functions 兜底拦截（核心）**：`functions/[[...sensitive]].js` 根级 catch-all 在静态服务前拦截敏感路径返回 403（规则在 `functions/_lib.mjs` 的 `isSensitivePath`，与本地 `server.js` 拦截清单同步）。命中范围：后端源码 / 测试文件 / 配置文件 / 数据库与 SQL / `.md|.sql|.db|.docx|.log|.toml` 文档 / `node_modules|.git|data|.npm-cache|functions` 目录。正常静态资源与 `/api/*` 全部 `context.next()` 透传，零行为变化。
2. **默认管理员环境变量注入**：`ensureSchema` 种子管理员支持 `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` 环境变量（Pages 环境变量面板配置；未配置时回退内置开发默认值，仅影响全新库的首次种子）。
3. 本地 Express（`server.js`）拦截规则同步扩展，`test-e2e.mjs` [3] 覆盖。

**部署后验证**（应全部返回 403；正常页面 200）：

```bash
for p in /server.js /db.js /test-functions.mjs /package.json /wrangler.toml /DEPLOY-GUIDE.md /data/website.db /node_modules/express/package.json; do
  printf '%s → ' "$p"; curl -sk -o /dev/null -w '%{http_code}\n' "https://yelou.pages.dev$p"
done
curl -sk -o /dev/null -w 'index → %{http_code}\n' https://yelou.pages.dev/index.html
```

**可选的更强加固**（建议排期）：在 Pages 项目设置里加「构建命令 + 构建输出目录」，只把公开资源（index/article/introduce.html、js/、picture/、admin/、favicon.ico、robots.txt、BingSiteAuth.xml、test-mobile-api.html 之外的公开文件）拷入输出目录，让开发文件**根本不被上传**；Functions 拦截层保留为兜底。

## 常见问题

### 1. "接口不存在" 错误

检查 `wrangler.toml` 中的数据库绑定是否正确，以及 D1 数据库是否已初始化。

### 2. 标签云不显示

确保文章中设置了标签（tags字段），标签API只返回有标签的文章。

### 3. Session 失效

Workers 中的 Session 存储在内存中，重启后会丢失。生产环境建议使用 Cloudflare KV 存储 Session。
