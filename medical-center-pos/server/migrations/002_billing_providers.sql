
-- Laboratory providers. Supports one provider initially and multiple later.
CREATE TABLE lab_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    contact_person TEXT,
    default_provider_share_basis_points INTEGER NOT NULL DEFAULT 7000
        CHECK (default_provider_share_basis_points BETWEEN 0 AND 10000),
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_lab_providers_active
    ON lab_providers(is_active);

-- A laboratory service is assigned to a provider.
-- Initially, all laboratory services will use the same provider.
ALTER TABLE services
ADD COLUMN lab_provider_id TEXT REFERENCES lab_providers(id);

CREATE INDEX idx_services_lab_provider
    ON services(lab_provider_id);

-- Preserve the provider association on each invoice item.
-- This is a snapshot, just like the recorded financial shares.
ALTER TABLE invoice_items
ADD COLUMN lab_provider_id TEXT REFERENCES lab_providers(id);

CREATE INDEX idx_invoice_items_lab_provider
    ON invoice_items(lab_provider_id);

-- Each doctor has a fixed consultation fee.
-- The invoice item will snapshot the actual fee charged.
ALTER TABLE doctors
ADD COLUMN consultation_fee_minor INTEGER NOT NULL DEFAULT 0
    CHECK (consultation_fee_minor >= 0);

-- Allow lab settlements to identify the actual provider.
-- provider_name remains available for historical display.
ALTER TABLE provider_settlements
ADD COLUMN lab_provider_id TEXT REFERENCES lab_providers(id);

CREATE INDEX idx_provider_settlements_lab_provider
    ON provider_settlements(lab_provider_id);
