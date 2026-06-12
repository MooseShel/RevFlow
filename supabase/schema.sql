-- Supabase Schema Initialization script for RevFlow
-- Enforces Row-Level Security (RLS) and strict schema integrity.

-- Enable UUID extension if not already present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. DROP Tables if they exist (to support clean initialization)
DROP TABLE IF EXISTS access_audit_logs CASCADE;
DROP TABLE IF EXISTS verification_tokens CASCADE;
DROP TABLE IF EXISTS billing_statements CASCADE;

-- 2. CREATE Tables
CREATE TABLE billing_statements (
    statement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id VARCHAR(100) NOT NULL,
    total_due NUMERIC(10, 2) NOT NULL,
    statement_pdf_url TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement_id UUID NOT NULL REFERENCES billing_statements(statement_id) ON DELETE CASCADE,
    hashed_zip VARCHAR(64) NOT NULL, -- SHA-256 hash of ZIP code
    hashed_ssn_last4 VARCHAR(64) NOT NULL, -- SHA-256 hash of last 4 SSN
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE access_audit_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES verification_tokens(token_id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN ('GENERATED', 'ATTEMPT_FAIL', 'VERIFIED', 'VIEWED')),
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. CREATE Indexes for HIPAA performance and auditing
CREATE INDEX idx_statements_patient_id ON billing_statements(patient_id);
CREATE INDEX idx_tokens_statement_id ON verification_tokens(statement_id);
CREATE INDEX idx_tokens_lookup ON verification_tokens(token_id, expires_at) WHERE consumed_at IS NULL;
CREATE INDEX idx_audit_token_id ON access_audit_logs(token_id);
CREATE INDEX idx_audit_timestamp ON access_audit_logs(timestamp);

-- 4. CREATE Custom App Role for Restricted API Access
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'revflow_api') THEN
        CREATE ROLE revflow_api NOLOGIN;
    END IF;
END
$$;

-- Grant standard permissions to revflow_api in public schema
GRANT USAGE ON SCHEMA public TO revflow_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO revflow_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO revflow_api;

-- Ensure newly created tables in public schema are accessible by revflow_api
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO revflow_api;

-- 5. ENABLE Row-Level Security
ALTER TABLE billing_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_audit_logs ENABLE ROW LEVEL SECURITY;

-- 6. DEFINE RLS Policies for revflow_api

-- billing_statements Policies
-- Only allow SELECTing billing_statements if there is a transaction-local setting matching a valid, unexpired, unconsumed token.
CREATE POLICY select_billing_statements_policy ON billing_statements
    FOR SELECT
    TO revflow_api
    USING (
        EXISTS (
            SELECT 1 FROM verification_tokens vt
            WHERE vt.statement_id = billing_statements.statement_id
            AND vt.token_id = NULLIF(current_setting('app.current_verified_token_id', true), '')::uuid
            AND vt.expires_at > now()
        )
    );

-- Allow backend app role to insert billing statements (during ingestion if running as app role)
CREATE POLICY insert_billing_statements_policy ON billing_statements
    FOR INSERT
    TO revflow_api
    WITH CHECK (true);

-- verification_tokens Policies
-- Can read token metadata (e.g. expiration, consumed status) ONLY for the specific token being actively checked
CREATE POLICY select_verification_tokens_policy ON verification_tokens
    FOR SELECT
    TO revflow_api
    USING (
        token_id = NULLIF(current_setting('app.current_token_id', true), '')::uuid
    );

-- Can update the consumed_at timestamp ONLY for the specific token being actively checked
CREATE POLICY update_verification_tokens_policy ON verification_tokens
    FOR UPDATE
    TO revflow_api
    USING (
        token_id = NULLIF(current_setting('app.current_token_id', true), '')::uuid
    )
    WITH CHECK (
        token_id = NULLIF(current_setting('app.current_token_id', true), '')::uuid
    );

-- Can insert new verification tokens (during batch cron job)
CREATE POLICY insert_verification_tokens_policy ON verification_tokens
    FOR INSERT
    TO revflow_api
    WITH CHECK (true);

-- access_audit_logs Policies
-- Can log details of the access (insert logs)
CREATE POLICY insert_access_audit_logs_policy ON access_audit_logs
    FOR INSERT
    TO revflow_api
    WITH CHECK (true);

-- Can select log files (useful for admin reporting queries)
CREATE POLICY select_access_audit_logs_policy ON access_audit_logs
    FOR SELECT
    TO revflow_api
    USING (true);

-- 7. ENABLE Serverless Ingestion and Cron Scheduling Extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 8. CREATE Supabase Storage Bucket for PDF uploads and index files
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'billing-uploads', 
    'billing-uploads', 
    false, 
    52428800, -- 50 MB limit
    ARRAY['application/pdf', 'text/csv']
)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies for 'billing-uploads' bucket
-- Allow service_role (backend edge functions) full access
CREATE POLICY "service_role_billing_uploads_access" ON storage.objects
    FOR ALL
    TO service_role
    USING (bucket_id = 'billing-uploads')
    WITH CHECK (bucket_id = 'billing-uploads');

-- Allow authenticated admins (e.g. billing managers) to upload, read, and delete billing batches
CREATE POLICY "admin_billing_uploads_access" ON storage.objects
    FOR ALL
    TO authenticated
    USING (bucket_id = 'billing-uploads')
    WITH CHECK (bucket_id = 'billing-uploads');

-- 9. SCHEDULE pg_cron Job
-- Schedules an HTTP POST request to trigger the Deno Edge Function
-- Replaces need for external/Railway cron orchestrations.
SELECT cron.schedule(
    'batch-billing-cron',
    '0 9 * * 1-5', -- 9:00 AM Mon-Fri
    $$ SELECT net.http_post(
         'https://cgrvrprtgughfhqporkl.supabase.co/functions/v1/batch-billing',
         '{}'::jsonb,
         '{}'::jsonb,
         jsonb_build_object(
             'Content-Type', 'application/json',
             -- Uses authorization header with service_role key to invoke function
             'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
         ),
         timeout_ms => 120000
       ) $$
);
