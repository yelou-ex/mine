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

## 常见问题

### 1. "接口不存在" 错误

检查 `wrangler.toml` 中的数据库绑定是否正确，以及 D1 数据库是否已初始化。

### 2. 标签云不显示

确保文章中设置了标签（tags字段），标签API只返回有标签的文章。

### 3. Session 失效

Workers 中的 Session 存储在内存中，重启后会丢失。生产环境建议使用 Cloudflare KV 存储 Session。
