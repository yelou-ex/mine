/**
 * db.js — SQLite 数据库层（better-sqlite3）
 * 表结构：
 *   admins      管理员账户（密码 bcrypt 哈希存储，含失败计数/锁定字段）
 *   articles    文章
 *   login_logs  登录日志
 * 所有 SQL 均使用参数化查询（prepared statements），防止注入。
 */
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// 数据目录：默认项目内 ./data；部署到 Node 平台时可用 DATA_DIR 环境变量指向持久化卷
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'website.db');

// 默认管理员（仅当管理员表为空时创建；生产环境请立即修改密码）
const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

// 首次运行时创建默认管理员
const DEFAULT_ARTICLES = [
  {
    title: '个人基本信息',
    category: '博客',
    tags: '',
    created_at: '2023-10-15 00:00:00',
    content:
      '<p>欢迎来到我的个人博客！我叫杨楼，在这里我将分享我的生活、学习和工作中的点点滴滴。无论你是我的朋友、同学、老师，还是偶然路过的访客，都希望这里的内容能够给你带来帮助或启发。</p>' +
      '<p>我会在这里记录我的成长历程，分享有用的知识和经验。如果你对某些内容感兴趣，或者有任何问题或建议，欢迎随时联系我！</p>',
  },
  {
    title: '我的学习之路',
    category: '博客',
    tags: '',
    created_at: '2023-10-10 00:00:00',
    content:
      '<p>这部分记录了我的部分成长经历。</p>' +
      '<p>在这里，我将分享我的成长曲线、兴趣分布图等。如果你有任何问题或建议，我很乐意与你交流！</p>',
  },
  {
    title: '一路所获',
    category: '博客',
    tags: '',
    created_at: '2023-10-05 00:00:00',
    content: '<p>这里是一些我曾经获得的荣誉。</p>',
  },
];

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS login_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL,
    success    INTEGER NOT NULL,
    ip         TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// 初始化默认管理员（密码 bcrypt cost=10）
function ensureDefaultAdmin() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM admins').get();
  if (row.c === 0) {
    const hash = bcrypt.hashSync(DEFAULT_ADMIN.password, 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(
      DEFAULT_ADMIN.username,
      hash
    );
    console.log(`[db] 已创建默认管理员账户：${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
    console.log('[db] 安全提醒：请登录后台后尽快修改默认密码（当前版本暂无修改密码功能，可改 data/website.db）');
  }
}

// 首次运行时写入种子文章（保持与网站原有静态内容一致）
function ensureSeedArticles() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM articles').get();
  if (row.c > 0) return;
  const ins = db.prepare(
    'INSERT INTO articles (title, content, category, tags, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const a of DEFAULT_ARTICLES) {
      ins.run(a.title, a.content, a.category, a.tags, a.created_at);
    }
  });
  tx();
  console.log('[db] 已写入初始文章（与原静态页面内容一致）');
}

// 首次运行初始化：仅在数据库为新库（user_version < 1）时写入默认管理员与种子文章，
// 避免用户删光文章后重启导致内容"复活"
const schemaVersion = db.pragma('user_version', { simple: true });
if (schemaVersion < 1) {
  ensureDefaultAdmin();
  ensureSeedArticles();
  db.pragma('user_version = 1');
}

module.exports = db;
