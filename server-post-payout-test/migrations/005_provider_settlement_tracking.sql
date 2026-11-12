
-- Migration 005: Provider settlement tracking

-- 1. Individual doctor consultation sessions
CREATE TABLE doctor_sessions (
    id TEXT PRIMARY KEY,
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    session_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SCHEDULED'
        CHECK (status IN ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (start_time < end_time),
    UNIQUE (doctor_id, session_date, start_time)
);

CREATE INDEX idx_doctor_sessions_date
ON doctor_sessions(session_date, doctor_id);

-- 2. Associate appointments with individual sessions
ALTER TABLE appointments
ADD COLUMN doctor_session_id TEXT
REFERENCES doctor_sessions(id);

CREATE INDEX idx_appointments_doctor_session
ON appointments(doctor_session_id);

-- 3. Record exactly which invoice items are settled
CREATE TABLE provider_settlement_items (
    id TEXT PRIMARY KEY,
    settlement_id TEXT NOT NULL
        REFERENCES provider_settlements(id),
    invoice_item_id TEXT NOT NULL
        REFERENCES invoice_items(id),
    amount_minor INTEGER NOT NULL
        CHECK (amount_minor > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (invoice_item_id)
);

CREATE INDEX idx_provider_settlement_items_settlement
ON provider_settlement_items(settlement_id);

-- 4. Track manual provider-impact allocations for refunds
CREATE TABLE refund_provider_allocations (
    id TEXT PRIMARY KEY,
    refund_id TEXT NOT NULL
        REFERENCES refunds(id),
    invoice_item_id TEXT NOT NULL
        REFERENCES invoice_items(id),
    provider_reduction_minor INTEGER NOT NULL
        CHECK (provider_reduction_minor >= 0),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (refund_id, invoice_item_id)
);

CREATE INDEX idx_refund_provider_allocations_item
ON refund_provider_allocations(invoice_item_id);

-- 5. Track provider adjustments after settlements
CREATE TABLE provider_settlement_adjustments (
    id TEXT PRIMARY KEY,
    settlement_id TEXT NOT NULL
        REFERENCES provider_settlements(id),
    refund_provider_allocation_id TEXT NOT NULL
        REFERENCES refund_provider_allocations(id),
    adjustment_minor INTEGER NOT NULL
        CHECK (adjustment_minor > 0),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPLIED', 'CANCELLED')),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (refund_provider_allocation_id)
);

CREATE INDEX idx_provider_settlement_adjustments_settlement
ON provider_settlement_adjustments(settlement_id);
