
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

export default router;
