const { Pool } = require('pg'), fs = require('fs'), path = require('path');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
async function migrate() {
  const c = await pool.connect(), dir = path.join(__dirname, '../migrations');
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    for (const f of fs.readdirSync(dir).sort()) {
      if ((await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) continue;
      await c.query('BEGIN');
      try { await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); await c.query('COMMIT'); console.log('migrated', f); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { c.release(); }
}
if (require.main === module) { require('dotenv').config(); migrate().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); }); }
module.exports = { pool, migrate };
