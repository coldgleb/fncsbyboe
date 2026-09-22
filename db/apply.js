/* Накатить db/api.sql (пересоздаёт схему api, таблицы не трогает).
   Подключение — из переменных окружения, пароль в репозиторий не кладём:
     PGHOST=sgl813.ru PGPORT=37526 PGUSER=fncsuser PGPASSWORD=… PGDATABASE=fncsbyboe node db/apply.js */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const c = new Client();              // берёт PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
  await c.connect();
  try {
    await c.query(fs.readFileSync(path.join(__dirname, 'api.sql'), 'utf8'));
    const { rows } = await c.query(`
      SELECT p.proname AS name, 'function' AS kind
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'api'
      UNION ALL
      SELECT table_name, 'view' FROM information_schema.views WHERE table_schema = 'api'
      ORDER BY 2, 1`);
    console.log(`схема api: ${rows.length} объектов`);
    for (const r of rows) console.log(`  ${r.kind.padEnd(8)} ${r.name}`);
  } finally { await c.end(); }
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
