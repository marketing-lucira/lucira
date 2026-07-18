-- ============================================================
-- Cloud SQL (PostgreSQL) — Schema for Zoho Task API
-- ============================================================

-- Create database (run once, as superuser)
-- CREATE DATABASE zoho_crm;

-- Connect to database: \c zoho_crm

-- ============================================================
-- TABLE: zoho_task_logs
-- Stores every API call result as a JSONB document
-- ============================================================
CREATE TABLE IF NOT EXISTS zoho_task_logs (
    id          SERIAL PRIMARY KEY,           -- Auto-increment ID
    json_data   JSONB          NOT NULL,      -- Full API response (date, module, report)
    created_at  TIMESTAMP      DEFAULT NOW()  -- Auto timestamp when record inserted
);

-- ============================================================
-- INDEXES (for faster queries)
-- ============================================================

-- Index on date field inside JSON
CREATE INDEX IF NOT EXISTS idx_zoho_date
    ON zoho_task_logs ((json_data->>'date'));

-- Index on module field inside JSON
CREATE INDEX IF NOT EXISTS idx_zoho_module
    ON zoho_task_logs ((json_data->>'module'));

-- Index on created_at for time-range queries
CREATE INDEX IF NOT EXISTS idx_zoho_created_at
    ON zoho_task_logs (created_at);

-- ============================================================
-- SAMPLE QUERIES
-- ============================================================

-- View all records:
-- SELECT id, json_data->>'date' AS date, json_data->>'module' AS module, created_at
-- FROM zoho_task_logs ORDER BY created_at DESC;

-- View report for a specific date:
-- SELECT * FROM zoho_task_logs WHERE json_data->>'date' = '2026-07-05';

-- View specific owner's data:
-- SELECT id, created_at, owner_data
-- FROM zoho_task_logs,
--      jsonb_array_elements(json_data->'report') AS owner_data
-- WHERE owner_data->>'owner' = 'Rahul Kumar';
