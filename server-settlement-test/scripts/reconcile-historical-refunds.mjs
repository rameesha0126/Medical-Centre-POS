
/**
 * One-time audited reconciliation of 6 historical refunds.
 *
 * Place in server/scripts and run FROM the server directory:
 *
 *   node scripts/reconcile-historical-refunds.mjs
 *      # Read-only preview
 *
 *   node scripts/reconcile-historical-refunds.mjs --apply
 *      # Backup + atomic write
 *
 * Prerequisites:
 * - Migration 006 applied
 * - SQLite database at server/data/medical-center.sqlite
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const DB_PATH = path.join(
  ROOT,
  "data",
  "medical-center.sqlite"
);

const APPLY = process.argv.includes("--apply");

// Existing owner account (WMC-Admin)
const ACTOR_ID = "cfce5244-e975-4304-9a67-2cf2402ae328";

// Explicitly confirmed historical refund decisions.
// Never automatically apportion a historical refund.

const reviews = [
  {
    refundId: "508e6b5d-218a-4b2d-9e47-3c2ba0eaf57e",
    invoiceId: "e580f5f1-9549-46d2-84a5-b5f31ec7d3cd",
    amount: 40000,
    itemId: "77f79aaa-a319-49c5-9846-aa9a7107167e",
    reduction: 0,
    kind: "NO_PROVIDER_SHARE",
    note: "Historical ECG test refund reviewed; invoice item has no external provider entitlement."
  },
  {
    refundId: "e5ac5e72-bad3-4a6b-a6f4-5e4dca5ea579",
    invoiceId: "e580f5f1-9549-46d2-84a5-b5f31ec7d3cd",
    amount: 60000,
    itemId: "77f79aaa-a319-49c5-9846-aa9a7107167e",
    reduction: 0,
    kind: "NO_PROVIDER_SHARE",
    note: "Historical ECG test refund reviewed; invoice item has no external provider entitlement."
  },
  {
    refundId: "2fec9397-745a-4708-9a66-621cd201b1e3",
    invoiceId: "e580f5f1-9549-46d2-84a5-b5f31ec7d3cd",
    amount: 150000,
    itemId: "77f79aaa-a319-49c5-9846-aa9a7107167e",
    reduction: 0,
    kind: "NO_PROVIDER_SHARE",
    note: "Historical ECG test refund reviewed; invoice item has no external provider entitlement."
  },
  {
    refundId: "e4f66d8a-5b30-42f5-ab20-a020827994af",
    invoiceId: "00a62911-f148-45dc-92dc-558fa15e8aa8",
    amount: 50000,
    itemId: "81ca6daf-3fe8-47ef-a6f8-e0ec745448c9",
    reduction: 35000,
    kind: "MANUAL_PROVIDER_ALLOCATION",
    note: "Owner-confirmed historical Full Blood Count cash refund: lab entitlement reduced by LKR 350."
  },
  {
    refundId: "9ed6eb3f-0c3c-402e-b47d-cd6d417adbf5",
    invoiceId: "15af2213-ed10-4e47-95f7-7e39ce61fad5",
    amount: 50000,
    itemId: "756897f8-106f-45d4-9f7f-752a7284f68a",
    reduction: 35000,
    kind: "MANUAL_PROVIDER_ALLOCATION",
    note: "Owner-confirmed historical Full Blood Count bank refund: lab entitlement reduced by LKR 350."
  },
  {
    refundId: "d73c29a4-fee1-45b4-83a0-8df72f66cfb2",
    invoiceId: "51607e95-a679-4bfd-ba6a-37060d4e4d0c",
    amount: 20000,
    itemId: "55cf550a-2d4c-4e0a-a03e-51477776b789",
    reduction: 0,
    kind: "NO_PROVIDER_SHARE",
    note: "Historical ECG test refund reviewed; invoice item has no external provider entitlement."
  }
];

if (!fs.existsSync(DB_PATH)) {
  throw new Error(
    `Database not found: ${DB_PATH}. Run from server directory.`
  );
}

const db = new Database(DB_PATH, {
  readonly: !APPLY,
  fileMustExist: true
});

function validate() {
  const table = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'historical_refund_reviews'
  `).get();

  if (!table) {
    throw new Error(
      "Migration 006 is not applied. Run npm run db:migrate first."
    );
  }

  const actor = db.prepare(`
    SELECT id, role
    FROM users
    WHERE id = ?
  `).get(ACTOR_ID);

  if (!actor || actor.role !== "OWNER") {
    throw new Error(
      "Expected owner account missing or not OWNER; refusing reconciliation."
    );
  }

  const checkedReductions = new Map();

  for (const r of reviews) {
    const row = db.prepare(`
      SELECT
        r.id,
        r.amount_minor,
        p.invoice_id,

        (
          SELECT COUNT(*)
          FROM invoice_items
          WHERE invoice_id = p.invoice_id
        ) AS item_count,

        ii.id AS invoice_item_id,
        ii.provider_share_minor,
        ii.description,
        ii.doctor_id,
        ii.lab_provider_id

      FROM refunds r

      JOIN payments p
        ON p.id = r.payment_id

      JOIN invoice_items ii
        ON ii.invoice_id = p.invoice_id
       AND ii.id = ?

      WHERE r.id = ?
    `).get(r.itemId, r.refundId);

    if (
      !row ||
      row.invoice_id !== r.invoiceId ||
      row.amount_minor !== r.amount ||
      row.item_count !== 1
    ) {
      throw new Error(
        `Historical refund data changed, item mismatch, or multi-item invoice: ${r.refundId}`
      );
    }

    const existingReview = db.prepare(`
      SELECT 1
      FROM historical_refund_reviews
      WHERE refund_id = ?
    `).get(r.refundId);

    if (existingReview) {
      throw new Error(
        `Already reviewed; no changes made: ${r.refundId}`
      );
    }

    const existingAllocation = db.prepare(`
      SELECT 1
      FROM refund_provider_allocations
      WHERE refund_id = ?
    `).get(r.refundId);

    if (existingAllocation) {
      throw new Error(
        `Already allocated; refusing duplicate: ${r.refundId}`
      );
    }

    const existingSettlement = db.prepare(`
      SELECT 1
      FROM provider_settlement_items
      WHERE invoice_item_id = ?
    `).get(r.itemId);

    if (existingSettlement) {
      throw new Error(
        `Invoice item already settled; manual accounting review required: ${r.itemId}`
      );
    }

    if (
      r.kind === "NO_PROVIDER_SHARE" &&
      (
        row.provider_share_minor !== 0 ||
        r.reduction !== 0
      )
    ) {
      throw new Error(
        `ECG no-provider-share assumption failed: ${r.refundId}`
      );
    }

    if (
      r.kind === "MANUAL_PROVIDER_ALLOCATION" &&
      (
        row.provider_share_minor <= 0 ||
        !row.lab_provider_id ||
        r.reduction <= 0 ||
        r.reduction > r.amount
      )
    ) {
      throw new Error(
        `Lab provider allocation assumption failed: ${r.refundId}`
      );
    }

    const used = db.prepare(`
      SELECT
        COALESCE(
          SUM(provider_reduction_minor),
          0
        ) AS used
      FROM refund_provider_allocations
      WHERE invoice_item_id = ?
    `).get(r.itemId).used;

    const pending =
      checkedReductions.get(r.itemId) ?? 0;

    if (
      used + pending + r.reduction >
      row.provider_share_minor
    ) {
      throw new Error(
        `Reduction exceeds provider entitlement for: ${r.itemId}`
      );
    }

    checkedReductions.set(
      r.itemId,
      pending + r.reduction
    );

    console.log(
      `${r.kind.padEnd(27)} ` +
      `${r.refundId} ` +
      `${row.description.padEnd(20)} ` +
      `refund=${r.amount} ` +
      `provider_reduction=${r.reduction}`
    );
  }

  console.log(
    `Validated ${reviews.length} refunds; ` +
    `provider reduction total: ` +
    `${reviews.reduce((s, r) => s + r.reduction, 0)} minor units.`
  );
}

try {
  validate();

  if (!APPLY) {
    console.log(
      "DRY RUN ONLY: No records changed. To write, run with --apply."
    );
  } else {
    const backupDir = path.join(
      ROOT,
      "data",
      "backups"
    );

    fs.mkdirSync(backupDir, {
      recursive: true
    });

    const backupPath = path.join(
      backupDir,
      `medical-center-before-refund-reconciliation-${
        new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
      }.sqlite`
    );

    await db.backup(backupPath);

    console.log(
      `Database backup created: ${backupPath}`
    );

    const apply = db.transaction(() => {
      // Revalidate after backup and inside the transaction.
      validate();

      for (const r of reviews) {
        if (
          r.kind === "MANUAL_PROVIDER_ALLOCATION"
        ) {
          db.prepare(`
            INSERT INTO refund_provider_allocations (
              id,
              refund_id,
              invoice_item_id,
              provider_reduction_minor,
              created_by
            )
            VALUES (?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            r.refundId,
            r.itemId,
            r.reduction,
            ACTOR_ID
          );
        }

        db.prepare(`
          INSERT INTO historical_refund_reviews (
            refund_id,
            review_kind,
            review_note,
            reviewed_by
          )
          VALUES (?, ?, ?, ?)
        `).run(
          r.refundId,
          r.kind,
          r.note,
          ACTOR_ID
        );

        db.prepare(`
          INSERT INTO audit_logs (
            user_id,
            action,
            entity_type,
            entity_id,
            details_json
          )
          VALUES (
            ?,
            'RECONCILE',
            'REFUND',
            ?,
            ?
          )
        `).run(
          ACTOR_ID,
          r.refundId,
          JSON.stringify({
            reconciliation:
              "historical_refund_2026_11",
            invoice_id: r.invoiceId,
            invoice_item_id: r.itemId,
            refund_minor: r.amount,
            provider_reduction_minor:
              r.reduction,
            review_kind: r.kind,
            note: r.note
          })
        );
      }
    });

    apply.immediate();

    const reviewed = db.prepare(`
      SELECT COUNT(*) AS n
      FROM historical_refund_reviews
      WHERE refund_id IN (
        ${reviews.map(() => "?").join(",")}
      )
    `).get(
      ...reviews.map(r => r.refundId)
    ).n;

    if (reviewed !== 6) {
      throw new Error(
        `Post-write verification failed: ${reviewed}/6 reviewed`
      );
    }

    console.log(
      "SUCCESS: 6 review records, " +
      "2 provider allocation records, " +
      "6 audit logs written atomically."
    );
  }
} finally {
  db.close();
}
