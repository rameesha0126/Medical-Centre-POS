-- Explicit reconciliation status for refunds created before allocation tracking.
-- Does not change refunds, payments, invoice balances, or provider payouts.
CREATE TABLE historical_refund_reviews (
  refund_id TEXT PRIMARY KEY REFERENCES refunds(id),
  review_kind TEXT NOT NULL CHECK (
    review_kind IN ('NO_PROVIDER_SHARE', 'MANUAL_PROVIDER_ALLOCATION')
  ),
  review_note TEXT NOT NULL CHECK (length(trim(review_note)) > 0),
  reviewed_by TEXT NOT NULL REFERENCES users(id),
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_historical_refund_reviews_kind
ON historical_refund_reviews(review_kind);
