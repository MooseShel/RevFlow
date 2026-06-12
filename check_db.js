const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://postgres.cgrvrprtgughfhqporkl:!EmmaNasma1981@aws-1-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await c.connect();
  
  const tables = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
  console.log('Tables:', tables.rows.map(x => x.table_name));

  for (const t of ['billing_statements', 'verification_tokens', 'access_audit_logs']) {
    try {
      const r = await c.query(`SELECT count(*) as cnt FROM ${t}`);
      console.log(`${t}: ${r.rows[0].cnt} rows`);
    } catch (e) {
      console.log(`${t}: ERROR - ${e.message}`);
    }
  }

  // Check column structure
  const cols = await c.query(`
    SELECT table_name, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name IN ('billing_statements','verification_tokens','access_audit_logs')
    ORDER BY table_name, ordinal_position
  `);
  console.log('\nSchema:');
  cols.rows.forEach(r => console.log(`  ${r.table_name}.${r.column_name} (${r.data_type})`));

  await c.end();
}
main().catch(e => { console.error(e.message); c.end(); });
