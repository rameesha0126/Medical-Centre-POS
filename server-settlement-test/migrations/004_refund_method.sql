-- Record how each refund was actually returned.
-- NULL is allowed for historical refunds created before this migration.
ALTER TABLE refunds
ADD COLUMN refund_method TEXT
CHECK (
    refund_method IS NULL
    OR refund_method IN ('CASH', 'BANK_TRANSFER', 'QR')
);