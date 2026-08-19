/**
 * 数据库迁移工具
 * 将本地 SQLite 数据库迁移到 Cloudflare D1
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

async function main() {
  // 读取本地 SQLite 数据库
  const dbPath = path.join(__dirname, 'data', 'website.db');
  const db = new Database(dbPath);
  
  console.log('=== 数据库迁移工具 ===\n');
  
  // 1. 导出表结构
  console.log('1. 导出表结构...');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name").all();
  
  let createTablesSQL = '';
  for (const table of tables) {
    const tableName = table.name;
    const createSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`).get()?.sql;
    if (createSql) {
      createTablesSQL += `${createSql};\n\n`;
    }
  }
  
  // 2. 导出数据
  console.log('2. 导出数据...');
  let insertSQL = '';
  
  for (const table of tables) {
    const tableName = table.name;
    
    // 跳过 login_logs（数据量大且不需要迁移）
    if (tableName === 'login_logs') {
      console.log(`   跳过 ${tableName}（登录日志）`);
      continue;
    }
    
    const rows = db.prepare(`SELECT * FROM "${tableName}"`).all();
    console.log(`   ${tableName}: ${rows.length} 条记录`);
    
    if (rows.length === 0) continue;
    
    const columns = Object.keys(rows[0]);
    
    for (const row of rows) {
      const values = columns.map(col => {
        const val = row[col];
        if (val === null) return 'NULL';
        if (typeof val === 'number') return val;
        const escaped = String(val).replace(/'/g, "''");
        return `'${escaped}'`;
      });
      
      insertSQL += `INSERT OR IGNORE INTO "${tableName}" (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
    }
  }
  
  // 3. 生成完整 SQL 文件
  const fullSQL = [
    `-- 从 SQLite 导出，用于迁移到 Cloudflare D1`,
    `-- 导出时间: ${new Date().toISOString()}`,
    `-- 使用方式: wrangler d1 execute personal-website-db --file=data/migrate-d1.sql`,
    ``,
    createTablesSQL,
    insertSQL
  ].join('\n');
  
  const outputPath = path.join(__dirname, 'data', 'migrate-d1.sql');
  fs.writeFileSync(outputPath, fullSQL, 'utf8');
  
  console.log(`\n3. 迁移 SQL 已生成: ${outputPath}`);
  console.log('\n下一步:');
  console.log('1. 在 Cloudflare Dashboard 创建 D1 数据库（或直接使用 wrangler d1 create）');
  console.log('2. 运行: wrangler d1 execute personal-website-db --file=data/migrate-d1.sql');
  console.log('3. 更新 wrangler.toml 中的 database_id');
  console.log('4. 部署: wrangler deploy');
  
  db.close();
}

main().catch(console.error);
