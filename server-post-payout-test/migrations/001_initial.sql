PRAGMA foreign_keys = ON;

-- Staff accounts. Password hashes will be added by the
-- authentication implementation; never store plaintext passwords.
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('OWNER', 'STAFF')),
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Minimal patient data required for appointments and billing.
CREATE TABLE patients (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_patients_name ON patients(full_name);
CREATE INDEX idx_patients_phone ON patients(phone);

CREATE TABLE doctors (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Store session times as local ISO-like strings for the center.
-- The application will validate dates and times.
CREATE TABLE doctor_schedules (
    id TEXT PRIMARY KEY,
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    day_of_week INTEGER NOT NULL
        CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    effective_from TEXT,
    effective_until TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),
    CHECK (start_time < end_time)
);

-- Exceptions support changed, cancelled, or additional sessions.
CREATE TABLE schedule_exceptions (
    id TEXT PRIMARY KEY,
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    session_date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('CHANGED', 'CANCELLED', 'ADDED')),
    notes TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
        status = 'CANCELLED'
        OR (start_time IS NOT NULL AND end_time IS NOT NULL
            AND start_time < end_time)
    )
);

CREATE TABLE appointments (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id),
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    schedule_exception_id TEXT REFERENCES schedule_exceptions(id),
    appointment_date TEXT NOT NULL,
    queue_number INTEGER NOT NULL CHECK (queue_number > 0),
    booking_source TEXT NOT NULL
        CHECK (booking_source IN ('PHONE', 'MESSAGE', 'WALK_IN', 'IN_PERSON')),
    status TEXT NOT NULL DEFAULT 'BOOKED'
        CHECK (status IN (
            'BOOKED', 'ARRIVED', 'WAITING',
            'READY', 'IN_CONSULTATION',
            'COMPLETED', 'CANCELLED', 'NO_SHOW'
        )),
    notes TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (doctor_id, appointment_date, queue_number)
);

CREATE INDEX idx_appointments_date_doctor
    ON appointments(appointment_date, doctor_id, status);

-- Service catalog: consultation, lab test, or medical procedure.
CREATE TABLE services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    service_type TEXT NOT NULL
        CHECK (service_type IN ('CONSULTATION', 'LAB', 'PROCEDURE')),
    default_price_minor INTEGER NOT NULL CHECK (default_price_minor >= 0),
    requires_full_payment INTEGER NOT NULL DEFAULT 1
        CHECK (requires_full_payment IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Invoices are separate from payments.
CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT NOT NULL UNIQUE,
    patient_id TEXT NOT NULL REFERENCES patients(id),
    appointment_id TEXT REFERENCES appointments(id),
    status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'PAID', 'CANCELLED', 'REFUNDED')),
    subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
    discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
    total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (discount_minor <= subtotal_minor),
    CHECK (total_minor = subtotal_minor - discount_minor)
);

CREATE TABLE invoice_items (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id),
    service_id TEXT NOT NULL REFERENCES services(id),
    doctor_id TEXT REFERENCES doctors(id),
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
    provider_share_minor INTEGER NOT NULL DEFAULT 0
        CHECK (provider_share_minor >= 0),
    center_share_minor INTEGER NOT NULL DEFAULT 0
        CHECK (center_share_minor >= 0),
    CHECK (line_total_minor = quantity * unit_price_minor),
    CHECK (
        line_total_minor = provider_share_minor + center_share_minor
    )
);

-- Amounts are stored in minor currency units (for LKR, cents).
-- Payment method and reference are recorded for reconciliation.
CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    method TEXT NOT NULL
        CHECK (method IN ('CASH', 'BANK_TRANSFER', 'QR')),
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'CONFIRMED'
        CHECK (status IN ('CONFIRMED', 'VOIDED')),
    received_by TEXT REFERENCES users(id),
    paid_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_payments_invoice ON payments(invoice_id, status, paid_at);

CREATE TABLE refunds (
    id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL REFERENCES payments(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    reason TEXT NOT NULL,
    refunded_by TEXT REFERENCES users(id),
    refunded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE provider_settlements (
    id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL
        CHECK (provider_type IN ('DOCTOR', 'LAB')),
    doctor_id TEXT REFERENCES doctors(id),
    provider_name TEXT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    amount_due_minor INTEGER NOT NULL CHECK (amount_due_minor >= 0),
    amount_paid_minor INTEGER NOT NULL DEFAULT 0
        CHECK (amount_paid_minor >= 0),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PARTIAL', 'PAID', 'CANCELLED')),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (period_start <= period_end),
    CHECK (amount_paid_minor <= amount_due_minor),
    CHECK (
        (provider_type = 'DOCTOR' AND doctor_id IS NOT NULL)
        OR provider_type = 'LAB'
    )
);

-- Individual payout records, separate from settlement summaries.
CREATE TABLE provider_payouts (
    id TEXT PRIMARY KEY,
    settlement_id TEXT NOT NULL REFERENCES provider_settlements(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    method TEXT NOT NULL
        CHECK (method IN ('CASH', 'BANK_TRANSFER', 'QR')),
    reference TEXT,
    paid_by TEXT REFERENCES users(id),
    paid_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cash_sessions (
    id TEXT PRIMARY KEY,
    opened_by TEXT NOT NULL REFERENCES users(id),
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    opening_float_minor INTEGER NOT NULL DEFAULT 0
        CHECK (opening_float_minor >= 0),
    closed_by TEXT REFERENCES users(id),
    closed_at TEXT,
    expected_cash_minor INTEGER,
    counted_cash_minor INTEGER,
    difference_minor INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'CLOSED')),
    CHECK (
        (status = 'OPEN' AND closed_at IS NULL)
        OR
        (status = 'CLOSED' AND closed_at IS NOT NULL
            AND counted_cash_minor IS NOT NULL
            AND expected_cash_minor IS NOT NULL
            AND difference_minor IS NOT NULL)
    )
);

CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_entity
    ON audit_logs(entity_type, entity_id, created_at);
