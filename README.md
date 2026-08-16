# Yelou 个人博客（个人主页网站）

个人主页网站后台管理系统，按《管理员登录与文章添加功能需求文档》v1.1 实现。
文章维护不再依赖直接编辑 HTML 文件：管理员登录后台后，可在线发布、检索、删除文章，内容自动入库，前台即时展示。

## 功能一览（对应需求文档）

| 需求模块 | 已实现内容 |
| --- | --- |
| 管理员登录 | 登录页面（回车提交/输入提示）、防空白提交、bcrypt 密码校验、统一错误提示（防账号枚举）、Session 会话（30 分钟滑动续期）、退出登录、连续 5 次失败锁定 15 分钟、登录日志 |
| 权限管理 | 未登录访问后台页重定向登录并回跳、提交/删除前服务端身份校验（401/403）、会话时效校验、后台写接口 CSRF Token 防护 |
| 文章添加 | 标题/类别/内容/标签表单、前后端双重校验（长度/格式/必填）、XSS 白名单过滤、服务端 5 秒防重复提交、按钮防连点 |
| 文章列表与删除 | 列表页（标题/类别检索）、删除二次确认（展示文章标题）、删除身份校验、批量删除、删除后前台立即下架 |
| 前台展示 | 首页文章列表动态渲染、分类筛选、最近文章、文章详情页（渲染二次转义） |

## 技术栈

- 后端：Node.js + Express 5 + express-session + bcryptjs + better-sqlite3（SQLite，参数化查询）
- 内容安全：sanitize-html 白名单过滤 + 前端渲染转义
- 数据库：SQLite（`data/website.db`，首次启动自动建表并写入默认管理员与初始文章）

## 快速开始

```bash
# 1. 安装依赖（本机 npm 默认缓存路径可能被拒，加 --cache 指定项目内缓存）
npm install --cache "E:\学习\网站\个人主页\.npm-cache"

# 2. 启动服务器（默认端口 3000，可用 PORT 环境变量覆盖）
npm start
# 或
node server.js
```

启动后：

- 前台首页：<http://localhost:3000/>
- 后台登录页：<http://localhost:3000/admin/login.html>
- 默认管理员：`admin` / `admin123`

> ⚠️ 安全提醒：默认管理员密码为初始值，生产环境部署后请立即修改
> （当前版本暂无改密功能，可删除 `data/website.db` 后重启以重置，或直接改库）。

## 目录结构

```
├── server.js            # 后端服务（登录/权限/文章 CRUD/CSRF/防暴力破解）
├── db.js                # SQLite 数据库层（建表/默认管理员/种子文章）
├── admin/
│   ├── login.html       # 后台登录页
│   └── dashboard.html   # 后台管理页（列表/检索/添加/删除/批量删除）
├── index.html           # 前台首页（动态加载文章 + 分类筛选）
├── article.html         # 前台文章详情页
├── introduce.html / myway.html / honor.html   # 原有静态页面
├── picture/             # 图片资源
├── data/                # 运行时生成：SQLite 数据库 + 会话密钥（勿提交/勿公开）
└── test-e2e.mjs         # 端到端测试脚本
```

## API 一览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/login` | 公开 | 登录（bcrypt 校验/失败锁定） |
| POST | `/api/logout` | 公开 | 退出登录 |
| GET | `/api/auth/status` | 公开 | 当前登录状态 |
| GET | `/api/csrf-token` | 管理员 | 获取 CSRF Token |
| GET | `/api/articles` | 公开 | 文章列表（支持 `?category=`） |
| GET | `/api/articles/:id` | 公开 | 文章详情 |
| GET | `/api/admin/articles` | 管理员 | 文章管理列表（支持 `?keyword=&category=`） |
| POST | `/api/admin/articles` | 管理员+CSRF | 新增文章 |
| DELETE | `/api/admin/articles/:id` | 管理员+CSRF | 删除文章 |
| POST | `/api/admin/articles/batch-delete` | 管理员+CSRF | 批量删除（body: `{ids:[]}`） |

## 运行测试

启动服务器后执行：

```bash
node test-e2e.mjs
```

覆盖需求文档验收标准 AC-01 ~ AC-14（登录/防空白/权限拦截/字段校验/XSS/防重复提交/删除/批量删除/防暴力破解/退出）。

## 安全说明

- 密码 bcrypt 哈希存储（cost=10），数据库无明文
- 会话 Cookie：HttpOnly + SameSite=Lax，登录成功轮换 Session ID 防会话固定
- 写接口强制 CSRF Token 校验
- 所有 SQL 参数化查询，防注入
- 文章内容 sanitize-html 白名单过滤（去 script/事件属性/iframe），前台渲染再转义
- 静态服务拦截源码/数据库/配置文件下载（`server.js`、`db.js`、`data/`、`node_modules/` 等 403）
- 生产环境（`NODE_ENV=production`）自动强制 HTTPS + HSTS
- 登录失败限流：同一账户连续 5 次失败锁定 15 分钟，失败记录写登录日志表

## 已知限制 / 后续迭代（对应需求文档第 8、10 节）

- 暂无「修改密码」「文章编辑」「草稿」「富文本编辑器升级」功能（需求列为后续迭代）
- 登录失败锁定计数存内存，服务器重启后清零
- 删除为物理删除（软删除 + 回收站为待决事项）
