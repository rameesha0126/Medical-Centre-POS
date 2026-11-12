ALTER TABLE provider_settlements
ADD COLUMN amount_recovered_minor INTEGER NOT NULL DEFAULT 0
    CHECK (
        amount_recovered_minor >= 0
        AND amount_paid_minor + amount_recovered_minor <= amount_due_minor
    );