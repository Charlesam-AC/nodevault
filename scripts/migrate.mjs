import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pg = require('../backend/node_modules/pg');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL?.trim() ?? '';
const schemaName = 'database/init.sql';

if (url === '') {
  console.log('migrate: nothing to do');
  process.exit(0);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED?.trim() || url,
});
await client.connect();
try {
  await client.query("set lock_timeout = '60s'");
  await client.query('select pg_advisory_lock(7272741)');
  await client.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  const done = await client.query('select 1 from schema_migrations where name = $1', [schemaName]);
  if (done.rowCount > 0) {
    console.log('migrate: schema already applied');
  } else {
    const sql = await readFile(path.join(root, schemaName), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [schemaName]);
      await client.query('commit');
      console.log('migrate: applied database/init.sql');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
} finally {
  await client.end();
}
