const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://postgres.cgrvrprtgughfhqporkl:!EmmaNasma1981@aws-1-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  await c.connect();
  console.log('Connected. Running migration...');

  // 1. Add batch_uploads table for reporting
  await c.query(`
    CREATE TABLE IF NOT EXISTS batch_uploads (
      batch_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      uploaded_by VARCHAR(100) DEFAULT 'admin',
      file_count INTEGER NOT NULL DEFAULT 0,
      extracted_count INTEGER NOT NULL DEFAULT 0,
      confirmed_count INTEGER NOT NULL DEFAULT 0,
      emails_sent INTEGER NOT NULL DEFAULT 0,
      sms_sent INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('✓ Created batch_uploads table');

  // 2. Add patient_name column to billing_statements
  await c.query(`
    ALTER TABLE billing_statements
    ADD COLUMN IF NOT EXISTS patient_name VARCHAR(200);
  `);
  console.log('✓ Added patient_name to billing_statements');

  // 3. Add batch_id foreign key to billing_statements
  await c.query(`
    ALTER TABLE billing_statements
    ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES batch_uploads(batch_id);
  `);
  console.log('✓ Added batch_id to billing_statements');

  // 4. Add hashed_phone to verification_tokens for phone-based verification
  await c.query(`
    ALTER TABLE verification_tokens
    ADD COLUMN IF NOT EXISTS hashed_phone VARCHAR(128);
  `);
  console.log('✓ Added hashed_phone to verification_tokens');

  // 5. Add notification tracking columns to verification_tokens
  await c.query(`
    ALTER TABLE verification_tokens
    ADD COLUMN IF NOT EXISTS email_sent BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS sms_sent BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sms_sent_at TIMESTAMPTZ;
  `);
  console.log('✓ Added notification tracking to verification_tokens');

  // 6. Grant permissions to revflow_api role (if exists)
  try {
    await c.query(`GRANT SELECT, INSERT ON batch_uploads TO revflow_api;`);
    console.log('✓ Granted batch_uploads permissions to revflow_api');
  } catch (e) {
    console.log('⚠ Could not grant to revflow_api (may not exist):', e.message);
  }

  console.log('\n✅ Migration complete!');
  
  // Verify schema
  const cols = await c.query(`
    SELECT table_name, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name IN ('billing_statements','verification_tokens','access_audit_logs','batch_uploads')
    ORDER BY table_name, ordinal_position
  `);
  console.log('\nUpdated Schema:');
  let lastTable = '';
  cols.rows.forEach(r => {
    if (r.table_name !== lastTable) { console.log(`\n  [${r.table_name}]`); lastTable = r.table_name; }
    console.log(`    ${r.column_name} (${r.data_type})`);
  });

  await c.end();
}

migrate().catch(e => { console.error('Migration failed:', e.message); c.end(); });
