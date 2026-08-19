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
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS login_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  success    INTEGER NOT NULL,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 插入默认管理员（密码: admin123）
-- 注意：生产环境请立即修改密码
INSERT OR IGNORE INTO admins (username, password_hash) 
VALUES ('admin', 'YWRtaW4xMjM=');  -- SHA-256 of 'admin123' in base64

-- 插入种子文章
INSERT OR IGNORE INTO articles (id, title, category, tags, link, content, created_at) VALUES
(1, '个人基本信息', '博客', '', 'introduce.html', '<p>欢迎来到我的个人博客！我叫杨楼，在这里我将分享我的生活、学习和工作中的点点滴滴。无论你是我的朋友、同学、老师，还是偶然路过的访客，都希望这里的内容能够给你带来帮助或启发。</p><p>我会在这里记录我的成长历程，分享有用的知识和经验。如果你对某些内容感兴趣，或者有任何问题或建议，欢迎随时联系我！</p>', '2023-10-15 00:00:00'),
(2, '我的学习之路', '博客', '', 'myway.html', '<p>这部分记录了我的部分成长经历。</p><p>在这里，我将分享我的成长曲线、兴趣分布图等。如果你有任何问题或建议，我很乐意与你交流！</p>', '2023-10-10 00:00:00'),
(3, '一路所获', '博客', '', 'honor.html', '<p>这里是一些我曾经获得的荣誉。</p>', '2023-10-05 00:00:00');
