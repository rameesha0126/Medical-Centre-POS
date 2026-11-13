ALTER TABLE provider_payouts
ADD COLUMN cash_session_id TEXT REFERENCES cash_sessions(id);

CREATE INDEX idx_provider_payouts_cash_session
ON provider_payouts(cash_session_id);

CREATE INDEX idx_adjustment_recoveries_cash_session
ON provider_adjustment_recoveries(cash_session_id);