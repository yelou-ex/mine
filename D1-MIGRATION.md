# Cloudflare D1 数据库迁移指南

## 快速开始

你已经有了本地 SQLite 数据库，现在要将其迁移到 Cloudflare D1。

### 1. 创建 D1 数据库

```bash
# 登录 Cloudflare
wrangler login

# 创建 D1 数据库
wrangler d1 create personal-website-db
```

创建成功后，会返回一个 `database_id`，复制到 `wrangler.toml` 中：

```toml
[[d1_databases]]
binding = "DB"
database_name = "personal-website-db"
database_id = "你的database_id"  # 替换这里
```

### 2. 执行迁移

使用已生成的迁移脚本导入数据：

```bash
wrangler d1 execute personal-website-db --file=data/migrate-d1.sql
```

这将导入：
- ✅ 管理员账户（admin / admin123）
- ✅ 3篇种子文章（个人基本信息、我的学习之路、一路所获）
- ✅ 4篇测试文章（可在后台删除）

### 3. 验证数据

```bash
# 查看文章列表
wrangler d1 execute personal-website-db --command="SELECT id, title, category FROM articles ORDER BY id"

# 查看管理员
wrangler d1 execute personal-website-db --command="SELECT id, username FROM admins"
```

### 4. 部署 Workers

```bash
wrangler deploy
```

## API 说明

部署后的 API 地址：`https://your-worker-name.your-subdomain.workers.dev`

### 前台接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/articles` | GET | 获取文章列表 |
| `/api/articles/:id` | GET | 获取文章详情 |
| `/api/articles/tags` | GET | 获取标签统计 |

### 后台接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/login` | POST | 管理员登录 |
| `/api/admin/articles` | GET/POST | 文章列表/创建 |
| `/api/admin/articles/:id` | PUT/DELETE | 更新/删除文章 |

## 常见问题

### Q: 提示 "接口不存在"？

检查 `wrangler.toml` 中的 `database_id` 是否已填写。

### Q: 登录失败？

默认账户：`admin` / `admin123`（已在迁移脚本中预置）

### Q: 标签云不显示？

确保文章有标签（tags 字段不为空），标签云只显示有标签的文章。

## 完整命令清单

```bash
# 1. 登录
wrangler login

# 2. 创建 D1 数据库
wrangler d1 create personal-website-db

# 3. 编辑 wrangler.toml，填入 database_id

# 4. 执行迁移
wrangler d1 execute personal-website-db --file=data/migrate-d1.sql

# 5. 验证数据
wrangler d1 execute personal-website-db --command="SELECT COUNT(*) as count FROM articles"

# 6. 部署
wrangler deploy
```
