-- Recovery events for doctor adjustments.
CREATE TABLE provider_adjustment_recoveries (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    recovery_kind TEXT NOT NULL
        CHECK (recovery_kind IN ('PAYOUT_DEDUCTION', 'REPAYMENT')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),

    -- The later settlement against which a deduction was applied.
    target_settlement_id TEXT UNIQUE REFERENCES provider_settlements(id),

    -- Money received directly from the doctor.
    repayment_method TEXT
        CHECK (repayment_method IN ('CASH', 'BANK_TRANSFER', 'QR')),
    reference TEXT,
    cash_session_id TEXT REFERENCES cash_sessions(id),

    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    CHECK (
        (
            recovery_kind = 'PAYOUT_DEDUCTION'
            AND target_settlement_id IS NOT NULL
            AND repayment_method IS NULL
            AND reference IS NULL
            AND cash_session_id IS NULL
        )
        OR
        (
            recovery_kind = 'REPAYMENT'
            AND target_settlement_id IS NULL
            AND repayment_method IS NOT NULL
            AND (
                (
                    repayment_method = 'CASH'
                    AND cash_session_id IS NOT NULL
                )
                OR
                (
                    repayment_method IN ('BANK_TRANSFER', 'QR')
                    AND cash_session_id IS NULL
                    AND reference IS NOT NULL
                    AND length(trim(reference)) > 0
                )
            )
        )
    )
);

-- One recovery may cover several adjustments.
-- One adjustment may be recovered across several events.
CREATE TABLE provider_adjustment_recovery_items (
    id TEXT PRIMARY KEY,
    recovery_id TEXT NOT NULL
        REFERENCES provider_adjustment_recoveries(id),
    adjustment_id TEXT NOT NULL
        REFERENCES provider_settlement_adjustments(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    UNIQUE (recovery_id, adjustment_id)
);

CREATE INDEX idx_adjustment_recoveries_doctor
ON provider_adjustment_recoveries(doctor_id, created_at);

CREATE INDEX idx_adjustment_recovery_items_adjustment
ON provider_adjustment_recovery_items(adjustment_id);