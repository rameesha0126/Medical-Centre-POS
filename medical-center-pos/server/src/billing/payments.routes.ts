
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth } from "../auth/auth.routes.js";

const router = Router();

const createPaymentSchema = z.object({
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  method: z.enum(["CASH", "BANK_TRANSFER", "QR"]),
  reference: z.string().trim().max(100).nullable().optional(),
});

const createRefundSchema = z.object({
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(500),
  refund_method: z.enum(["CASH", "BANK_TRANSFER", "QR"]),
  provider_allocations: z.array(z.object({
    invoice_item_id: z.string().uuid(),
    provider_reduction_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })).max(100),
});

type User = {
  id: string;
  role: "OWNER" | "STAFF";
};

type InvoiceRow = {
  id: string;
  invoice_number: string;
  total_minor: number;
  status: string;
};

type BalanceRow = {
  total_paid_minor: number;
  total_refunded_minor: number;
};

function getInvoiceBalance(invoiceId: string) {
  const invoice = db.prepare(`
    SELECT
      i.id,
      i.invoice_number,
      i.total_minor,
      i.status
    FROM invoices i
    WHERE i.id = ?
  `).get(invoiceId) as InvoiceRow | undefined;

  if (!invoice) return null;

  const totals = db.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(p.amount_minor)
        FROM payments p
        WHERE p.invoice_id = ?
          AND p.status = 'CONFIRMED'
      ), 0) AS total_paid_minor,
      COALESCE((
        SELECT SUM(r.amount_minor)
        FROM refunds r
        INNER JOIN payments p ON p.id = r.payment_id
        WHERE p.invoice_id = ?
          AND p.status = 'CONFIRMED'
      ), 0) AS total_refunded_minor
  `).get(invoiceId, invoiceId) as BalanceRow;

  const paidMinor =
    totals.total_paid_minor - totals.total_refunded_minor;

  const outstandingMinor =
    Math.max(0, invoice.total_minor - paidMinor);

  return {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    invoice_status: invoice.status,
    total_minor: invoice.total_minor,
    total_paid_minor: paidMinor,
    total_refunded_minor: totals.total_refunded_minor,
    outstanding_minor: outstandingMinor,
  };
}

// POST /api/invoices/:id/payments
// Record a full or partial payment.
router.post("/:id/payments", requireAuth, (req, res) => {
  const invoiceId = req.params.id;

  if (
    typeof invoiceId !== "string" ||
    !z.string().uuid().safeParse(invoiceId).success
  ) {
    res.status(400).json({ error: "Invalid invoice ID." });
    return;
  }

  const parsed = createPaymentSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid payment details.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;
  const user = res.locals.user as User;
  const paymentId = randomUUID();

  try {
    const recordPayment = db.transaction(() => {
      const invoice = db.prepare(`
        SELECT id, invoice_number, total_minor, status
        FROM invoices
        WHERE id = ?
      `).get(invoiceId) as InvoiceRow | undefined;

      if (!invoice) {
        return {
          success: false as const,
          status: 404,
          error: "Invoice not found.",
        };
      }

      if (invoice.status === "CANCELLED") {
        return {
          success: false as const,
          status: 409,
          error: "Payments cannot be recorded against a cancelled invoice.",
        };
      }

      if (invoice.status === "REFUNDED") {
        return {
          success: false as const,
          status: 409,
          error: "This invoice has been fully refunded.",
        };
      }

      if (invoice.status !== "OPEN") {
        return {
          success: false as const,
          status: 409,
          error: "This invoice is not open for payment.",
        };
      }

      const totals = db.prepare(`
        SELECT
          COALESCE((
            SELECT SUM(p.amount_minor)
            FROM payments p
            WHERE p.invoice_id = ?
              AND p.status = 'CONFIRMED'
          ), 0) AS total_paid_minor,
          COALESCE((
            SELECT SUM(r.amount_minor)
            FROM refunds r
            INNER JOIN payments p ON p.id = r.payment_id
            WHERE p.invoice_id = ?
              AND p.status = 'CONFIRMED'
          ), 0) AS total_refunded_minor
      `).get(invoiceId, invoiceId) as BalanceRow;

      const netPaid =
        totals.total_paid_minor - totals.total_refunded_minor;

      const outstanding = invoice.total_minor - netPaid;

      if (outstanding <= 0) {
        return {
          success: false as const,
          status: 409,
          error: "This invoice has already been fully paid.",
        };
      }

      if (data.amount_minor > outstanding) {
        return {
          success: false as const,
          status: 400,
          error: "Payment exceeds the outstanding balance.",
          outstanding_minor: outstanding,
        };
      }

      let cashSessionId: string | null = null;

      if (data.method === "CASH") {
        const cashSession = db.prepare(`
          SELECT id
          FROM cash_sessions
          WHERE status = 'OPEN'
          LIMIT 1
        `).get() as { id: string } | undefined;

        if (!cashSession) {
          return {
            success: false as const,
            status: 409,
            error: "A cash session must be open before accepting cash payments.",
          };
        }

        cashSessionId = cashSession.id;
      }

      db.prepare(`
        INSERT INTO payments (
          id,
          invoice_id,
          amount_minor,
          method,
          reference,
          status,
          received_by,
          paid_at,
          cash_session_id
        )
        VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, datetime('now'), ?)
      `).run(
        paymentId,
        invoiceId,
        data.amount_minor,
        data.method,
        data.reference?.trim() || null,
        user.id,
        cashSessionId,
      );

      const newPaid = netPaid + data.amount_minor;
      const newOutstanding = invoice.total_minor - newPaid;
      const newStatus = newOutstanding === 0 ? "PAID" : "OPEN";

      db.prepare(`
        UPDATE invoices
        SET status = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(newStatus, invoiceId);

      db.prepare(`
        INSERT INTO audit_logs (
          user_id,
          action,
          entity_type,
          entity_id,
          details_json
        )
        VALUES (?, 'CREATE', 'PAYMENT', ?, ?)
      `).run(
        user.id,
        paymentId,
        JSON.stringify({
          invoice_id: invoiceId,
          invoice_number: invoice.invoice_number,
          amount_minor: data.amount_minor,
          method: data.method,
          cash_session_id: cashSessionId,
          reference: data.reference?.trim() || null,
          outstanding_minor: newOutstanding,
          invoice_status: newStatus,
        }),
      );

      return {
        success: true as const,
        cashSessionId,
        invoice_status: newStatus,
        total_paid_minor: newPaid,
        outstanding_minor: newOutstanding,
      };
    });

    const result = recordPayment.immediate();

    if (!result.success) {
      res.status(result.status).json({
        error: result.error,
        ...("outstanding_minor" in result
          ? { outstanding_minor: result.outstanding_minor }
          : {}),
      });
      return;
    }

    const balance = getInvoiceBalance(invoiceId);

    res.status(201).json({
      message: "Payment recorded successfully.",
      payment: {
        id: paymentId,
        invoice_id: invoiceId,
        amount_minor: data.amount_minor,
        method: data.method,
        cash_session_id: result.cashSessionId,
        reference: data.reference?.trim() || null,
        status: "CONFIRMED",
        received_by: user.id,
      },
      balance,
    });
  } catch (error) {
    console.error("Payment recording failed:", error);
    res.status(500).json({
      error: "Could not record payment.",
    });
  }
});

// GET /api/invoices/:id/payments
// Retrieve payment history and current outstanding balance.
router.get("/:id/payments", requireAuth, (req, res) => {
  const invoiceId = req.params.id;

  if (
    typeof invoiceId !== "string" ||
    !z.string().uuid().safeParse(invoiceId).success
  ) {
    res.status(400).json({ error: "Invalid invoice ID." });
    return;
  }

  const balance = getInvoiceBalance(invoiceId);

  if (!balance) {
    res.status(404).json({ error: "Invoice not found." });
    return;
  }

  const payments = db.prepare(`
    SELECT
      p.id,
      p.amount_minor,
      p.method,
      p.cash_session_id,
      p.reference,
      p.status,
      p.received_by,
      u.display_name AS received_by_name,
      p.paid_at,
      p.created_at,
      COALESCE((
        SELECT SUM(r.amount_minor)
        FROM refunds r
        WHERE r.payment_id = p.id
      ), 0) AS refunded_minor
    FROM payments p
    LEFT JOIN users u ON u.id = p.received_by
    WHERE p.invoice_id = ?
    ORDER BY p.paid_at, p.created_at
  `).all(invoiceId);

  res.json({
    balance,
    payments,
  });
});

// POST /api/invoices/:id/payments/:paymentId/refunds
// Record a full or partial refund against an original payment.
router.post(
  "/:id/payments/:paymentId/refunds",
  requireAuth,
  (req, res) => {
    const invoiceId = req.params.id;
    const paymentId = req.params.paymentId;

    if (
      typeof invoiceId !== "string" ||
      !z.string().uuid().safeParse(invoiceId).success
    ) {
      res.status(400).json({ error: "Invalid invoice ID." });
      return;
    }

    if (
      typeof paymentId !== "string" ||
      !z.string().uuid().safeParse(paymentId).success
    ) {
      res.status(400).json({ error: "Invalid payment ID." });
      return;
    }

    const parsed = createRefundSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid refund details.",
        details: parsed.error.flatten(),
      });
      return;
    }

    const data = parsed.data;
    const user = res.locals.user as User;
    const refundId = randomUUID();

    try {
      const recordRefund = db.transaction(() => {
        const invoice = db.prepare(`
          SELECT id, invoice_number, total_minor, status
          FROM invoices
          WHERE id = ?
        `).get(invoiceId) as InvoiceRow | undefined;

        if (!invoice) {
          return {
            success: false as const,
            status: 404,
            error: "Invoice not found.",
          };
        }

        if (invoice.status === "CANCELLED") {
          return {
            success: false as const,
            status: 409,
            error: "Refunds cannot be recorded against a cancelled invoice.",
          };
        }

        if (invoice.status === "REFUNDED") {
          return {
            success: false as const,
            status: 409,
            error: "This invoice has already been fully refunded.",
          };
        }

        const payment = db.prepare(`
          SELECT id, invoice_id, amount_minor, status
          FROM payments
          WHERE id = ?
            AND invoice_id = ?
        `).get(paymentId, invoiceId) as {
          id: string;
          invoice_id: string;
          amount_minor: number;
          status: string;
        } | undefined;

        if (!payment) {
          return {
            success: false as const,
            status: 404,
            error: "Payment not found for this invoice.",
          };
        }

        if (payment.status !== "CONFIRMED") {
          return {
            success: false as const,
            status: 409,
            error: "Only confirmed payments can be refunded.",
          };
        }

        const refundTotals = db.prepare(`
          SELECT COALESCE(SUM(amount_minor), 0) AS refunded_minor
          FROM refunds
          WHERE payment_id = ?
        `).get(paymentId) as { refunded_minor: number };

        const refundableMinor =
          payment.amount_minor - refundTotals.refunded_minor;

        if (refundableMinor <= 0) {
          return {
            success: false as const,
            status: 409,
            error: "This payment has already been fully refunded.",
          };
        }

        if (data.amount_minor > refundableMinor) {
          return {
            success: false as const,
            status: 400,
            error: "Refund exceeds the remaining refundable amount.",
            refundable_minor: refundableMinor,
          };
        }

        // Validate manual provider reductions before recording the refund.
        const invoiceItems = db.prepare(`
          SELECT id, provider_share_minor
          FROM invoice_items
          WHERE invoice_id = ?
        `).all(invoiceId) as Array<{ id: string; provider_share_minor: number }>;

        const itemMap = new Map(invoiceItems.map(item => [item.id, item]));
        const allocationIds = data.provider_allocations.map(a => a.invoice_item_id);
        if (new Set(allocationIds).size !== allocationIds.length) {
          return { success: false as const, status: 400,
            error: "Duplicate invoice items in provider allocations." };
        }

        const providerItems = invoiceItems.filter(item => item.provider_share_minor > 0);
        const suppliedIds = new Set(allocationIds);
        if (providerItems.some(item => !suppliedIds.has(item.id))) {
          return { success: false as const, status: 400,
            error: "An explicit allocation (including zero) is required for every provider-share item." };
        }

        const paidDoctorSettlementsByItem = new Map<string, string>();

        let totalProviderReduction = 0;
        for (const allocation of data.provider_allocations) {
          const item = itemMap.get(allocation.invoice_item_id);
          if (!item) {
            return { success: false as const, status: 400,
              error: "Provider allocation references an item outside this invoice." };
          }
          if (item.provider_share_minor === 0) {
            return { success: false as const, status: 400,
              error: "Provider allocations are only allowed for items with a provider share." };
          }
          const prior = db.prepare(`
            SELECT COALESCE(SUM(a.provider_reduction_minor), 0) AS reduced_minor
            FROM refund_provider_allocations a
            JOIN refunds r ON r.id = a.refund_id
            JOIN payments p ON p.id = r.payment_id
            WHERE a.invoice_item_id = ? AND p.status = 'CONFIRMED'
          `).get(item.id) as { reduced_minor: number };
          if (allocation.provider_reduction_minor > item.provider_share_minor - prior.reduced_minor) {
            return { success: false as const, status: 400,
              error: "Provider reduction exceeds the remaining provider entitlement." };
          }
          if (allocation.provider_reduction_minor > 0) {
            const linkedSettlement = db.prepare(`
              SELECT ps.id, ps.provider_type, ps.status
              FROM provider_settlement_items psi
              JOIN provider_settlements ps ON ps.id = psi.settlement_id
              WHERE psi.invoice_item_id = ?
            `).get(item.id) as {
              id: string;
              provider_type: string;
              status: string;
            } | undefined;

            if (linkedSettlement) {
              if (
                linkedSettlement.provider_type !== "DOCTOR" ||
                linkedSettlement.status !== "PAID"
              ) {
                return {
                  success: false as const,
                  status: 409,
                  error: "Provider-share adjustments for this settlement are not enabled yet.",
                };
              }

              paidDoctorSettlementsByItem.set(item.id, linkedSettlement.id);
            }
          }
          totalProviderReduction += allocation.provider_reduction_minor;
        }
        if (!Number.isSafeInteger(totalProviderReduction) || totalProviderReduction > data.amount_minor) {
          return { success: false as const, status: 400,
            error: "Total provider reduction cannot exceed the refund amount." };
        }

        let cashSessionId: string | null = null;

        if (data.refund_method === "CASH") {
          const cashSession = db.prepare(`
            SELECT id
            FROM cash_sessions
            WHERE status = 'OPEN'
            LIMIT 1
          `).get() as { id: string } | undefined;

          if (!cashSession) {
            return {
              success: false as const,
              status: 409,
              error: "A cash session must be open before issuing cash refunds.",
            };
          }

          cashSessionId = cashSession.id;
        }

        db.prepare(`
          INSERT INTO refunds (
            id,
            payment_id,
            amount_minor,
            reason,
            refunded_by,
            refund_method,
            cash_session_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          refundId,
          paymentId,
          data.amount_minor,
          data.reason,
          user.id,
          data.refund_method,
          cashSessionId,
        );

        const insertAllocation = db.prepare(`
          INSERT INTO refund_provider_allocations (
            id, refund_id, invoice_item_id, provider_reduction_minor, created_by
          ) VALUES (?, ?, ?, ?, ?)
        `);
        const insertAdjustment = db.prepare(`
          INSERT INTO provider_settlement_adjustments (
            id,
            settlement_id,
            refund_provider_allocation_id,
            adjustment_minor,
            status,
            created_by
          )
          VALUES (?, ?, ?, ?, 'PENDING', ?)
        `);

        for (const allocation of data.provider_allocations) {
          const allocationId = randomUUID();

          insertAllocation.run(
            allocationId,
            refundId,
            allocation.invoice_item_id,
            allocation.provider_reduction_minor,
            user.id,
          );

          const settlementId = paidDoctorSettlementsByItem.get(
            allocation.invoice_item_id,
          );

          if (settlementId) {
            insertAdjustment.run(
              randomUUID(),
              settlementId,
              allocationId,
              allocation.provider_reduction_minor,
              user.id,
            );
          }
        }

        const totals = db.prepare(`
          SELECT
            COALESCE((
              SELECT SUM(p.amount_minor)
              FROM payments p
              WHERE p.invoice_id = ?
                AND p.status = 'CONFIRMED'
            ), 0) AS total_paid_minor,
            COALESCE((
              SELECT SUM(r.amount_minor)
              FROM refunds r
              INNER JOIN payments p ON p.id = r.payment_id
              WHERE p.invoice_id = ?
                AND p.status = 'CONFIRMED'
            ), 0) AS total_refunded_minor
        `).get(invoiceId, invoiceId) as BalanceRow;

        const netPaid =
          totals.total_paid_minor - totals.total_refunded_minor;

        const outstanding =
          Math.max(0, invoice.total_minor - netPaid);

        // The invoice is fully refunded only when refunds equal
        // the invoice's entire original value.
        const newStatus =
          totals.total_refunded_minor >= invoice.total_minor
            ? "REFUNDED"
            : netPaid >= invoice.total_minor
              ? "PAID"
              : "OPEN";

        db.prepare(`
          UPDATE invoices
          SET status = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(newStatus, invoiceId);

        db.prepare(`
          INSERT INTO audit_logs (
            user_id,
            action,
            entity_type,
            entity_id,
            details_json
          )
          VALUES (?, 'CREATE', 'REFUND', ?, ?)
        `).run(
          user.id,
          refundId,
          JSON.stringify({
            invoice_id: invoiceId,
            invoice_number: invoice.invoice_number,
            payment_id: paymentId,
            amount_minor: data.amount_minor,
            reason: data.reason,
            refund_method: data.refund_method,
            cash_session_id: cashSessionId,
            provider_allocations: data.provider_allocations,
            total_provider_reduction_minor: totalProviderReduction,
            remaining_refundable_minor:
              refundableMinor - data.amount_minor,
            total_refunded_minor: totals.total_refunded_minor,
            outstanding_minor: outstanding,
            invoice_status: newStatus,
          }),
        );

        return {
          success: true as const,
          cashSessionId,
          remaining_refundable_minor:
            refundableMinor - data.amount_minor,
          invoice_status: newStatus,
          total_paid_minor: netPaid,
          total_refunded_minor: totals.total_refunded_minor,
          outstanding_minor: outstanding,
        };
      });

      const result = recordRefund.immediate();

      if (!result.success) {
        res.status(result.status).json({
          error: result.error,
          ...("refundable_minor" in result
            ? { refundable_minor: result.refundable_minor }
            : {}),
        });
        return;
      }

      const balance = getInvoiceBalance(invoiceId);

      res.status(201).json({
        message: "Refund recorded successfully.",
        refund: {
          id: refundId,
          payment_id: paymentId,
          invoice_id: invoiceId,
          amount_minor: data.amount_minor,
          reason: data.reason,
          refund_method: data.refund_method,
          cash_session_id: result.cashSessionId,
          refunded_by: user.id,
          provider_allocations: data.provider_allocations,
        },
        remaining_refundable_minor:
          result.remaining_refundable_minor,
        balance,
      });
    } catch (error) {
      console.error("Refund recording failed:", error);
      res.status(500).json({
        error: "Could not record refund.",
      });
    }
  },
);

export default router;
