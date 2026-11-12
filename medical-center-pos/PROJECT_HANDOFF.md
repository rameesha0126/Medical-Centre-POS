# Medical Centre POS project handoff

Last reviewed 2026-11-09. The current checkout is the reference for implemented behavior. “Start POS Project” is the reference for prior decisions and reported tests.

## Verified in code

The app uses React and TypeScript with an Express and TypeScript API and local SQLite. The API entry point is [server/src/index.ts](server/src/index.ts). It mounts auth, doctors, patients, schedules, appointments, lab providers, services, invoices and payments, cash sessions, and doctor sessions under `/api`.

| Area | Current behavior | Source |
| --- | --- | --- |
| Doctor sessions | `GET /api/doctor-sessions` lists sessions by doctor and date. `POST /api/doctor-sessions` creates a session. `POST /api/doctor-sessions/:id/assign-unlinked` assigns unlinked appointments. `PATCH /api/doctor-sessions/:id/status` handles activation, completion, and owner-only cancellation. Completion checks for unresolved appointments and records an audit entry. | [Doctor sessions](server/src/doctor-sessions/doctor-sessions.routes.ts), [appointments](server/src/appointments/appointments.routes.ts) |
| Billing and refunds | `POST /api/invoices` creates invoices. `POST /api/invoices/:id/payments` records payment. `POST /api/invoices/:id/payments/:paymentId/refunds` records refunds and their manual provider allocations. The invoice item stores the doctor fee or lab share calculated at billing time. | [Invoices](server/src/billing/invoices.routes.ts), [payments and refunds](server/src/billing/payments.routes.ts) |
| Lab providers | The router supports listing, creating, and updating providers. The schema defaults the lab provider share to 70%, with the actual share stored on each billed item. | [Lab providers](server/src/lab-providers/lab-providers.routes.ts), [billing provider migration](server/migrations/002_billing_providers.sql) |
| Settlement schema | SQLite defines settlement headers, separate payout rows, unique invoice-item settlement links, manual allocations, and adjustment rows. Appointments link to doctor sessions. Settlement headers have no direct session ID. | [Initial schema](server/migrations/001_initial.sql), [settlement tracking](server/migrations/005_provider_settlement_tracking.sql) |
| Historical refunds | Migration 006 tracks explicit historical refund reviews. The reconciliation script encodes reviewed ECG refunds with no provider share and two lab refunds with LKR 350 provider reductions each. Applied records were not checked for this handoff. | [Historical refund reviews](server/migrations/006_historical_refund_reviews.sql), [reconciliation script](server/scripts/reconcile-historical-refunds.mjs) |

The old thread referred to a generic settlement route and an implemented lab settlement flow. In this checkout, `server/src/settlements/settlements.routes.ts` is absent and neither provider type has a registered settlement or payout handler. Completing a session changes its operational status. Settlement and payout records are separate.

## Tested in the Start POS Project thread

- The user reported passing the consultation workflow from booking and queueing through session activation, invoice creation, full payment, consultation start and completion, and session closure.
- The user reported that unresolved appointments blocked session closure and that closing the resolved session returned HTTP 200 with a transition from `ACTIVE` to `COMPLETED`.
- Those results were reported in the thread and were not rerun for this handoff. Doctor settlement preview, lab payouts, and live payout history are unverified.

## Confirmed business rules

- Phone, message, and walk-in bookings are supported. Each doctor has a separate queue. Consultations must be fully paid before the patient sees the doctor. The doctor earns a fixed fee per consultation and is paid at the end of the session.
- Lab providers normally receive 70% and the centre retains 30%. The centre retains the full amount for its own procedures.
- Staff choose the provider impact of a refund per invoice item. An explicit zero means the centre absorbs the refund. The API currently requires an allocation for every provider-share item on the invoice.
- Preserve existing payout records and the original settled amounts. A later positive provider reduction belongs in a separate auditable adjustment linked to the original settlement and refund allocation. The current API returns HTTP 409 for positive reductions on already-settled items.

## Doctor settlements checkpoint — 2026-11-12

Implemented through Step 4F.29. Results below were reported by the
user from TypeScript builds, Postman requests, and SQLite queries.

### Source files

- server/src/doctor-sessions/doctor-sessions.routes.ts
- server/src/billing/payments.routes.ts
- server/migrations/007_provider_adjustment_recoveries.sql
- server/migrations/008_settlement_recovery_amount.sql

### Implemented endpoints

All paths below are relative to /api/doctor-sessions and require
authentication.

- GET /:id/settlement-preview
- POST /:id/payouts
- GET /doctors/:doctorId/adjustment-balance
- POST /doctors/:doctorId/adjustment-repayments
- GET /doctors/:doctorId/adjustment-recoveries

The payout request requires request_key, method BANK_TRANSFER,
reference, and expected_amount_minor. Optional deductions identify
adjustments and the amounts to recover.

expected_amount_minor means gross entitlement being settled.
Actual payment equals gross entitlement minus deductions.
A settlement fully covered by deductions returns payout: null.

### Confirmed rules

- Staff manually allocate each refund's provider impact per invoice
  item. An explicit zero means the centre absorbs that impact.
- Missing provider allocations block settlement readiness.
- Refunds against fully paid doctor settlements create separate
  PENDING adjustments for positive provider reductions.
- Original settled amounts and payout history are preserved.
- Staff can recover adjustments through separate repayments,
  deductions from later settlements, or a combination.
- Partial recovery carries the remaining balance forward for the
  same doctor. Full recovery marks the adjustment APPLIED.
- Repayment and settlement request keys support exact retries.
- Settlement and recovery writes use SQLite transactions.

### Reported passing checks

- TypeScript builds.
- Completed-session preview and active-session rejection.
- Invalid session/doctor IDs and signed-out preview rejection.
- Explicit zero and positive refund allocations.
- Partially refunded invoices remain eligible for preview.
- Missing allocation blocks payout readiness.
- Already-settled items are excluded from unsettled entitlement.
- Same-day sessions isolate their invoice items.
- Bank payout, stale-amount rejection, and repeat-payment rejection.
- Persisted settlement, payout, item link, and payout audit.
- Post-payout refund adjustment with original payout preserved.
- Partial bank repayment, exact retry, changed-key-payload rejection,
  and excessive repayment rejection.
- Full deduction with zero actual payment and carry-forward.
- Partial deduction with a positive bank payment.
- Exact settlement retries return the same settlement/payout IDs.
- Recovery history contains three events totaling 5000 minor units,
  with matching event and allocation amounts.

### Test environment

Later adjustment and recovery checks ran against:
D:\Medical Centre POS\server-post-payout-test\data\medical-center.sqlite

Disposable fixtures include completed sessions seeded directly
in SQLite. They bypass scheduling and consultation workflow checks.

A test payout with reference TEST-4F16-001 was recorded in the
primary project database before the later disposable-copy tests.

Applied migrations 007 and 008 were confirmed in the disposable
copy. Their application to the primary database remains unverified.

### Remaining work

- Cash and QR doctor payouts and repayments.
- Cash drawer and report integration for provider money movements.
- Settlement history/details suitable for the frontend.
- Provider Settlements frontend workflows.
- Lab settlement and recovery workflows.
- Broader rejection and concurrent-request tests.

## Next task

Inspect the current cash-session routes, provider payout schema,
and cash-report calculations before adding cash doctor payouts.
Account for outgoing payouts and incoming doctor repayments in
drawer totals and daily reports.