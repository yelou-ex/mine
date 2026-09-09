-- 初始化 D1 数据库表结构
-- 在 Cloudflare Dashboard 或命令行中执行：wrangler d1 execute personal-website-db --file=init-d1.sql

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS articles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  category   TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT 'html',  -- html | markdown（markdown 时 content 为 md 源码）
  views      INTEGER NOT NULL DEFAULT 0,    -- 浏览次数（详情页访问时 +1，后台可见）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS login_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  success    INTEGER NOT NULL,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_ms INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_article ON comments (article_id);

-- 插入默认管理员（密码: admin123）
-- 注意：生产环境请立即修改密码
INSERT OR IGNORE INTO admins (username, password_hash) 
VALUES ('admin', 'YWRtaW4xMjM=');  -- SHA-256 of 'admin123' in base64

-- 插入种子文章
-- 说明：原三篇种子（个人基本信息/我的学习之路/一路所获）已合并为单一「关于我」入口；
-- 学习之路/一路所获页面已并入 introduce.html（原 myway.html、honor.html 已下线）
INSERT OR IGNORE INTO articles (id, title, category, tags, link, content, created_at) VALUES
(1, '关于我', '博客', '', 'introduce.html', '<p>欢迎来到我的个人博客！我叫杨楼，在这里我将分享我的生活、学习和工作中的点点滴滴。无论你是我的朋友、同学、老师，还是偶然路过的访客，都希望这里的内容能够给你带来帮助或启发。</p><p>我会在这里记录我的成长历程，分享有用的知识和经验。如果你对某些内容感兴趣，或者有任何问题或建议，欢迎随时联系我！</p><p>这部分记录了我的部分成长经历。在这里，我将分享我的成长曲线、兴趣分布图等。如果你有任何问题或建议，我很乐意与你交流！</p>', '2023-10-15 00:00:00');

-- 迁移：将旧库中三篇种子文章合并为单一「关于我」入口（链接重定向 + 就地更名 + 删除余下两篇，评论随外键级联清理）
UPDATE articles SET link = 'introduce.html' WHERE title IN ('我的学习之路', '一路所获') AND link IN ('myway.html', 'honor.html');
UPDATE articles SET title = '关于我' WHERE title = '个人基本信息' AND link IN ('', 'introduce.html');
DELETE FROM articles WHERE title IN ('我的学习之路', '一路所获') AND link IN ('', 'introduce.html', 'myway.html', 'honor.html');
