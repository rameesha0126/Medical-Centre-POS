
-- Track which cash session received each cash payment.
-- Existing payments remain NULL for historical compatibility.

ALTER TABLE payments
ADD COLUMN cash_session_id TEXT
REFERENCES cash_sessions(id);

-- Track which cash session paid each cash refund.
-- Existing refunds remain NULL for historical compatibility.

ALTER TABLE refunds
ADD COLUMN cash_session_id TEXT
REFERENCES cash_sessions(id);

-- Improve cash movement queries.
CREATE INDEX idx_payments_cash_session
ON payments(cash_session_id);

CREATE INDEX idx_refunds_cash_session
ON refunds(cash_session_id);

-- Only one cash drawer session may be open at a time.
CREATE UNIQUE INDEX idx_cash_sessions_one_open
ON cash_sessions(status)
WHERE status = 'OPEN';
