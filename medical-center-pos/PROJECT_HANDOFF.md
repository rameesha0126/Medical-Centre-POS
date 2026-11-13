# Medical Centre POS project handoff

Last updated: 2026-11-13, through Step 4F.38.

The current source checkout is the reference for implemented behavior. “Start POS Project” and “Continue POS Project Development” record prior decisions and user-reported tests. This update consolidates the supplied handoff and reported results; source code and database state were not independently inspected or tests rerun for this update.

## Architecture and existing workflows

The app uses React and TypeScript with an Express and TypeScript API and local SQLite. `server/src/index.ts` mounts auth, doctors, patients, schedules, appointments, lab providers, services, invoices and payments, cash sessions, and doctor sessions under `/api`.

| Area | Behavior recorded in the handoff | Source |
| --- | --- | --- |
| Doctor sessions | List by doctor/date; create sessions; assign unlinked appointments; activate, complete, and perform owner-only cancellation. Completion checks unresolved appointments and records an audit entry. | `server/src/doctor-sessions/doctor-sessions.routes.ts`; `server/src/appointments/appointments.routes.ts` |
| Billing and refunds | Create invoices, collect payments, and record refunds with manual provider allocations. Doctor fees and lab shares are stored on invoice items at billing time. Positive reductions against paid doctor settlements create separate adjustments. | `server/src/billing/invoices.routes.ts`; `server/src/billing/payments.routes.ts` |
| Lab providers | List, create, and update providers. Default provider share is 70%; the actual share is stored on each billed item. | `server/src/lab-providers/lab-providers.routes.ts`; `server/migrations/002_billing_providers.sql` |
| Settlement schema | Settlement headers, separate payouts, unique invoice-item settlement links, manual refund allocations, adjustment and recovery ledgers. Appointments link to doctor sessions; settlement headers have no direct session ID in the previously reviewed schema. | Migrations `001_initial.sql`, `005_provider_settlement_tracking.sql`, `007_provider_adjustment_recoveries.sql`, and `008_settlement_recovery_amount.sql` |
| Cash sessions | Drawer summaries and closure include patient cash payments/refunds and provider cash payouts/repayments. | `server/src/cash-sessions/cash-sessions.routes.ts`; `server/migrations/009_provider_payout_cash_session.sql` |
| Historical refunds | Migration 006 tracks explicit historical reviews. The reconciliation script encodes reviewed ECG refunds with no provider share and two lab refunds with LKR 350 provider reductions each. Applied records remain unverified for this handoff. | `server/migrations/006_historical_refund_reviews.sql`; `server/scripts/reconcile-historical-refunds.mjs` |

Doctor settlement handlers are implemented in the doctor-session router. The earlier statement that neither provider type has payout handlers is superseded. A generic `server/src/settlements/settlements.routes.ts` was absent in the earlier checkout; do not assume it exists. Lab settlement and recovery workflows remain unverified/incomplete. Completing a session changes operational status; settlement and payout records are separate.

## Confirmed business rules

- Phone, message, and walk-in bookings are supported. Each doctor has a separate queue.
- Consultations require full payment before the patient sees the doctor. Doctors earn a fixed fee per consultation and are paid at the end of a session.
- Lab providers normally receive 70%; the centre retains 30%. The centre retains all revenue from its own procedures.
- Staff choose each refund's provider impact per invoice item. Explicit zero means the centre absorbs that impact. The previously reviewed refund API requires allocation for every provider-share item on the invoice; missing allocations block settlement readiness.
- Preserve original settled amounts and payout history. Positive refund reductions against paid doctor settlements create separate auditable `PENDING` adjustments linked to the original settlement and refund allocation. The earlier blanket HTTP 409 behavior for these reductions has been superseded.
- Staff can recover adjustments through repayments, deductions from later payouts, or both. Unrecovered amounts carry forward for the same doctor. Full recovery marks the adjustment `APPLIED`; partial recovery remains `PENDING`.
- Owner and staff can perform the operational settlement workflows; settings remain owner-only.

## Doctor settlements checkpoint — 2026-11-12

Implemented through Step 4F.29. Results were reported by the user from TypeScript builds, Postman requests, and SQLite queries.

### Source files and migrations

- `server/src/doctor-sessions/doctor-sessions.routes.ts`
- `server/src/billing/payments.routes.ts`
- `server/migrations/007_provider_adjustment_recoveries.sql`
- `server/migrations/008_settlement_recovery_amount.sql`

### Implemented endpoints

All paths below are relative to `/api/doctor-sessions` and require authentication.

- `GET /:id/settlement-preview`
- `POST /:id/payouts`
- `GET /doctors/:doctorId/adjustment-balance`
- `POST /doctors/:doctorId/adjustment-repayments`
- `GET /doctors/:doctorId/adjustment-recoveries`

The payout request requires `request_key`, `method`, `reference`, and `expected_amount_minor`. Current supported methods are `CASH`, `BANK_TRANSFER`, and `QR` following Step 4F.37. Optional `deductions` identify adjustments and amounts to recover.

`expected_amount_minor` means gross entitlement being settled. Actual payment equals gross entitlement minus deductions. A fully deducted settlement returns `payout: null` and creates no positive payout row. `amount_recovered_minor` records deductions separately from `amount_paid_minor`.

Repayment and settlement request keys support exact retries. Settlement and recovery writes use SQLite transactions. Recovery events and their allocation rows support partial recovery across multiple events and sessions.

### Reported passing checks

- TypeScript builds.
- Completed-session preview and active-session rejection.
- Invalid session/doctor IDs and signed-out preview rejection.
- Explicit zero and positive refund allocations.
- Partially refunded invoices remain eligible for preview.
- Missing allocation blocks settlement readiness.
- Already-settled items are excluded from unsettled entitlement.
- Same-day sessions isolate their invoice items.
- Bank payout, stale-amount rejection, and repeat-payment rejection.
- Persisted settlement, payout, invoice-item link, and payout audit.
- Post-payout refund adjustment with original payout preserved.
- Partial bank repayment, exact retry, request-key reuse with a changed payload rejected, and excessive repayment rejected.
- Full deduction with zero actual payment and carry-forward.
- Partial deduction with a positive bank payment.
- Exact settlement retries return the same settlement/payout IDs.
- At Step 4F.29, recovery history contained three events totaling 5000 minor units, with matching event and allocation amounts. This is a historical checkpoint, not the current total after later tests.

## Cash and QR checkpoint — 2026-11-13

User-reported builds and Postman checks passed through Step 4F.37.

### Source files and migration

- `server/src/doctor-sessions/doctor-sessions.routes.ts`
- `server/src/cash-sessions/cash-sessions.routes.ts`
- `server/migrations/009_provider_payout_cash_session.sql`

Migration 009 adds `provider_payouts.cash_session_id` and indexes for payout and recovery drawer links. The disposable-copy verification found zero unlinked historical cash payouts.

### Implemented behavior and reported passing checks

- Doctor payouts and adjustment repayments support `CASH`, `BANK_TRANSFER`, and `QR`.
- Actual cash payouts and repayments require an open drawer and store its ID inside the transaction.
- Fully deducted settlements involve no cash movement and require no drawer.
- Drawer summaries and closure include cash provider repayments as inflows and cash provider payouts as outflows.
- Exact successful retries return the original records and drawer links, including after drawer closure.
- Requests rejected for a missing open drawer can succeed later using the same request key and link to the newly opened drawer.
- QR payouts and repayments have null drawer links and do not affect drawer cash.
- Tested closure reconciled at 8500 minor units (LKR 85), with zero difference.

Expected drawer cash is calculated as:

```text
opening_float_minor
+ cash_received_minor
- cash_refunded_minor
+ cash_provider_repaid_minor
- cash_provider_paid_minor
```

Payout deductions have no cash effect. Recovery cash totals sum event headers, avoiding duplicate counting across allocation rows.

## Earlier consultation workflow tests

The user reported passing booking and queueing, session activation, invoice creation, full payment, consultation start/completion, and session closure. Unresolved appointments blocked closure; closing the resolved session returned HTTP 200 with an `ACTIVE` to `COMPLETED` transition. These results were not rerun for this handoff.

## Test environment and latest recorded state

Later settlement, adjustment, recovery, cash, and QR checks ran against:

```text
D:\Medical Centre POS\server-post-payout-test\data\medical-center.sqlite
```

Disposable fixtures include completed sessions seeded directly in SQLite, bypassing scheduling and consultation workflow checks.

A test payout with reference `TEST-4F16-001` was recorded in the primary database before the later disposable-copy tests.

Migrations 007, 008, and 009 were confirmed applied in the disposable copy. Their application to the primary database remains unverified. No migration after 009 is established by this checkpoint.

Latest recorded drawer state:

| Drawer | Status | Recorded expected cash |
| --- | --- | ---: |
| `ec1cbb47-6240-45c4-ad99-2a5a3aee094d` | CLOSED; counted cash matched; zero difference | 8500 minor units |
| `dc91d144-5d62-47ba-8dc7-8df95300c190` | OPEN at the last recorded check | 8500 minor units |

An accidental second patient-refund POST created an additional 500-minor-unit refund and pending adjustment. The parent-thread checkpoint attributes the current outstanding doctor adjustment balance of 500 minor units to:

```text
595f1a1e-aca1-43d4-9661-3073e10f5535
```

This latest balance/ID is retained from the reported checkpoint, not independently queried during this handoff update. The separate QR repayment recovered adjustment `463512cd-0849-41da-b01b-78ba64156ca9`.

## Known unfinished behavior and remaining work

- Patient-refund POST requests lack request-key retry protection; repeated POSTs can create additional refunds.
- Cash payouts require an open drawer but do not check available recorded drawer cash.
- Separate daily-report integration remains unverified.
- Application of recent migrations to the primary database remains unverified.
- Doctor settlement history/details suitable for the frontend.
- Provider Settlements frontend workflows.
- Lab settlement and recovery workflows.
- Broader rejection and concurrent-request tests.

## Next task

Add request-key retry protection to patient refunds before further refund testing, then implement doctor settlement history/details for the frontend.

Inspect the current `server/src/billing/payments.routes.ts` before proposing an exact refund-route update. Preserve manual provider allocations, post-payout adjustments, drawer links, transactional writes, and existing response behavior while adding retry handling.

## Working approach

Provide manual code changes, PowerShell commands, and Postman checks step by step. The user applies changes and runs tests. Do not infer that a passing build establishes every runtime rule, and distinguish user-reported results from independently inspected source or database state.
