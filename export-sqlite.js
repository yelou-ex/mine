/**
 * 导出 SQLite 数据库为 SQL 文件，用于迁移到 Cloudflare D1
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'website.db');
const db = new Database(dbPath);

// 获取所有表名
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();

let sql = `-- 从 SQLite 导出，用于迁移到 Cloudflare D1\n`;
sql += `-- 导出时间: ${new Date().toISOString()}\n\n`;

for (const table of tables) {
  const tableName = table.name;
  
  // 跳过 login_logs（登录日志，不需要迁移）
  if (tableName === 'login_logs') continue;
  
  // 获取建表语句
  const createSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`).get()?.sql;
  if (createSql) {
    sql += `${createSql};\n\n`;
  }
  
  // 导出数据
  const rows = db.prepare(`SELECT * FROM "${tableName}"`).all();
  
  if (rows.length > 0) {
    const columns = Object.keys(rows[0]);
    
    for (const row of rows) {
      const values = columns.map(col => {
        const val = row[col];
        if (val === null) return 'NULL';
        if (typeof val === 'number') return val;
        // 转义单引号
        const escaped = String(val).replace(/'/g, "''");
        return `'${escaped}'`;
      });
      
      sql += `INSERT INTO "${tableName}" (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
    }
    sql += '\n';
  }
}

db.close();

// 写入文件
const outputPath = path.join(__dirname, 'data', 'export-to-d1.sql');
fs.writeFileSync(outputPath, sql, 'utf8');

console.log(`导出完成！`);
console.log(`输出文件: ${outputPath}`);
console.log(`包含 ${tables.filter(t => t.name !== 'login_logs').length} 个表的迁移数据`);
