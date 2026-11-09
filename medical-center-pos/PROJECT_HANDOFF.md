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

## Next task

Implement an authenticated, read-only `GET /api/doctor-sessions/:id/settlement-preview` for completed sessions in the existing doctor-session router.

1. Follow the exact session ID through completed appointments to their consultation invoice items. Show each stored doctor fee, the sum of explicit provider reductions, and the resulting entitlement.
2. Show already-linked items separately and exclude them from the amount available to settle. Flag unlinked appointments for the same doctor and date and historical refunds with unresolved provider impact. Treat those review flags as blockers for payout readiness.
3. Verify with disposable data covering no refund, explicit zero, positive reduction, a previously settled item, an unresolved historical refund, an active session, and another session for the same doctor on the same day.

After each milestone, update the code references, record the checks actually run, and replace the next task with the next unfinished step.
