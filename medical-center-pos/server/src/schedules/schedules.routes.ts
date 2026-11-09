
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth, requireOwner } from "../auth/auth.routes.js";

const router = Router();

const timeSchema = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d$/,
  "Time must use HH:MM format.",
);

const dateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}, "Date must be a valid YYYY-MM-DD date.");

const scheduleSchema = z.object({
  doctor_id: z.string().uuid(),
  day_of_week: z.number().int().min(0).max(6),
  start_time: timeSchema,
  end_time: timeSchema,
  effective_from: dateSchema.nullable().optional(),
  effective_until: dateSchema.nullable().optional(),
}).refine((value) => value.start_time < value.end_time, {
  message: "End time must be later than start time.",
  path: ["end_time"],
}).refine(
  (value) =>
    !value.effective_from ||
    !value.effective_until ||
    value.effective_from <= value.effective_until,
  {
    message: "Effective-until date cannot be before effective-from date.",
    path: ["effective_until"],
  },
);

const scheduleUpdateSchema = z.object({
  start_time: timeSchema.optional(),
  end_time: timeSchema.optional(),
  effective_from: dateSchema.nullable().optional(),
  effective_until: dateSchema.nullable().optional(),
  is_active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "Provide at least one field to update.",
});

const exceptionSchema = z.object({
  doctor_id: z.string().uuid(),
  session_date: dateSchema,
  status: z.enum(["CHANGED", "CANCELLED", "ADDED"]),
  start_time: timeSchema.nullable().optional(),
  end_time: timeSchema.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
}).superRefine((value, context) => {
  if (value.status === "CANCELLED") {
    if (value.start_time != null || value.end_time != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A cancelled session must not have start or end times.",
      });
    }
    return;
  }

  if (!value.start_time || !value.end_time) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Start and end times are required for this exception.",
    });
    return;
  }

  if (value.start_time >= value.end_time) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "End time must be later than start time.",
      path: ["end_time"],
    });
  }
});

type ScheduleRow = {
  id: string;
  doctor_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  effective_from: string | null;
  effective_until: string | null;
  is_active: number;
};

function doctorExists(doctorId: string): boolean {
  return Boolean(
    db.prepare("SELECT id FROM doctors WHERE id = ? AND is_active = 1")
      .get(doctorId),
  );
}

function dateRangesOverlap(
  fromA: string | null,
  untilA: string | null,
  fromB: string | null,
  untilB: string | null,
): boolean {
  const startA = fromA ?? "0000-01-01";
  const endA = untilA ?? "9999-12-31";
  const startB = fromB ?? "0000-01-01";
  const endB = untilB ?? "9999-12-31";

  return startA <= endB && startB <= endA;
}

function hasScheduleConflict(
  doctorId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  effectiveFrom: string | null,
  effectiveUntil: string | null,
  excludeId?: string,
): boolean {
  const existing = db.prepare(`
    SELECT id, start_time, end_time, effective_from, effective_until
    FROM doctor_schedules
    WHERE doctor_id = ?
      AND day_of_week = ?
      AND is_active = 1
      AND (? IS NULL OR id != ?)
  `).all(
    doctorId,
    dayOfWeek,
    excludeId ?? null,
    excludeId ?? null,
  ) as Array<{
    id: string;
    start_time: string;
    end_time: string;
    effective_from: string | null;
    effective_until: string | null;
  }>;

  return existing.some((schedule) => {
    const datesOverlap = dateRangesOverlap(
      effectiveFrom,
      effectiveUntil,
      schedule.effective_from,
      schedule.effective_until,
    );

    const timesOverlap =
      startTime < schedule.end_time &&
      schedule.start_time < endTime;

    return datesOverlap && timesOverlap;
  });
}

// GET /api/schedules/doctor/:doctorId
// Authenticated owner and staff can view weekly schedules.
router.get("/doctor/:doctorId", requireAuth, (req, res) => {
  const doctorId = req.params.doctorId;

  if (typeof doctorId !== "string" || !z.string().uuid().safeParse(doctorId).success) {
    res.status(400).json({ error: "Invalid doctor ID." });
    return;
  }

  const includeInactive =
    (res.locals.user as { role: string }).role === "OWNER" &&
    req.query.includeInactive === "true";

  const schedules = includeInactive
    ? db.prepare(`
        SELECT id, doctor_id, day_of_week, start_time, end_time,
               effective_from, effective_until, is_active
        FROM doctor_schedules
        WHERE doctor_id = ?
        ORDER BY day_of_week, start_time
      `).all(doctorId)
    : db.prepare(`
        SELECT id, doctor_id, day_of_week, start_time, end_time,
               effective_from, effective_until, is_active
        FROM doctor_schedules
        WHERE doctor_id = ? AND is_active = 1
        ORDER BY day_of_week, start_time
      `).all(doctorId);

  res.json({ schedules });
});

// POST /api/schedules
// Owner only: create a weekly schedule.
router.post("/", requireAuth, requireOwner, (req, res) => {
  const parsed = scheduleSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid schedule details.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;

  if (!doctorExists(data.doctor_id)) {
    res.status(404).json({ error: "Active doctor not found." });
    return;
  }

  const effectiveFrom = data.effective_from ?? null;
  const effectiveUntil = data.effective_until ?? null;

  if (hasScheduleConflict(
    data.doctor_id,
    data.day_of_week,
    data.start_time,
    data.end_time,
    effectiveFrom,
    effectiveUntil,
  )) {
    res.status(409).json({
      error: "This schedule overlaps an existing active schedule.",
    });
    return;
  }

  const id = randomUUID();

  db.prepare(`
    INSERT INTO doctor_schedules (
      id, doctor_id, day_of_week, start_time, end_time,
      effective_from, effective_until, is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    data.doctor_id,
    data.day_of_week,
    data.start_time,
    data.end_time,
    effectiveFrom,
    effectiveUntil,
  );

  const schedule = db.prepare(`
    SELECT id, doctor_id, day_of_week, start_time, end_time,
           effective_from, effective_until, is_active
    FROM doctor_schedules
    WHERE id = ?
  `).get(id);

  res.status(201).json({ schedule });
});

// PATCH /api/schedules/:id
// Owner only: update or deactivate a weekly schedule.
router.patch("/:id", requireAuth, requireOwner, (req, res) => {
  const scheduleId = req.params.id;

  if (typeof scheduleId !== "string" || !z.string().uuid().safeParse(scheduleId).success) {
    res.status(400).json({ error: "Invalid schedule ID." });
    return;
  }

  const parsed = scheduleUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid schedule update.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const existing = db.prepare(`
    SELECT id, doctor_id, day_of_week, start_time, end_time,
           effective_from, effective_until, is_active
    FROM doctor_schedules
    WHERE id = ?
  `).get(scheduleId) as ScheduleRow | undefined;

  if (!existing) {
    res.status(404).json({ error: "Schedule not found." });
    return;
  }

  const fields = parsed.data;

  const nextStart = fields.start_time ?? existing.start_time;
  const nextEnd = fields.end_time ?? existing.end_time;
  const nextFrom = fields.effective_from === undefined
    ? existing.effective_from
    : fields.effective_from;
  const nextUntil = fields.effective_until === undefined
    ? existing.effective_until
    : fields.effective_until;
  const nextActive = fields.is_active ?? Boolean(existing.is_active);

  if (nextStart >= nextEnd) {
    res.status(400).json({
      error: "End time must be later than start time.",
    });
    return;
  }

  if (nextFrom && nextUntil && nextFrom > nextUntil) {
    res.status(400).json({
      error: "Effective-until date cannot be before effective-from date.",
    });
    return;
  }

  if (
    nextActive &&
    hasScheduleConflict(
      existing.doctor_id,
      existing.day_of_week,
      nextStart,
      nextEnd,
      nextFrom,
      nextUntil,
      scheduleId,
    )
  ) {
    res.status(409).json({
      error: "This update overlaps another active schedule.",
    });
    return;
  }

  db.prepare(`
    UPDATE doctor_schedules
    SET start_time = ?,
        end_time = ?,
        effective_from = ?,
        effective_until = ?,
        is_active = ?
    WHERE id = ?
  `).run(
    nextStart,
    nextEnd,
    nextFrom,
    nextUntil,
    nextActive ? 1 : 0,
    scheduleId,
  );

  const schedule = db.prepare(`
    SELECT id, doctor_id, day_of_week, start_time, end_time,
           effective_from, effective_until, is_active
    FROM doctor_schedules
    WHERE id = ?
  `).get(scheduleId);

  res.json({ schedule });
});

// GET /api/schedules/exceptions?doctorId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// Authenticated owner and staff can view exceptions.
router.get("/exceptions", requireAuth, (req, res) => {
  const doctorId = req.query.doctorId;
  const from = req.query.from;
  const to = req.query.to;

  if (typeof doctorId !== "string" || !z.string().uuid().safeParse(doctorId).success) {
    res.status(400).json({ error: "A valid doctorId is required." });
    return;
  }

  if (
    (from !== undefined &&
      (typeof from !== "string" || !dateSchema.safeParse(from).success)) ||
    (to !== undefined &&
      (typeof to !== "string" || !dateSchema.safeParse(to).success))
  ) {
    res.status(400).json({
      error: "Dates must use valid YYYY-MM-DD format.",
    });
    return;
  }

  if (typeof from === "string" && typeof to === "string" && from > to) {
    res.status(400).json({ error: "The from date must not be after the to date." });
    return;
  }

  const exceptions = db.prepare(`
    SELECT id, doctor_id, session_date, start_time, end_time,
           status, notes, created_by, created_at
    FROM schedule_exceptions
    WHERE doctor_id = ?
      AND (? IS NULL OR session_date >= ?)
      AND (? IS NULL OR session_date <= ?)
    ORDER BY session_date
  `).all(
    doctorId,
    from ?? null, from ?? null,
    to ?? null, to ?? null,
  );

  res.json({ exceptions });
});

// POST /api/schedules/exceptions
// Owner only: create a date-specific schedule exception.
router.post("/exceptions", requireAuth, requireOwner, (req, res) => {
  const parsed = exceptionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid schedule exception.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;

  if (!doctorExists(data.doctor_id)) {
    res.status(404).json({ error: "Active doctor not found." });
    return;
  }

  const existing = db.prepare(`
    SELECT id
    FROM schedule_exceptions
    WHERE doctor_id = ? AND session_date = ?
  `).get(data.doctor_id, data.session_date);

  if (existing) {
    res.status(409).json({
      error: "An exception already exists for this doctor on this date.",
    });
    return;
  }

  const id = randomUUID();
  const user = res.locals.user as { id: string };

  db.prepare(`
    INSERT INTO schedule_exceptions (
      id, doctor_id, session_date, start_time, end_time,
      status, notes, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.doctor_id,
    data.session_date,
    data.status === "CANCELLED" ? null : data.start_time,
    data.status === "CANCELLED" ? null : data.end_time,
    data.status,
    data.notes ?? null,
    user.id,
  );

  const exception = db.prepare(`
    SELECT id, doctor_id, session_date, start_time, end_time,
           status, notes, created_by, created_at
    FROM schedule_exceptions
    WHERE id = ?
  `).get(id);

  res.status(201).json({ exception });
});

export default router;
