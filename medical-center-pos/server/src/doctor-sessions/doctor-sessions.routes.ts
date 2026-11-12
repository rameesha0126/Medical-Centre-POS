
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import {
  requireAuth,
  requireOwner,
} from "../auth/auth.routes.js";

const router = Router();

const uuidSchema = z.string().uuid();

const dateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}, "Date must be a valid YYYY-MM-DD date.");

const timeSchema = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d$/,
  "Time must use HH:MM format.",
);

const createSessionSchema = z.object({
  doctor_id: uuidSchema,
  session_date: dateSchema,
  start_time: timeSchema,
  end_time: timeSchema,
}).refine(
  (data) => data.start_time < data.end_time,
  {
    path: ["end_time"],
    message: "End time must be later than start time.",
  },
);

const listSessionsSchema = z.object({
  doctorId: uuidSchema,
  date: dateSchema,
});

type TimeWindow = {
  start_time: string;
  end_time: string;
};

type ScheduleException = TimeWindow & {
  status: "CHANGED" | "CANCELLED" | "ADDED";
};

type SessionRow = {
  id: string;
  doctor_id: string;
  session_date: string;
  start_time: string;
  end_time: string;
  status: string;
  created_by: string | null;
  created_at: string;
};

function getAllowedWindows(
  doctorId: string,
  sessionDate: string,
): TimeWindow[] {
  const exception = db.prepare(`
    SELECT status, start_time, end_time
    FROM schedule_exceptions
    WHERE doctor_id = ?
      AND session_date = ?
  `).get(
    doctorId,
    sessionDate,
  ) as ScheduleException | undefined;

  if (exception?.status === "CANCELLED") {
    return [];
  }

  if (exception?.status === "CHANGED") {
    if (!exception.start_time || !exception.end_time) {
      return [];
    }

    return [{
      start_time: exception.start_time,
      end_time: exception.end_time,
    }];
  }

  const dayOfWeek = new Date(
    `${sessionDate}T00:00:00Z`,
  ).getUTCDay();

  const weekly = db.prepare(`
    SELECT start_time, end_time
    FROM doctor_schedules
    WHERE doctor_id = ?
      AND day_of_week = ?
      AND is_active = 1
      AND (
        effective_from IS NULL
        OR effective_from <= ?
      )
      AND (
        effective_until IS NULL
        OR effective_until >= ?
      )
    ORDER BY start_time
  `).all(
    doctorId,
    dayOfWeek,
    sessionDate,
    sessionDate,
  ) as TimeWindow[];

  if (
    exception?.status === "ADDED" &&
    exception.start_time &&
    exception.end_time
  ) {
    weekly.push({
      start_time: exception.start_time,
      end_time: exception.end_time,
    });
  }

  return weekly;
}

function getSession(sessionId: string) {
  return db.prepare(`
    SELECT
      s.id,
      s.doctor_id,
      d.full_name AS doctor_name,
      s.session_date,
      s.start_time,
      s.end_time,
      s.status,
      s.created_by,
      s.created_at,
      (
        SELECT COUNT(*)
        FROM appointments a
        WHERE a.doctor_session_id = s.id
      ) AS appointment_count
    FROM doctor_sessions s
    INNER JOIN doctors d
      ON d.id = s.doctor_id
    WHERE s.id = ?
  `).get(sessionId);
}

// GET /api/doctor-sessions?doctorId=...&date=...
// Owner and staff can view sessions.
router.get("/", requireAuth, (req, res) => {
  const parsed = listSessionsSchema.safeParse(
    req.query,
  );

  if (!parsed.success) {
    res.status(400).json({
      error: "A valid doctorId and date are required.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const { doctorId, date } = parsed.data;

  const sessions = db.prepare(`
    SELECT
      s.id,
      s.doctor_id,
      d.full_name AS doctor_name,
      s.session_date,
      s.start_time,
      s.end_time,
      s.status,
      s.created_by,
      s.created_at,
      (
        SELECT COUNT(*)
        FROM appointments a
        WHERE a.doctor_session_id = s.id
      ) AS appointment_count
    FROM doctor_sessions s
    INNER JOIN doctors d
      ON d.id = s.doctor_id
    WHERE s.doctor_id = ?
      AND s.session_date = ?
    ORDER BY s.start_time
  `).all(doctorId, date);

  res.json({ sessions });
});


function assignAppointmentsOnSessionCreation(
  sessionId: string,
  doctorId: string,
  sessionDate: string,
  startTime: string,
  endTime: string,
  actorId: string,
): string[] {
  // Automatic association is allowed only when
  // exactly one schedule window exists.
  const windows = getAllowedWindows(
    doctorId,
    sessionDate,
  );

  if (
    windows.length !== 1 ||
    windows[0]?.start_time !== startTime ||
    windows[0]?.end_time !== endTime
  ) {
    return [];
  }

  const exception = db.prepare(`
    SELECT id, status
    FROM schedule_exceptions
    WHERE doctor_id = ?
      AND session_date = ?
  `).get(
    doctorId,
    sessionDate,
  ) as {
    id: string;
    status: string;
  } | undefined;

  // ADDED exceptions can make the intended
  // session ambiguous for existing bookings.
  if (exception?.status === "ADDED") {
    return [];
  }

  const expectedExceptionId =
    exception?.status === "CHANGED"
      ? exception.id
      : null;

  // Avoid automatically assigning when other
  // sessions exist for the same doctor/date.
  const sessionCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM doctor_sessions
    WHERE doctor_id = ?
      AND session_date = ?
  `).get(
    doctorId,
    sessionDate,
  ) as { count: number };

  if (sessionCount.count !== 1) {
    return [];
  }

  const unlinked = db.prepare(`
    SELECT
      id,
      queue_number,
      status,
      schedule_exception_id
    FROM appointments
    WHERE doctor_id = ?
      AND appointment_date = ?
      AND doctor_session_id IS NULL
      AND status NOT IN ('CANCELLED', 'NO_SHOW')
    ORDER BY queue_number
  `).all(
    doctorId,
    sessionDate,
  ) as Array<{
    id: string;
    queue_number: number;
    status: string;
    schedule_exception_id: string | null;
  }>;

  // A single conflicting appointment causes
  // automatic association to be skipped.
  // The existing manual endpoint remains available.
  if (
    unlinked.some(
      (appointment) =>
        appointment.schedule_exception_id !==
        expectedExceptionId,
    )
  ) {
    return [];
  }

  const update = db.prepare(`
    UPDATE appointments
    SET doctor_session_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
      AND doctor_session_id IS NULL
  `);

  const audit = db.prepare(`
    INSERT INTO audit_logs (
      user_id,
      action,
      entity_type,
      entity_id,
      details_json
    )
    VALUES (?, 'UPDATE', 'APPOINTMENT', ?, ?)
  `);

  const assignedIds: string[] = [];

  for (const appointment of unlinked) {
    const result = update.run(
      sessionId,
      appointment.id,
    );

    if (result.changes !== 1) {
      throw new Error(
        `Could not automatically assign appointment ${appointment.id}`,
      );
    }

    audit.run(
      actorId,
      appointment.id,
      JSON.stringify({
        action: "AUTO_ASSIGN_DOCTOR_SESSION",
        doctor_session_id: sessionId,
        doctor_id: doctorId,
        appointment_date: sessionDate,
        queue_number: appointment.queue_number,
        previous_status: appointment.status,
        reason:
          "Automatic association during doctor session creation",
      }),
    );

    assignedIds.push(appointment.id);
  }

  return assignedIds;
}

// POST /api/doctor-sessions
// Owner only: create a session matching an allowed
// weekly schedule or date-specific exception.
router.post(
  "/",
  requireAuth,
  requireOwner,
  (req, res) => {
    const parsed = createSessionSchema.safeParse(
      req.body,
    );

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid doctor session details.",
        details: parsed.error.flatten(),
      });
      return;
    }

    const data = parsed.data;
    const user = res.locals.user as {
      id: string;
      role: "OWNER" | "STAFF";
    };

    try {
      const createSession = db.transaction(() => {
        const doctor = db.prepare(`
          SELECT id
          FROM doctors
          WHERE id = ?
            AND is_active = 1
        `).get(data.doctor_id);

        if (!doctor) {
          return {
            success: false as const,
            status: 404,
            error: "Active doctor not found.",
          };
        }

        const allowedWindows = getAllowedWindows(
          data.doctor_id,
          data.session_date,
        );

        const matchesSchedule = allowedWindows.some(
          (window) =>
            window.start_time === data.start_time &&
            window.end_time === data.end_time,
        );

        if (!matchesSchedule) {
          return {
            success: false as const,
            status: 409,
            error:
              "Session times must match an available doctor schedule or exception.",
          };
        }

        // Prevent overlapping sessions on the same date.
        const overlap = db.prepare(`
          SELECT id
          FROM doctor_sessions
          WHERE doctor_id = ?
            AND session_date = ?
            AND start_time < ?
            AND end_time > ?
          LIMIT 1
        `).get(
          data.doctor_id,
          data.session_date,
          data.end_time,
          data.start_time,
        );

        if (overlap) {
          return {
            success: false as const,
            status: 409,
            error:
              "This doctor already has an overlapping session on this date.",
          };
        }

        const sessionId = randomUUID();

        db.prepare(`
          INSERT INTO doctor_sessions (
            id,
            doctor_id,
            session_date,
            start_time,
            end_time,
            status,
            created_by
          )
          VALUES (?, ?, ?, ?, ?, 'SCHEDULED', ?)
        `).run(
          sessionId,
          data.doctor_id,
          data.session_date,
          data.start_time,
          data.end_time,
          user.id,
        );

        db.prepare(`
          INSERT INTO audit_logs (
            user_id,
            action,
            entity_type,
            entity_id,
            details_json
          )
          VALUES (?, 'CREATE', 'DOCTOR_SESSION', ?, ?)
        `).run(
          user.id,
          sessionId,
          JSON.stringify({
            doctor_id: data.doctor_id,
            session_date: data.session_date,
            start_time: data.start_time,
            end_time: data.end_time,
          }),
        );
        
        const assignedAppointmentIds =
          assignAppointmentsOnSessionCreation(
            sessionId,
            data.doctor_id,
            data.session_date,
            data.start_time,
            data.end_time,
            user.id,
          );

        return {
          success: true as const,
          sessionId,
          assignedAppointmentIds,
        };
      });

      const result = createSession.immediate();

      if (!result.success) {
        res.status(result.status).json({
          error: result.error,
        });
        return;
      }
      
      res.status(201).json({
        message: "Doctor session created successfully.",
        session: getSession(result.sessionId),
        automatically_assigned_count:
          result.assignedAppointmentIds.length,
        automatically_assigned_appointment_ids:
          result.assignedAppointmentIds,
      });
    } catch (error) {
      console.error(
        "Doctor session creation failed:",
        error,
      );

      res.status(500).json({
        error: "Could not create doctor session.",
      });
    }
  },
);


/**
 * POST /api/doctor-sessions/:id/assign-unlinked
 *
 * Owner only.
 *
 * Associates existing unassigned appointments when:
 * - The session is SCHEDULED or ACTIVE.
 * - It is the only session for the doctor/date.
 * - It is the only allowed schedule window.
 * - The appointment's schedule exception matches.
 *
 * Existing queue numbers, statuses, invoices,
 * and payments remain unchanged.
 */
router.post(
  "/:id/assign-unlinked",
  requireAuth,
  requireOwner,
  (req, res) => {
    const sessionId = req.params.id;

    if (
      typeof sessionId !== "string" ||
      !uuidSchema.safeParse(sessionId).success
    ) {
      res.status(400).json({
        error: "Invalid doctor session ID.",
      });
      return;
    }

    const user = res.locals.user as {
      id: string;
      role: "OWNER" | "STAFF";
    };

    try {
      const assignAppointments = db.transaction(() => {
        const session = db.prepare(`
          SELECT
            id,
            doctor_id,
            session_date,
            start_time,
            end_time,
            status
          FROM doctor_sessions
          WHERE id = ?
        `).get(sessionId) as SessionRow | undefined;

        if (!session) {
          return {
            success: false as const,
            status: 404,
            error: "Doctor session not found.",
          };
        }

        if (
          session.status !== "SCHEDULED" &&
          session.status !== "ACTIVE"
        ) {
          return {
            success: false as const,
            status: 409,
            error:
              "Appointments cannot be assigned to a completed or cancelled session.",
          };
        }

        // Require exactly one session for this
        // doctor and date, including inactive sessions.
        const sessionCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM doctor_sessions
          WHERE doctor_id = ?
            AND session_date = ?
        `).get(
          session.doctor_id,
          session.session_date,
        ) as { count: number };

        if (sessionCount.count !== 1) {
          return {
            success: false as const,
            status: 409,
            error:
              "Multiple doctor sessions exist. Manual appointment assignment is required.",
          };
        }

        // Do not bulk-assign appointments when the
        // schedule contains multiple possible windows.
        const allowedWindows = getAllowedWindows(
          session.doctor_id,
          session.session_date,
        );

        if (
          allowedWindows.length !== 1 ||
          allowedWindows[0]?.start_time !==
            session.start_time ||
          allowedWindows[0]?.end_time !==
            session.end_time
        ) {
          return {
            success: false as const,
            status: 409,
            error:
              "Session does not uniquely match the current doctor schedule.",
          };
        }

        const exception = db.prepare(`
          SELECT id, status
          FROM schedule_exceptions
          WHERE doctor_id = ?
            AND session_date = ?
        `).get(
          session.doctor_id,
          session.session_date,
        ) as {
          id: string;
          status: string;
        } | undefined;

        // For CHANGED exceptions, appointments
        // must reference that same exception.
        // For normal weekly schedules, appointments
        // must not carry a conflicting exception.
        const expectedExceptionId =
          exception?.status === "CHANGED"
            ? exception.id
            : null;

        if (
          exception?.status === "ADDED"
        ) {
          // A date with an ADDED exception can be
          // ambiguous for previously booked patients.
          return {
            success: false as const,
            status: 409,
            error:
              "Appointments for ADDED schedule exceptions require manual review.",
          };
        }

        const unlinked = db.prepare(`
          SELECT
            id,
            queue_number,
            status,
            schedule_exception_id
          FROM appointments
          WHERE doctor_id = ?
            AND appointment_date = ?
            AND doctor_session_id IS NULL
            AND status NOT IN ('CANCELLED', 'NO_SHOW')
          ORDER BY queue_number
        `).all(
          session.doctor_id,
          session.session_date,
        ) as Array<{
          id: string;
          queue_number: number;
          status: string;
          schedule_exception_id: string | null;
        }>;

        // Reject the entire operation if any
        // unlinked appointment is ambiguous.
        for (const appointment of unlinked) {
          if (
            appointment.schedule_exception_id !==
            expectedExceptionId
          ) {
            return {
              success: false as const,
              status: 409,
              error:
                "An appointment has a conflicting schedule exception. Manual review is required.",
            };
          }
        }

        const update = db.prepare(`
          UPDATE appointments
          SET doctor_session_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
            AND doctor_session_id IS NULL
        `);

        const audit = db.prepare(`
          INSERT INTO audit_logs (
            user_id,
            action,
            entity_type,
            entity_id,
            details_json
          )
          VALUES (?, 'UPDATE', 'APPOINTMENT', ?, ?)
        `);

        const assigned = [];

        for (const appointment of unlinked) {
          const updateResult = update.run(
            session.id,
            appointment.id,
          );

          if (updateResult.changes !== 1) {
            throw new Error(
              `Could not assign appointment ${appointment.id}`,
            );
          }

          audit.run(
            user.id,
            appointment.id,
            JSON.stringify({
              action: "ASSIGN_DOCTOR_SESSION",
              doctor_session_id: session.id,
              doctor_id: session.doctor_id,
              appointment_date: session.session_date,
              queue_number: appointment.queue_number,
              previous_status: appointment.status,
              reason:
                "Automatic association of existing appointment",
            }),
          );

          assigned.push({
            appointment_id: appointment.id,
            queue_number: appointment.queue_number,
            status: appointment.status,
          });
        }

        return {
          success: true as const,
          assigned,
        };
      });

      const result = assignAppointments.immediate();

      if (!result.success) {
        res.status(result.status).json({
          error: result.error,
        });
        return;
      }

      res.json({
        message:
          "Existing appointments associated successfully.",
        session_id: sessionId,
        assigned_count: result.assigned.length,
        assigned_appointments: result.assigned,
      });
    } catch (error) {
      console.error(
        "Appointment association failed:",
        error,
      );

      res.status(500).json({
        error:
          "Could not associate existing appointments.",
      });
    }
  },
);

/**
 * PATCH /api/doctor-sessions/:id/status
 *
 * SCHEDULED -> ACTIVE
 * ACTIVE -> COMPLETED
 * SCHEDULED -> CANCELLED
 *
 * Owner and staff may start or complete sessions.
 * Only the owner may cancel a session.
 *
 * Unresolved appointments prevent completion
 * or cancellation.
 */

const updateSessionStatusSchema = z.object({
  status: z.enum([
    "ACTIVE",
    "COMPLETED",
    "CANCELLED",
  ]),
});

type SessionStatus =
  | "SCHEDULED"
  | "ACTIVE"
  | "COMPLETED"
  | "CANCELLED";

router.patch(
  "/:id/status",
  requireAuth,
  (req, res) => {
    const sessionId = req.params.id;

    if (
      typeof sessionId !== "string" ||
      !uuidSchema.safeParse(sessionId).success
    ) {
      res.status(400).json({
        error: "Invalid doctor session ID.",
      });
      return;
    }

    const parsed =
      updateSessionStatusSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid doctor session status.",
        details: parsed.error.flatten(),
      });
      return;
    }

    const nextStatus = parsed.data.status;

    const user = res.locals.user as {
      id: string;
      role: "OWNER" | "STAFF";
    };

    if (
      nextStatus === "CANCELLED" &&
      user.role !== "OWNER"
    ) {
      res.status(403).json({
        error:
          "Only the owner can cancel doctor sessions.",
      });
      return;
    }

    const allowedTransitions: Record<
      SessionStatus,
      SessionStatus[]
    > = {
      SCHEDULED: ["ACTIVE", "CANCELLED"],
      ACTIVE: ["COMPLETED"],
      COMPLETED: [],
      CANCELLED: [],
    };

    try {
      const updateSession = db.transaction(() => {
        const session = db.prepare(`
          SELECT
            id,
            doctor_id,
            session_date,
            start_time,
            end_time,
            status
          FROM doctor_sessions
          WHERE id = ?
        `).get(sessionId) as
          | {
              id: string;
              doctor_id: string;
              session_date: string;
              start_time: string;
              end_time: string;
              status: SessionStatus;
            }
          | undefined;

        if (!session) {
          return {
            success: false as const,
            status: 404,
            error: "Doctor session not found.",
          };
        }

        if (
          !allowedTransitions[session.status]
            ?.includes(nextStatus)
        ) {
          return {
            success: false as const,
            status: 409,
            error:
              `Cannot change doctor session from ` +
              `${session.status} to ${nextStatus}.`,
          };
        }

        // Count appointments that still require
        // an operational resolution.        
        const unresolved = db.prepare(`
          SELECT
            COUNT(*) AS count
          FROM appointments
          WHERE doctor_id = ?
            AND appointment_date = ?
            AND (
              doctor_session_id = ?
              OR doctor_session_id IS NULL
            )
            AND status NOT IN (
              'COMPLETED',
              'CANCELLED',
              'NO_SHOW'
            )
        `).get(
          session.doctor_id,
          session.session_date,
          sessionId,
        ) as {
          count: number;
        };

        if (
          nextStatus === "COMPLETED" &&
          unresolved.count > 0
        ) {
          return {
            success: false as const,
            status: 409,
            error:
              "Cannot complete a doctor session while unresolved appointments remain.",
            unresolved_count: unresolved.count,
          };
        }

        if (
          nextStatus === "CANCELLED" &&
          unresolved.count > 0
        ) {
          return {
            success: false as const,
            status: 409,
            error:
              "Cannot cancel a doctor session while unresolved appointments remain.",
            unresolved_count: unresolved.count,
          };
        }

        const update = db.prepare(`
          UPDATE doctor_sessions
          SET status = ?
          WHERE id = ?
            AND status = ?
        `).run(
          nextStatus,
          sessionId,
          session.status,
        );

        if (update.changes !== 1) {
          throw new Error(
            "Doctor session status changed unexpectedly.",
          );
        }

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
            'UPDATE',
            'DOCTOR_SESSION',
            ?,
            ?
          )
        `).run(
          user.id,
          sessionId,
          JSON.stringify({
            action: "UPDATE_SESSION_STATUS",
            doctor_id: session.doctor_id,
            session_date: session.session_date,
            previous_status: session.status,
            new_status: nextStatus,
            unresolved_appointment_count:
              unresolved.count,
          }),
        );

        return {
          success: true as const,
          previousStatus: session.status,
          newStatus: nextStatus,
        };
      });

      const result = updateSession.immediate();

      if (!result.success) {
        res.status(result.status).json({
          error: result.error,
          ...(
            "unresolved_count" in result
              ? {
                  unresolved_count:
                    result.unresolved_count,
                }
              : {}
          ),
        });
        return;
      }

      res.json({
        message:
          "Doctor session status updated successfully.",
        previous_status: result.previousStatus,
        session: getSession(sessionId),
      });
    } catch (error) {
      console.error(
        "Doctor session status update failed:",
        error,
      );

      res.status(500).json({
        error:
          "Could not update doctor session status.",
      });
    }
  },
);

function getDoctorSettlementPreview(sessionId: string) {
  const session = db.prepare(`
    SELECT id, doctor_id, session_date, status
    FROM doctor_sessions
    WHERE id = ?
  `).get(sessionId) as {
    id: string;
    doctor_id: string;
    session_date: string;
    status: string;
  } | undefined;

  if (!session) {
    return { ok: false, status: 404, error: "Doctor session not found." } as const;
  }

  if (session.status !== "COMPLETED") {
    return {
      ok: false,
      status: 409,
      error: "Only completed doctor sessions can be previewed for settlement.",
    } as const;
  }

  const rows = db.prepare(`
    SELECT
      a.id AS appointment_id,
      a.queue_number,
      i.id AS invoice_id,
      i.invoice_number,
      ii.id AS invoice_item_id,
      ii.provider_share_minor AS doctor_fee_minor,
      psi.settlement_id,
      psi.amount_minor AS settled_amount_minor,
      COALESCE((
        SELECT SUM(rpa.provider_reduction_minor)
        FROM payments p
        JOIN refunds r ON r.payment_id = p.id
        JOIN refund_provider_allocations rpa
          ON rpa.refund_id = r.id AND rpa.invoice_item_id = ii.id
        WHERE p.invoice_id = i.id AND p.status = 'CONFIRMED'
      ), 0) AS provider_reduction_minor,
      (
        SELECT COUNT(*)
        FROM payments p
        JOIN refunds r ON r.payment_id = p.id
        LEFT JOIN refund_provider_allocations rpa
          ON rpa.refund_id = r.id AND rpa.invoice_item_id = ii.id
        WHERE p.invoice_id = i.id AND p.status = 'CONFIRMED'
          AND rpa.id IS NULL AND ii.provider_share_minor > 0
      ) AS unresolved_refund_count
    FROM appointments a
    JOIN invoices i ON i.appointment_id = a.id
    JOIN invoice_items ii ON ii.invoice_id = i.id AND ii.doctor_id = a.doctor_id
    JOIN services s ON s.id = ii.service_id AND s.service_type = 'CONSULTATION'
    LEFT JOIN provider_settlement_items psi ON psi.invoice_item_id = ii.id
    WHERE a.doctor_session_id = ?
      AND a.status = 'COMPLETED'
      AND (
        i.status IN ('PAID', 'REFUNDED')
        OR (
          i.status = 'OPEN'
          AND (
            SELECT COALESCE(SUM(p.amount_minor), 0)
            FROM payments p
            WHERE p.invoice_id = i.id
              AND p.status = 'CONFIRMED'
          ) >= i.total_minor
        )
      )
    ORDER BY a.queue_number, ii.id
  `).all(session.id) as Array<{
    appointment_id: string;
    queue_number: number;
    invoice_id: string;
    invoice_number: string;
    invoice_item_id: string;
    doctor_fee_minor: number;
    settlement_id: string | null;
    settled_amount_minor: number | null;
    provider_reduction_minor: number;
    unresolved_refund_count: number;
  }>;

  const items = rows.map((row) => ({
    ...row,
    entitlement_minor: row.doctor_fee_minor - row.provider_reduction_minor,
  }));

  const unlinkedAppointments = db.prepare(`
    SELECT id, queue_number, status
    FROM appointments
    WHERE doctor_id = ?
      AND appointment_date = ?
      AND doctor_session_id IS NULL
      AND status NOT IN ('CANCELLED', 'NO_SHOW')
    ORDER BY queue_number
  `).all(session.doctor_id, session.session_date);

  const unsettledItems = items.filter((item) => item.settlement_id === null);
  const alreadySettledItems = items.filter((item) => item.settlement_id !== null);
  const pendingAdjustmentRows = db.prepare(`
    SELECT
      psa.id,
      psa.settlement_id,
      rpa.refund_id,
      rpa.invoice_item_id,
      psa.adjustment_minor,
      COALESCE((
        SELECT SUM(ri.amount_minor)
        FROM provider_adjustment_recovery_items ri
        WHERE ri.adjustment_id = psa.id
      ), 0) AS recovered_minor,
      psa.status
    FROM provider_settlement_adjustments psa
    JOIN refund_provider_allocations rpa
      ON rpa.id = psa.refund_provider_allocation_id
    JOIN provider_settlement_items psi
      ON psi.settlement_id = psa.settlement_id
      AND psi.invoice_item_id = rpa.invoice_item_id
    JOIN invoice_items ii ON ii.id = psi.invoice_item_id
    JOIN invoices i ON i.id = ii.invoice_id
    JOIN appointments a ON a.id = i.appointment_id
    WHERE a.doctor_session_id = ?
      AND psa.status = 'PENDING'
    ORDER BY psa.created_at, psa.id
  `).all(session.id) as Array<{
    id: string;
    settlement_id: string;
    refund_id: string;
    invoice_item_id: string;
    adjustment_minor: number;
    recovered_minor: number;
    status: "PENDING";
  }>;

  const pendingAdjustments = pendingAdjustmentRows.map((adjustment) => ({
    ...adjustment,
    remaining_minor: adjustment.adjustment_minor - adjustment.recovered_minor,
  }));

  const pendingAdjustmentTotalMinor = pendingAdjustments.reduce(
    (total, adjustment) => total + adjustment.adjustment_minor,
    0,
  );

  const pendingAdjustmentRecoveredMinor = pendingAdjustments.reduce(
    (total, adjustment) => total + adjustment.recovered_minor,
    0,
  );

  const pendingAdjustmentRemainingMinor = pendingAdjustments.reduce(
    (total, adjustment) => total + adjustment.remaining_minor,
    0,
  );

  const unresolvedRefundItems = items.filter(
    (item) => item.unresolved_refund_count > 0,
  );
  const unsettledEntitlementMinor = unsettledItems.reduce(
    (total, item) => total + item.entitlement_minor,
    0,
  );
  const reviewRequired =
    unlinkedAppointments.length > 0 || unresolvedRefundItems.length > 0;

  return { ok: true as const, preview: {
    session,
    unsettled_items: unsettledItems,
    already_settled_items: alreadySettledItems,
    pending_adjustments: pendingAdjustments,
    pending_adjustment_total_minor: pendingAdjustmentTotalMinor,
    pending_adjustment_recovered_minor: pendingAdjustmentRecoveredMinor,
    pending_adjustment_remaining_minor: pendingAdjustmentRemainingMinor,
    unsettled_entitlement_minor: unsettledEntitlementMinor,
    unlinked_appointments: unlinkedAppointments,
    unresolved_refund_item_ids: unresolvedRefundItems.map(
      (item) => item.invoice_item_id,
    ),
    review_required: reviewRequired,
    ready_for_payout: !reviewRequired && unsettledEntitlementMinor > 0,
    },
  };
}

router.get("/:id/settlement-preview", requireAuth, (req, res) => {
  const parsed = uuidSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid doctor session ID." });
    return;
  }

  const result = getDoctorSettlementPreview(parsed.data);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json(result.preview);
});

const doctorPayoutSchema = z.object({
  request_key: uuidSchema,
  method: z.literal("BANK_TRANSFER"),
  reference: z.string().trim().min(1).max(200),
  expected_amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deductions: z.array(z.object({
    adjustment_id: uuidSchema,
    amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(100).default([]),
}).strict();

type RecordedDoctorSettlement = {
  settlement_id: string;
  doctor_session_id: string;
  gross_amount_minor: number;
  recovered_amount_minor: number;
  payout: {
    id: string;
    amount_minor: number;
    method: "BANK_TRANSFER";
    reference: string;
  } | null;
};

router.post("/:id/payouts", requireAuth, (req, res) => {
  const sessionId = uuidSchema.safeParse(req.params.id);
  const parsed = doctorPayoutSchema.safeParse(req.body);

  if (!sessionId.success || !parsed.success) {
    res.status(400).json({ error: "Invalid session ID or settlement details." });
    return;
  }

  const input = parsed.data;
  const user = res.locals.user as { id: string };
  const deductions = [...input.deductions].sort(
    (left, right) => left.adjustment_id.localeCompare(right.adjustment_id),
  );

  if (
    new Set(deductions.map((item) => item.adjustment_id)).size !==
    deductions.length
  ) {
    res.status(400).json({ error: "Duplicate adjustment IDs are not allowed." });
    return;
  }

  const requestDetails = {
    doctor_session_id: sessionId.data,
    ...input,
    deductions,
  };
  const requestJson = JSON.stringify(requestDetails);

  try {
    const recordSettlement = db.transaction(() => {
      const existingAudit = db.prepare(`
        SELECT details_json
        FROM audit_logs
        WHERE entity_type = 'DOCTOR_SESSION_SETTLEMENT'
          AND action = 'CREATE'
          AND json_extract(details_json, '$.request.request_key') = ?
      `).get(input.request_key) as { details_json: string } | undefined;

      if (existingAudit) {
        const existing = JSON.parse(existingAudit.details_json) as {
          request: typeof requestDetails;
          result: RecordedDoctorSettlement;
        };

        if (JSON.stringify(existing.request) !== requestJson) {
          return {
            ok: false,
            status: 409,
            error: "This request key was already used for different settlement details.",
          } as const;
        }

        return {
          ok: true,
          replayed: true,
          settlement: existing.result,
        } as const;
      }

      const usedRecoveryKey = db.prepare(`
        SELECT id
        FROM provider_adjustment_recoveries
        WHERE request_key = ?
      `).get(input.request_key);

      if (usedRecoveryKey) {
        return {
          ok: false,
          status: 409,
          error: "This request key was already used for another recovery.",
        } as const;
      }

      const previewResult = getDoctorSettlementPreview(sessionId.data);
      if (!previewResult.ok) return previewResult;

      const preview = previewResult.preview;
      if (!preview.ready_for_payout) {
        return {
          ok: false,
          status: 409,
          error: preview.review_required
            ? "Resolve the settlement review flags before recording a payout."
            : "This session has no payable unsettled items.",
        } as const;
      }

      const items = preview.unsettled_items.filter(
        (item) => item.entitlement_minor > 0,
      );
      const grossAmount = items.reduce(
        (total, item) => total + item.entitlement_minor,
        0,
      );
      const recoveredAmount = deductions.reduce(
        (total, deduction) => total + deduction.amount_minor,
        0,
      );

      if (
        !Number.isSafeInteger(grossAmount) ||
        !Number.isSafeInteger(recoveredAmount) ||
        grossAmount !== preview.unsettled_entitlement_minor ||
        grossAmount !== input.expected_amount_minor
      ) {
        return {
          ok: false,
          status: 409,
          error: "The settlement amount could not be confirmed. Refresh the preview.",
        } as const;
      }

      if (recoveredAmount > grossAmount) {
        return {
          ok: false,
          status: 409,
          error: "Deductions cannot exceed this session's unsettled entitlement.",
        } as const;
      }

      const adjustmentBalances = new Map<string, number>();

      for (const deduction of deductions) {
        const adjustment = db.prepare(`
          SELECT
            psa.status,
            psa.adjustment_minor - COALESCE((
              SELECT SUM(ri.amount_minor)
              FROM provider_adjustment_recovery_items ri
              WHERE ri.adjustment_id = psa.id
            ), 0) AS remaining_minor
          FROM provider_settlement_adjustments psa
          JOIN provider_settlements ps ON ps.id = psa.settlement_id
          WHERE psa.id = ?
            AND ps.provider_type = 'DOCTOR'
            AND ps.doctor_id = ?
        `).get(
          deduction.adjustment_id,
          preview.session.doctor_id,
        ) as { status: string; remaining_minor: number } | undefined;

        if (
          !adjustment ||
          adjustment.status !== "PENDING" ||
          deduction.amount_minor > adjustment.remaining_minor
        ) {
          return {
            ok: false,
            status: 409,
            error: "A deduction is invalid or exceeds this doctor's remaining adjustment balance.",
          } as const;
        }

        adjustmentBalances.set(
          deduction.adjustment_id,
          adjustment.remaining_minor,
        );
      }

      const settlementId = randomUUID();
      const paymentAmount = grossAmount - recoveredAmount;
      const { session } = preview;

      db.prepare(`
        INSERT INTO provider_settlements (
          id, provider_type, doctor_id, period_start, period_end,
          amount_due_minor, amount_paid_minor, amount_recovered_minor,
          status, created_by
        )
        VALUES (?, 'DOCTOR', ?, ?, ?, ?, ?, ?, 'PAID', ?)
      `).run(
        settlementId,
        session.doctor_id,
        session.session_date,
        session.session_date,
        grossAmount,
        paymentAmount,
        recoveredAmount,
        user.id,
      );

      const insertItem = db.prepare(`
        INSERT INTO provider_settlement_items (
          id, settlement_id, invoice_item_id, amount_minor
        )
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        insertItem.run(
          randomUUID(),
          settlementId,
          item.invoice_item_id,
          item.entitlement_minor,
        );
      }

      const insertAudit = db.prepare(`
        INSERT INTO audit_logs (
          user_id, action, entity_type, entity_id, details_json
        )
        VALUES (?, 'CREATE', ?, ?, ?)
      `);

      if (recoveredAmount > 0) {
        const recoveryId = randomUUID();

        db.prepare(`
          INSERT INTO provider_adjustment_recoveries (
            id, request_key, doctor_id, recovery_kind, amount_minor,
            target_settlement_id, created_by
          )
          VALUES (?, ?, ?, 'PAYOUT_DEDUCTION', ?, ?, ?)
        `).run(
          recoveryId,
          input.request_key,
          session.doctor_id,
          recoveredAmount,
          settlementId,
          user.id,
        );

        const insertRecoveryItem = db.prepare(`
          INSERT INTO provider_adjustment_recovery_items (
            id, recovery_id, adjustment_id, amount_minor
          )
          VALUES (?, ?, ?, ?)
        `);

        for (const deduction of deductions) {
          insertRecoveryItem.run(
            randomUUID(),
            recoveryId,
            deduction.adjustment_id,
            deduction.amount_minor,
          );

          if (
            deduction.amount_minor ===
            adjustmentBalances.get(deduction.adjustment_id)
          ) {
            db.prepare(`
              UPDATE provider_settlement_adjustments
              SET status = 'APPLIED'
              WHERE id = ?
            `).run(deduction.adjustment_id);
          }
        }

        insertAudit.run(
          user.id,
          "PROVIDER_ADJUSTMENT_RECOVERY",
          recoveryId,
          JSON.stringify({
            doctor_session_id: session.id,
            target_settlement_id: settlementId,
            recovery_kind: "PAYOUT_DEDUCTION",
            amount_minor: recoveredAmount,
            deductions,
            request_key: input.request_key,
          }),
        );
      }

      let payout: RecordedDoctorSettlement["payout"] = null;

      if (paymentAmount > 0) {
        payout = {
          id: randomUUID(),
          amount_minor: paymentAmount,
          method: input.method,
          reference: input.reference,
        };

        db.prepare(`
          INSERT INTO provider_payouts (
            id, settlement_id, amount_minor, method, reference, paid_by
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          payout.id,
          settlementId,
          payout.amount_minor,
          payout.method,
          payout.reference,
          user.id,
        );

        insertAudit.run(
          user.id,
          "PROVIDER_PAYOUT",
          payout.id,
          JSON.stringify({
            doctor_session_id: session.id,
            settlement_id: settlementId,
            amount_minor: payout.amount_minor,
            method: payout.method,
            reference: payout.reference,
            invoice_item_ids: items.map((item) => item.invoice_item_id),
          }),
        );
      }

      const settlement: RecordedDoctorSettlement = {
        settlement_id: settlementId,
        doctor_session_id: session.id,
        gross_amount_minor: grossAmount,
        recovered_amount_minor: recoveredAmount,
        payout,
      };

      insertAudit.run(
        user.id,
        "DOCTOR_SESSION_SETTLEMENT",
        settlementId,
        JSON.stringify({ request: requestDetails, result: settlement }),
      );

      return { ok: true, replayed: false, settlement } as const;
    });

    const result = recordSettlement.immediate();

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(result.replayed ? 200 : 201).json({
      settlement: result.settlement,
      payout: result.settlement.payout,
      replayed: result.replayed,
    });
  } catch (error) {
    console.error("Doctor settlement recording failed:", error);
    res.status(500).json({ error: "Could not record doctor settlement." });
  }
});

router.get("/doctors/:doctorId/adjustment-balance", requireAuth, (req, res) => {
  const parsed = uuidSchema.safeParse(req.params.doctorId);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid doctor ID." });
    return;
  }

  const doctor = db.prepare(`
    SELECT id
    FROM doctors
    WHERE id = ?
  `).get(parsed.data) as { id: string } | undefined;

  if (!doctor) {
    res.status(404).json({ error: "Doctor not found." });
    return;
  }

  const rows = db.prepare(`
    SELECT
      psa.id AS adjustment_id,
      psa.settlement_id,
      rpa.refund_id,
      rpa.invoice_item_id,
      psa.adjustment_minor,
      psa.status,
      psa.created_at,
      COALESCE((
        SELECT SUM(ri.amount_minor)
        FROM provider_adjustment_recovery_items ri
        WHERE ri.adjustment_id = psa.id
      ), 0) AS recovered_minor
    FROM provider_settlement_adjustments psa
    JOIN provider_settlements ps ON ps.id = psa.settlement_id
    JOIN refund_provider_allocations rpa
      ON rpa.id = psa.refund_provider_allocation_id
    WHERE ps.provider_type = 'DOCTOR'
      AND ps.doctor_id = ?
    ORDER BY psa.created_at, psa.id
  `).all(doctor.id) as Array<{
    adjustment_id: string;
    settlement_id: string;
    refund_id: string;
    invoice_item_id: string;
    adjustment_minor: number;
    status: "PENDING" | "APPLIED" | "CANCELLED";
    created_at: string;
    recovered_minor: number;
  }>;

  const adjustments = rows.map((row) => ({
    ...row,
    remaining_minor:
      row.status === "CANCELLED"
        ? 0
        : row.adjustment_minor - row.recovered_minor,
  }));

  const outstandingMinor = adjustments.reduce(
    (total, adjustment) => total + adjustment.remaining_minor,
    0,
  );

  res.json({
    doctor_id: doctor.id,
    adjustments,
    outstanding_adjustment_minor: outstandingMinor,
  });
});

const adjustmentRepaymentSchema = z.object({
  request_key: z.string().uuid(),
  adjustment_id: z.string().uuid(),
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  method: z.literal("BANK_TRANSFER"),
  reference: z.string().trim().min(1).max(200),
}).strict();

router.post(
  "/doctors/:doctorId/adjustment-repayments",
  requireAuth,
  (req, res) => {
    const doctorId = uuidSchema.safeParse(req.params.doctorId);
    const parsed = adjustmentRepaymentSchema.safeParse(req.body);

    if (!doctorId.success || !parsed.success) {
      res.status(400).json({ error: "Invalid doctor ID or repayment details." });
      return;
    }

    const input = parsed.data;
    const user = res.locals.user as { id: string };

    const recordRepayment = db.transaction(() => {
      const existing = db.prepare(`
        SELECT
          id, doctor_id, recovery_kind, amount_minor,
          repayment_method, reference
        FROM provider_adjustment_recoveries
        WHERE request_key = ?
      `).get(input.request_key) as {
        id: string;
        doctor_id: string;
        recovery_kind: string;
        amount_minor: number;
        repayment_method: string | null;
        reference: string | null;
      } | undefined;

      if (existing) {
        const links = db.prepare(`
          SELECT adjustment_id, amount_minor
          FROM provider_adjustment_recovery_items
          WHERE recovery_id = ?
        `).all(existing.id) as Array<{
          adjustment_id: string;
          amount_minor: number;
        }>;

        const link = links[0];
        const matches =
          existing.doctor_id === doctorId.data &&
          existing.recovery_kind === "REPAYMENT" &&
          existing.amount_minor === input.amount_minor &&
          existing.repayment_method === input.method &&
          existing.reference === input.reference &&
          links.length === 1 &&
          link?.adjustment_id === input.adjustment_id &&
          link.amount_minor === input.amount_minor;

        if (!matches) {
          return {
            ok: false,
            status: 409,
            error: "This request key was already used for different recovery details.",
          } as const;
        }

        return {
          ok: true,
          replayed: true,
          recoveryId: existing.id,
        } as const;
      }

      const adjustment = db.prepare(`
        SELECT
          psa.adjustment_minor,
          psa.status,
          COALESCE((
            SELECT SUM(ri.amount_minor)
            FROM provider_adjustment_recovery_items ri
            WHERE ri.adjustment_id = psa.id
          ), 0) AS recovered_minor
        FROM provider_settlement_adjustments psa
        JOIN provider_settlements ps ON ps.id = psa.settlement_id
        WHERE psa.id = ?
          AND ps.provider_type = 'DOCTOR'
          AND ps.doctor_id = ?
      `).get(input.adjustment_id, doctorId.data) as {
        adjustment_minor: number;
        status: string;
        recovered_minor: number;
      } | undefined;

      if (!adjustment) {
        return {
          ok: false,
          status: 404,
          error: "Adjustment not found for this doctor.",
        } as const;
      }

      const remaining =
        adjustment.adjustment_minor - adjustment.recovered_minor;

      if (
        adjustment.status !== "PENDING" ||
        input.amount_minor > remaining
      ) {
        return {
          ok: false,
          status: 409,
          error: "The adjustment is not pending or the repayment exceeds its remaining balance.",
        } as const;
      }

      const recoveryId = randomUUID();

      db.prepare(`
        INSERT INTO provider_adjustment_recoveries (
          id, request_key, doctor_id, recovery_kind,
          amount_minor, repayment_method, reference, created_by
        )
        VALUES (?, ?, ?, 'REPAYMENT', ?, ?, ?, ?)
      `).run(
        recoveryId,
        input.request_key,
        doctorId.data,
        input.amount_minor,
        input.method,
        input.reference,
        user.id,
      );

      db.prepare(`
        INSERT INTO provider_adjustment_recovery_items (
          id, recovery_id, adjustment_id, amount_minor
        )
        VALUES (?, ?, ?, ?)
      `).run(
        randomUUID(),
        recoveryId,
        input.adjustment_id,
        input.amount_minor,
      );

      if (input.amount_minor === remaining) {
        db.prepare(`
          UPDATE provider_settlement_adjustments
          SET status = 'APPLIED'
          WHERE id = ?
        `).run(input.adjustment_id);
      }

      db.prepare(`
        INSERT INTO audit_logs (
          user_id, action, entity_type, entity_id, details_json
        )
        VALUES (?, 'CREATE', 'PROVIDER_ADJUSTMENT_RECOVERY', ?, ?)
      `).run(user.id, recoveryId, JSON.stringify({
        doctor_id: doctorId.data,
        recovery_kind: "REPAYMENT",
        ...input,
      }));

      return {
        ok: true,
        replayed: false,
        recoveryId,
      } as const;
    });

    const result = recordRepayment.immediate();

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(result.replayed ? 200 : 201).json({
      recovery: {
        id: result.recoveryId,
        doctor_id: doctorId.data,
        ...input,
      },
      replayed: result.replayed,
    });
  },
);

router.get("/doctors/:doctorId/adjustment-recoveries", requireAuth, (req, res) => {
  const parsed = uuidSchema.safeParse(req.params.doctorId);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid doctor ID." });
    return;
  }

  const doctor = db.prepare(`
    SELECT id
    FROM doctors
    WHERE id = ?
  `).get(parsed.data) as { id: string } | undefined;

  if (!doctor) {
    res.status(404).json({ error: "Doctor not found." });
    return;
  }

  const recoveries = db.prepare(`
    SELECT
      r.id,
      r.request_key,
      r.recovery_kind,
      r.amount_minor,
      r.target_settlement_id,
      r.repayment_method,
      r.reference,
      r.cash_session_id,
      r.created_by,
      r.created_at,
      COALESCE((
        SELECT SUM(ri.amount_minor)
        FROM provider_adjustment_recovery_items ri
        WHERE ri.recovery_id = r.id
      ), 0) AS allocated_minor
    FROM provider_adjustment_recoveries r
    WHERE r.doctor_id = ?
    ORDER BY r.created_at, r.id
  `).all(doctor.id) as Array<{
    id: string;
    request_key: string;
    recovery_kind: "PAYOUT_DEDUCTION" | "REPAYMENT";
    amount_minor: number;
    target_settlement_id: string | null;
    repayment_method: string | null;
    reference: string | null;
    cash_session_id: string | null;
    created_by: string;
    created_at: string;
    allocated_minor: number;
  }>;

  res.json({
    doctor_id: doctor.id,
    recoveries,
    total_recovered_minor: recoveries.reduce(
      (total, recovery) => total + recovery.amount_minor,
      0,
    ),
  });
});

export default router;
