import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth } from "../auth/auth.routes.js";
const router = Router();
const openSessionSchema = z.object({
    opening_float_minor: z.number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .default(0),
});
const closeSessionSchema = z.object({
    counted_cash_minor: z.number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
});
function getSession(sessionId) {
    return db.prepare(`
    SELECT
      cs.*,
      opener.display_name AS opened_by_name,
      closer.display_name AS closed_by_name
    FROM cash_sessions cs
    LEFT JOIN users opener ON opener.id = cs.opened_by
    LEFT JOIN users closer ON closer.id = cs.closed_by
    WHERE cs.id = ?
  `).get(sessionId);
}
function getCashTotals(sessionId) {
    return db.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(amount_minor)
        FROM payments
        WHERE cash_session_id = ?
          AND method = 'CASH'
          AND status = 'CONFIRMED'
      ), 0) AS cash_received_minor,

      COALESCE((
        SELECT SUM(amount_minor)
        FROM refunds
        WHERE cash_session_id = ?
          AND refund_method = 'CASH'
      ), 0) AS cash_refunded_minor
  `).get(sessionId, sessionId);
}
function getSessionSummary(sessionId) {
    const session = getSession(sessionId);
    if (!session)
        return null;
    const totals = getCashTotals(sessionId);
    const expectedCash = session.opening_float_minor +
        totals.cash_received_minor -
        totals.cash_refunded_minor;
    return {
        session,
        summary: {
            opening_float_minor: session.opening_float_minor,
            cash_received_minor: totals.cash_received_minor,
            cash_refunded_minor: totals.cash_refunded_minor,
            expected_cash_minor: expectedCash,
            counted_cash_minor: session.counted_cash_minor,
            difference_minor: session.difference_minor,
        },
    };
}
// POST /api/cash-sessions
// Open the shared cash drawer.
router.post("/", requireAuth, (req, res) => {
    const parsed = openSessionSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid cash session details.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const user = res.locals.user;
    const sessionId = randomUUID();
    try {
        const openSession = db.transaction(() => {
            const existing = db.prepare(`
        SELECT id
        FROM cash_sessions
        WHERE status = 'OPEN'
        LIMIT 1
      `).get();
            if (existing) {
                return {
                    success: false,
                    status: 409,
                    error: "A cash session is already open.",
                    existing_session_id: existing.id,
                };
            }
            db.prepare(`
        INSERT INTO cash_sessions (
          id,
          opened_by,
          opening_float_minor,
          status
        )
        VALUES (?, ?, ?, 'OPEN')
      `).run(sessionId, user.id, parsed.data.opening_float_minor);
            db.prepare(`
        INSERT INTO audit_logs (
          user_id,
          action,
          entity_type,
          entity_id,
          details_json
        )
        VALUES (?, 'CREATE', 'CASH_SESSION', ?, ?)
      `).run(user.id, sessionId, JSON.stringify({
                opening_float_minor: parsed.data.opening_float_minor,
            }));
            return { success: true };
        });
        const result = openSession.immediate();
        if (!result.success) {
            res.status(result.status).json({
                error: result.error,
                existing_session_id: result.existing_session_id,
            });
            return;
        }
        res.status(201).json({
            message: "Cash session opened successfully.",
            cash_session: getSession(sessionId),
        });
    }
    catch (error) {
        console.error("Opening cash session failed:", error);
        res.status(500).json({
            error: "Could not open cash session.",
        });
    }
});
// GET /api/cash-sessions/current
// Retrieve the currently open shared cash session.
router.get("/current", requireAuth, (_req, res) => {
    try {
        const session = db.prepare(`
      SELECT
        cs.*,
        opener.display_name AS opened_by_name,
        closer.display_name AS closed_by_name
      FROM cash_sessions cs
      LEFT JOIN users opener ON opener.id = cs.opened_by
      LEFT JOIN users closer ON closer.id = cs.closed_by
      WHERE cs.status = 'OPEN'
      LIMIT 1
    `).get();
        if (!session) {
            res.json({
                cash_session: null,
                message: "There is no open cash session.",
            });
            return;
        }
        const result = getSessionSummary(session.id);
        res.json(result);
    }
    catch (error) {
        console.error("Getting current cash session failed:", error);
        res.status(500).json({
            error: "Could not retrieve current cash session.",
        });
    }
});
// GET /api/cash-sessions/:id/summary
// Retrieve cash totals for an open or closed session.
router.get("/:id/summary", requireAuth, (req, res) => {
    const sessionId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
    if (typeof sessionId !== "string") {
        res.status(400).json({ error: "Invalid cash session ID." });
        return;
    }
    if (!z.string().uuid().safeParse(sessionId).success) {
        res.status(400).json({ error: "Invalid cash session ID." });
        return;
    }
    try {
        const result = getSessionSummary(sessionId);
        if (!result) {
            res.status(404).json({ error: "Cash session not found." });
            return;
        }
        res.json(result);
    }
    catch (error) {
        console.error("Getting cash session summary failed:", error);
        res.status(500).json({
            error: "Could not retrieve cash session summary.",
        });
    }
});
// POST /api/cash-sessions/:id/close
// Count the drawer and close the session.
router.post("/:id/close", requireAuth, (req, res) => {
    const sessionId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
    if (typeof sessionId !== "string") {
        res.status(400).json({ error: "Invalid cash session ID." });
        return;
    }
    if (!z.string().uuid().safeParse(sessionId).success) {
        res.status(400).json({ error: "Invalid cash session ID." });
        return;
    }
    const parsed = closeSessionSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid cash count.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const user = res.locals.user;
    try {
        const closeSession = db.transaction(() => {
            const session = db.prepare(`
        SELECT id, status, opening_float_minor
        FROM cash_sessions
        WHERE id = ?
      `).get(sessionId);
            if (!session) {
                return {
                    success: false,
                    status: 404,
                    error: "Cash session not found.",
                };
            }
            if (session.status !== "OPEN") {
                return {
                    success: false,
                    status: 409,
                    error: "This cash session is already closed.",
                };
            }
            const totals = getCashTotals(sessionId);
            const expectedCash = session.opening_float_minor +
                totals.cash_received_minor -
                totals.cash_refunded_minor;
            const countedCash = parsed.data.counted_cash_minor;
            const difference = countedCash - expectedCash;
            db.prepare(`
        UPDATE cash_sessions
        SET
          closed_by = ?,
          closed_at = datetime('now'),
          expected_cash_minor = ?,
          counted_cash_minor = ?,
          difference_minor = ?,
          status = 'CLOSED'
        WHERE id = ?
          AND status = 'OPEN'
      `).run(user.id, expectedCash, countedCash, difference, sessionId);
            db.prepare(`
        INSERT INTO audit_logs (
          user_id,
          action,
          entity_type,
          entity_id,
          details_json
        )
        VALUES (?, 'CLOSE', 'CASH_SESSION', ?, ?)
      `).run(user.id, sessionId, JSON.stringify({
                expected_cash_minor: expectedCash,
                counted_cash_minor: countedCash,
                difference_minor: difference,
                cash_received_minor: totals.cash_received_minor,
                cash_refunded_minor: totals.cash_refunded_minor,
            }));
            return {
                success: true,
                expected_cash_minor: expectedCash,
                counted_cash_minor: countedCash,
                difference_minor: difference,
            };
        });
        const result = closeSession.immediate();
        if (!result.success) {
            res.status(result.status).json({
                error: result.error,
            });
            return;
        }
        res.json({
            message: "Cash session closed successfully.",
            cash_session: getSession(sessionId),
            summary: {
                expected_cash_minor: result.expected_cash_minor,
                counted_cash_minor: result.counted_cash_minor,
                difference_minor: result.difference_minor,
            },
        });
    }
    catch (error) {
        console.error("Closing cash session failed:", error);
        res.status(500).json({
            error: "Could not close cash session.",
        });
    }
});
export default router;
//# sourceMappingURL=cash-sessions.routes.js.map