# Yelou 个人博客（个人主页网站）

个人主页网站后台管理系统，按《管理员登录与文章添加功能需求文档》v1.1 实现。
文章维护不再依赖直接编辑 HTML 文件：管理员登录后台后，可在线发布、检索、删除文章，内容自动入库，前台即时展示。

## 功能一览（对应需求文档）

| 需求模块 | 已实现内容 |
| --- | --- |
| 管理员登录 | 登录页面（回车提交/输入提示）、防空白提交、密码哈希校验（本地 bcrypt / 线上 PBKDF2）、统一错误提示（防账号枚举）、签名会话 Cookie（30 分钟滑动续期）、退出登录、连续 5 次失败锁定 15 分钟、登录日志、**修改密码** |
| 权限管理 | 未登录访问后台页重定向登录并回跳、提交/删除前身份校验（401/403）、会话时效校验、后台写接口 CSRF Token 防护（双提交 Cookie） |
| 文章添加 | 标题/类别/内容/标签表单、前后端双重校验（长度/格式/必填）、XSS 白名单过滤、防重复提交（5 秒去重 + 按钮防连点）、**删除后 id 自动复用**（删了 4 下一篇仍是 4） |
| 文章列表与删除 | 列表页（标题/类别检索、分页）、删除二次确认（展示文章标题）、删除身份校验、批量删除、删除后前台立即下架 |
| 前台展示 | 首页文章列表动态渲染（**含内容摘要预览**）、分类筛选、最近文章、文章详情页（渲染二次转义） |

## 双后端架构

本项目提供**两套后端**，同一套前端页面共用：

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| 本地 Node（`server.js`） | 本地开发 | Express 5 + express-session + bcryptjs + better-sqlite3（SQLite 文件） |
| Cloudflare（`functions/`） | **线上免费部署（推荐）** | Cloudflare Pages Functions + D1 数据库，零依赖纯 Web API，免费额度：Functions 10 万请求/天、D1 5GB 存储 |

前端页面（`index.html` / `article.html` / `admin/`）两种方式下**无需任何修改**（接口路径一致）。

## 本地运行（开发）

```bash
# 安装依赖（本机 npm 默认缓存路径可能被拒，加 --cache 指定项目内缓存）
npm install --cache "E:\学习\网站\个人主页\.npm-cache"

# 启动（默认端口 3000，可用 PORT 覆盖）
npm start
# 或 node server.js
```

- 前台首页：http://localhost:3000/
- 后台登录页：http://localhost:3000/admin/login.html
- 默认管理员：`admin` / `admin123`

> ⚠️ 安全提醒：默认管理员密码为初始值，上线后请登录后台 → 右上角「修改密码」立即修改。

## 线上部署（Cloudflare Pages + Functions + D1，全部免费）

### 原理

- 静态页面（`index.html`、`article.html`、`admin/`、`picture/`）由 Cloudflare Pages 托管，和现在一样
- 所有 `/api/*` 请求由 `functions/` 目录里的函数处理（Cloudflare 自动识别）
- 数据存在 **D1** 数据库（Cloudflare 的 SQLite，免费 5GB 存储 + 500 万行读/天）
- 会话为无状态签名 Cookie（HMAC-SHA256），密码用 Web Crypto PBKDF2 哈希（适配 Workers 免费版 CPU 限制）

### 操作步骤

1. **把代码推送到 GitHub**（`data/`、`node_modules/` 已被 `.gitignore` 排除）
   ```bash
   git add -A
   git commit -m "添加 Cloudflare Functions 后端"
   git push origin main
   ```
2. **创建 D1 数据库**：Cloudflare 控制台 → Workers & Pages → D1 → Create database（名字随意，如 `personal-website-db`），创建后复制 **Database ID**
3. **绑定 D1 到 Pages 项目**：打开你的 Pages 项目 → Settings → Functions → D1 database bindings → 绑定数据库，**变量名必须为 `DB`**
4. **设置会话密钥**：Pages 项目 → Settings → Environment variables → Production 添加 `SESSION_SECRET`（任意长随机字符串，如 `openssl rand -hex 32` 生成的值）。不设置也能运行，但密钥不固定会导致每次部署后需重新登录
5. **构建配置**：Pages 项目 → Settings → Builds & deployments → 构建命令留空、输出目录 `/`（无需框架构建）
6. **重新部署**：推送代码后 Cloudflare 会自动构建部署，或手动 Deploy
7. 访问 `https://<项目名>.pages.dev`（前台 + `/admin/login.html` 均可使用）

> 说明：线上是**全新数据库**，首次部署自动写入 3 篇种子文章和默认管理员 `admin/admin123`。你本地后台发布过的文章不会自动同步到线上，需要在线上后台重新发布。

### 本地测试 Cloudflare 函数

```bash
npm run test:cf   # 36 项用例（用 better-sqlite3 模拟 D1，覆盖登录/权限/CSRF/校验/XSS/删除/防暴力破解）
```

## 目录结构

```
├── server.js              # 本地 Express 后端
├── db.js                  # 本地 SQLite 数据库层
├── functions/             # Cloudflare Pages Functions（线上后端）
│   ├── _lib.mjs           #   共享工具（PBKDF2/会话签名/CSRF/XSS/校验/D1 初始化）
│   └── api/[[path]].mjs   #   全量 API 路由
├── admin/
│   ├── login.html         # 后台登录页
│   └── dashboard.html     # 后台管理页（列表/检索/添加/删除/批量删除）
├── index.html             # 前台首页（动态加载文章 + 分类筛选）
├── article.html           # 前台文章详情页
├── introduce.html / myway.html / honor.html   # 原有静态页面
├── picture/               # 图片资源
├── data/                  # 本地运行时数据（SQLite + 会话密钥，勿提交/勿公开）
├── test-e2e.mjs           # 本地 Express 版端到端测试（45 项）
└── test-functions.mjs     # Cloudflare Functions 版测试（36 项）
```

## 测试

```bash
# 本地 Express 版（需先启动服务器）
node test-e2e.mjs        # 45 项

# Cloudflare Functions 版（无需服务器）
npm run test:cf          # 36 项
```

## API 一览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/login` | 公开 | 登录（校验/失败锁定） |
| POST | `/api/logout` | 公开 | 退出登录 |
| GET | `/api/auth/status` | 公开 | 当前登录状态 |
| GET | `/api/csrf-token` | 管理员 | 获取 CSRF Token |
| GET | `/api/articles` | 公开 | 文章列表（支持 `?category=`） |
| GET | `/api/articles/:id` | 公开 | 文章详情 |
| GET | `/api/admin/articles` | 管理员 | 文章管理列表（支持 `?keyword=&category=`） |
| POST | `/api/admin/articles` | 管理员+CSRF | 新增文章 |
| DELETE | `/api/admin/articles/:id` | 管理员+CSRF | 删除文章 |
| POST | `/api/admin/articles/batch-delete` | 管理员+CSRF | 批量删除（body: `{ids:[]}`） |
| POST | `/api/admin/change-password` | 管理员+CSRF | 修改密码（body: `{oldPassword, newPassword}`） |

## 安全说明

- 密码哈希存储（本地 bcrypt cost=10 / 线上 PBKDF2 6 万次迭代），数据库无明文
- 会话 Cookie：HttpOnly + SameSite=Lax + Secure（HTTPS），无状态 HMAC 签名防篡改
- 写接口强制 CSRF Token 双提交校验
- 所有 SQL 参数化查询（better-sqlite3 / D1 均支持），防注入
- 文章内容 XSS 白名单过滤（去 script/事件属性/iframe）+ 前台渲染二次转义
- 本地静态服务拦截源码/数据库下载；Cloudflare 端函数不暴露源码
- 登录失败限流：同一账户连续 5 次失败锁定 15 分钟（D1 持久化），失败记录写登录日志表

## 已知限制 / 后续迭代（对应需求文档第 8、10 节）

- 暂无「文章编辑」「草稿」「富文本编辑器升级」功能（需求列为后续迭代）
- 删除为物理删除（软删除 + 回收站为待决事项）
- Cloudflare 端登录失败计数与防重复提交存 D1（持久化）；本地端存内存
