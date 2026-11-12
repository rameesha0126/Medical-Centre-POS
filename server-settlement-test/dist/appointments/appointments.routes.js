import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth } from "../auth/auth.routes.js";
const router = Router();
const dateSchema = z.string().refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const date = new Date(`${value}T00:00:00Z`);
    return (!Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value);
}, "Date must be a valid YYYY-MM-DD date.");
const createAppointmentSchema = z.object({
    patient_id: z.string().uuid(),
    doctor_id: z.string().uuid(),
    appointment_date: dateSchema,
    doctor_session_id: z.string().uuid().optional(),
    booking_source: z.enum([
        "PHONE",
        "MESSAGE",
        "WALK_IN",
        "IN_PERSON",
    ]),
    notes: z.string().trim().max(500).nullable().optional(),
});
const updateAppointmentSchema = z.object({
    status: z.enum([
        "ARRIVED",
        "WAITING",
        "READY",
        "IN_CONSULTATION",
        "COMPLETED",
        "CANCELLED",
        "NO_SHOW",
    ]),
});
function doctorExists(doctorId) {
    return Boolean(db.prepare(`
      SELECT id
      FROM doctors
      WHERE id = ? AND is_active = 1
    `).get(doctorId));
}
function patientExists(patientId) {
    return Boolean(db.prepare(`
      SELECT id
      FROM patients
      WHERE id = ?
    `).get(patientId));
}
// Determine whether the doctor has an available session on this date.
// A CANCELLED exception overrides the weekly schedule.
// A CHANGED exception replaces the normal schedule for that date.
// An ADDED exception makes an additional session available.
function getScheduleAvailability(doctorId, appointmentDate) {
    const exception = db.prepare(`
    SELECT id, status
    FROM schedule_exceptions
    WHERE doctor_id = ? AND session_date = ?
  `).get(doctorId, appointmentDate);
    if (exception?.status === "CANCELLED") {
        return { available: false, exceptionId: exception.id };
    }
    if (exception?.status === "CHANGED") {
        return { available: true, exceptionId: exception.id };
    }
    const dayOfWeek = new Date(`${appointmentDate}T00:00:00Z`).getUTCDay();
    const weeklySchedule = db.prepare(`
    SELECT id
    FROM doctor_schedules
    WHERE doctor_id = ?
      AND day_of_week = ?
      AND is_active = 1
      AND (effective_from IS NULL OR effective_from <= ?)
      AND (effective_until IS NULL OR effective_until >= ?)
    LIMIT 1
  `).get(doctorId, dayOfWeek, appointmentDate, appointmentDate);
    if (weeklySchedule) {
        return {
            available: true,
            exceptionId: exception?.id ?? null,
        };
    }
    if (exception?.status === "ADDED") {
        return { available: true, exceptionId: exception.id };
    }
    return { available: false, exceptionId: null };
}
// GET /api/appointments?date=YYYY-MM-DD&doctorId=...
// Retrieve appointments for a date, optionally filtered by doctor.
router.get("/", requireAuth, (req, res) => {
    const date = req.query.date;
    const doctorId = req.query.doctorId;
    if (typeof date !== "string" || !dateSchema.safeParse(date).success) {
        res.status(400).json({
            error: "A valid date parameter is required (YYYY-MM-DD).",
        });
        return;
    }
    if (doctorId !== undefined &&
        (typeof doctorId !== "string" ||
            !z.string().uuid().safeParse(doctorId).success)) {
        res.status(400).json({ error: "Invalid doctorId parameter." });
        return;
    }
    const appointments = db.prepare(`
    SELECT
      a.id,
      a.patient_id,
      p.full_name AS patient_name,
      p.phone AS patient_phone,
      a.doctor_id,
      d.full_name AS doctor_name,
      a.schedule_exception_id,
      a.appointment_date,
      a.queue_number,
      a.doctor_session_id,
      a.booking_source,
      a.status,
      a.notes,
      a.created_at,
      a.updated_at
    FROM appointments a
    INNER JOIN patients p ON p.id = a.patient_id
    INNER JOIN doctors d ON d.id = a.doctor_id
    WHERE a.appointment_date = ?
      AND (? IS NULL OR a.doctor_id = ?)
    ORDER BY d.full_name COLLATE NOCASE, a.queue_number
  `).all(date, doctorId ?? null, doctorId ?? null);
    res.json({ appointments });
});
// POST /api/appointments
// Owner and staff can book appointments.
router.post("/", requireAuth, (req, res) => {
    const parsed = createAppointmentSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid appointment details.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const data = parsed.data;
    if (!patientExists(data.patient_id)) {
        res.status(404).json({ error: "Patient not found." });
        return;
    }
    if (!doctorExists(data.doctor_id)) {
        res.status(404).json({ error: "Active doctor not found." });
        return;
    }
    const availability = getScheduleAvailability(data.doctor_id, data.appointment_date);
    if (!availability.available) {
        res.status(409).json({
            error: "The doctor has no available session on this date.",
        });
        return;
    }
    const user = res.locals.user;
    const appointmentId = randomUUID();
    try {
        // Use an immediate transaction so simultaneous bookings
        // cannot allocate the same queue number.
        const createAppointment = db.transaction(() => {
            // Find sessions for this doctor and date that
            // can still accept appointment assignments.
            const allSessions = db.prepare(`
      SELECT
        id,
        start_time,
        end_time,
        status
      FROM doctor_sessions
      WHERE doctor_id = ?
        AND session_date = ?
      ORDER BY start_time
    `).all(data.doctor_id, data.appointment_date);
            const availableSessions = allSessions.filter((session) => session.status === "SCHEDULED" ||
                session.status === "ACTIVE");
            let doctorSessionId = null;
            if (data.doctor_session_id) {
                const selectedSession = availableSessions.find((session) => session.id === data.doctor_session_id);
                if (!selectedSession) {
                    return {
                        success: false,
                        status: 409,
                        error: "The selected doctor session is not available for this doctor and date.",
                    };
                }
                doctorSessionId = selectedSession.id;
            }
            else if (availableSessions.length === 1) {
                const session = availableSessions[0];
                if (session) {
                    doctorSessionId = session.id;
                }
            }
            else if (availableSessions.length > 1) {
                return {
                    success: false,
                    status: 409,
                    error: "Multiple doctor sessions are available. Select a doctor_session_id.",
                    sessions: availableSessions,
                };
            }
            else if (allSessions.length > 0) {
                // Sessions exist, but none can accept bookings.
                // Do not silently create an unlinked appointment.
                return {
                    success: false,
                    status: 409,
                    error: "Doctor sessions exist for this date, but none are available for booking.",
                };
            }
            // If no doctor session exists at all,
            // advance booking remains permitted with NULL session ID.
            // No session created yet:
            // allow advance booking with a NULL session ID.
            // Preserve the existing queue-numbering rule:
            // one continuous queue per doctor per day.
            const result = db.prepare(`
        SELECT
          COALESCE(MAX(queue_number), 0) + 1
            AS next_number
        FROM appointments
        WHERE doctor_id = ?
          AND appointment_date = ?
      `).get(data.doctor_id, data.appointment_date);
            const queueNumber = result.next_number;
            db.prepare(`
        INSERT INTO appointments (
          id,
          patient_id,
          doctor_id,
          schedule_exception_id,
          appointment_date,
          queue_number,
          doctor_session_id,
          booking_source,
          status,
          notes,
          created_by
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          'BOOKED', ?, ?
        )
      `).run(appointmentId, data.patient_id, data.doctor_id, availability.exceptionId, data.appointment_date, queueNumber, doctorSessionId, data.booking_source, data.notes ?? null, user.id);
            return {
                success: true,
                queueNumber,
                doctorSessionId,
            };
        });
        const result = createAppointment.immediate();
        if (!result.success) {
            res.status(result.status).json({
                error: result.error,
                ...("sessions" in result
                    ? { sessions: result.sessions }
                    : {}),
            });
            return;
        }
        const appointment = db.prepare(`
      SELECT
        a.id,
        a.patient_id,
        p.full_name AS patient_name,
        p.phone AS patient_phone,
        a.doctor_id,
        d.full_name AS doctor_name,
        a.schedule_exception_id,
        a.appointment_date,
        a.queue_number,
        a.doctor_session_id,
        a.booking_source,
        a.status,
        a.notes,
        a.created_at,
        a.updated_at
      FROM appointments a
      INNER JOIN patients p ON p.id = a.patient_id
      INNER JOIN doctors d ON d.id = a.doctor_id
      WHERE a.id = ?
    `).get(appointmentId);
        res.status(201).json({
            message: "Appointment created successfully.",
            appointment,
        });
    }
    catch (error) {
        console.error("Appointment creation failed:", error);
        res.status(500).json({
            error: "Could not create appointment.",
        });
    }
});
// PATCH /api/appointments/:id/status
// Owner and staff can update appointment status.
// A consultation requires a fully paid consultation invoice.
router.patch("/:id/status", requireAuth, (req, res) => {
    const appointmentId = req.params.id;
    if (typeof appointmentId !== "string" ||
        !z.string().uuid().safeParse(appointmentId).success) {
        res.status(400).json({ error: "Invalid appointment ID." });
        return;
    }
    const parsed = updateAppointmentSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid appointment status.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const nextStatus = parsed.data.status;
    const allowedTransitions = {
        BOOKED: ["ARRIVED", "CANCELLED", "NO_SHOW"],
        ARRIVED: ["WAITING", "CANCELLED", "NO_SHOW"],
        WAITING: ["READY", "CANCELLED", "NO_SHOW"],
        READY: ["IN_CONSULTATION", "CANCELLED", "NO_SHOW"],
        IN_CONSULTATION: ["COMPLETED"],
        COMPLETED: [],
        CANCELLED: [],
        NO_SHOW: [],
    };
    try {
        const updateStatus = db.transaction(() => {
            const appointment = db.prepare(`
        SELECT
          id,
          status,
          doctor_id,
          appointment_date,
          doctor_session_id
        FROM appointments
        WHERE id = ?
      `).get(appointmentId);
            if (!appointment) {
                return {
                    success: false,
                    status: 404,
                    error: "Appointment not found.",
                };
            }
            // Prevent changes to appointments belonging to
            // completed or cancelled doctor sessions.
            if (appointment.doctor_session_id) {
                const session = db.prepare(`
          SELECT status
          FROM doctor_sessions
          WHERE id = ?
        `).get(appointment.doctor_session_id);
                if (!session ||
                    session.status === "COMPLETED" ||
                    session.status === "CANCELLED") {
                    return {
                        success: false,
                        status: 409,
                        error: "Appointment status cannot be changed because its doctor session is closed or unavailable.",
                    };
                }
            }
            else {
                // Also protect unlinked appointments when
                // every existing session for the date is closed.
                const sessionCounts = db.prepare(`
          SELECT
            COUNT(*) AS total,
            COALESCE(SUM(
              CASE
                WHEN status IN ('SCHEDULED', 'ACTIVE')
                THEN 1 ELSE 0
              END
            ), 0) AS available
          FROM doctor_sessions
          WHERE doctor_id = ?
            AND session_date = ?
        `).get(appointment.doctor_id, appointment.appointment_date);
                if (sessionCounts.total > 0 &&
                    sessionCounts.available === 0) {
                    return {
                        success: false,
                        status: 409,
                        error: "Appointment status cannot be changed because all doctor sessions for this date are closed.",
                    };
                }
            }
            if (!allowedTransitions[appointment.status]?.includes(nextStatus)) {
                return {
                    success: false,
                    status: 409,
                    error: `Cannot change appointment from ${appointment.status} to ${nextStatus}.`,
                };
            }
            // A consultation must have a fully paid invoice.
            if (nextStatus === "IN_CONSULTATION") {
                if (!appointment.doctor_session_id) {
                    return {
                        success: false,
                        status: 409,
                        error: "Appointment must be assigned to a doctor session before consultation can begin.",
                    };
                }
                const consultationSession = db.prepare(`
          SELECT
            id,
            doctor_id,
            session_date,
            status
          FROM doctor_sessions
          WHERE id = ?
        `).get(appointment.doctor_session_id);
                if (!consultationSession ||
                    consultationSession.doctor_id !== appointment.doctor_id ||
                    consultationSession.session_date !== appointment.appointment_date) {
                    return {
                        success: false,
                        status: 409,
                        error: "Appointment is not associated with a valid doctor session.",
                    };
                }
                if (consultationSession.status !== "ACTIVE") {
                    return {
                        success: false,
                        status: 409,
                        error: "The doctor session must be ACTIVE before consultation can begin.",
                    };
                }
                const invoice = db.prepare(`
          SELECT id, invoice_number, status, total_minor
          FROM invoices
          WHERE appointment_id = ?
            AND status != 'CANCELLED'
          ORDER BY created_at DESC
          LIMIT 1
        `).get(appointmentId);
                if (!invoice) {
                    return {
                        success: false,
                        status: 409,
                        error: "A consultation invoice must be created before the consultation can begin.",
                    };
                }
                if (invoice.status !== "PAID") {
                    return {
                        success: false,
                        status: 409,
                        error: "The consultation invoice must be fully paid before the consultation can begin.",
                        invoice_status: invoice.status,
                        invoice_number: invoice.invoice_number,
                    };
                }
            }
            db.prepare(`
        UPDATE appointments
        SET status = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(nextStatus, appointmentId);
            return {
                success: true,
            };
        });
        // Immediate transaction prevents payment/refund changes
        // from racing with the consultation payment check.
        const result = updateStatus.immediate();
        if (!result.success) {
            res.status(result.status).json({
                error: result.error,
                ...("invoice_status" in result
                    ? {
                        invoice_status: result.invoice_status,
                        invoice_number: result.invoice_number,
                    }
                    : {}),
            });
            return;
        }
        const updatedAppointment = db.prepare(`
      SELECT
        a.id,
        a.patient_id,
        p.full_name AS patient_name,
        p.phone AS patient_phone,
        a.doctor_id,
        d.full_name AS doctor_name,
        a.appointment_date,
        a.queue_number,
        a.doctor_session_id,
        a.booking_source,
        a.status,
        a.notes,
        a.created_at,
        a.updated_at
      FROM appointments a
      INNER JOIN patients p ON p.id = a.patient_id
      INNER JOIN doctors d ON d.id = a.doctor_id
      WHERE a.id = ?
    `).get(appointmentId);
        res.json({
            message: "Appointment status updated.",
            appointment: updatedAppointment,
        });
    }
    catch (error) {
        console.error("Appointment status update failed:", error);
        res.status(500).json({
            error: "Could not update appointment status.",
        });
    }
});
export default router;
//# sourceMappingURL=appointments.routes.js.map