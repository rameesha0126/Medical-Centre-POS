import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth, requireOwner } from "../auth/auth.routes.js";
const router = Router();
const doctorSchema = z.object({
    full_name: z.string().trim().min(2).max(150),
    phone: z.string().trim().max(30).nullable().optional(),
    consultation_fee_minor: z.number().int().min(0).max(100_000_000).default(0),
});
const doctorUpdateSchema = doctorSchema
    .extend({
    is_active: z.boolean().optional(),
})
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update.",
});
// List doctors. Staff only see active doctors.
router.get("/", requireAuth, (req, res) => {
    const user = res.locals.user;
    const includeInactive = user.role === "OWNER" && req.query.includeInactive === "true";
    const doctors = includeInactive
        ? db.prepare(`
        SELECT id, full_name, phone, consultation_fee_minor,
               is_active, created_at, updated_at
        FROM doctors
        ORDER BY full_name COLLATE NOCASE
      `).all()
        : db.prepare(`
        SELECT id, full_name, phone, consultation_fee_minor,
               is_active, created_at, updated_at
        FROM doctors
        WHERE is_active = 1
        ORDER BY full_name COLLATE NOCASE
      `).all();
    res.json({ doctors });
});
// Create a doctor. Owner only.
router.post("/", requireAuth, requireOwner, (req, res) => {
    const parsed = doctorSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid doctor details.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const id = randomUUID();
    const { full_name, consultation_fee_minor } = parsed.data;
    const phone = parsed.data.phone?.trim() || null;
    db.prepare(`
    INSERT INTO doctors (
      id, full_name, phone, consultation_fee_minor, is_active
    )
    VALUES (?, ?, ?, ?, 1)
  `).run(id, full_name, phone, consultation_fee_minor);
    const doctor = db.prepare(`
    SELECT id, full_name, phone, consultation_fee_minor,
           is_active, created_at, updated_at
    FROM doctors
    WHERE id = ?
  `).get(id);
    res.status(201).json({ doctor });
});
// Update a doctor. Owner only.
router.patch("/:id", requireAuth, requireOwner, (req, res) => {
    const doctorId = req.params.id;
    if (typeof doctorId !== "string" || doctorId.length === 0) {
        res.status(400).json({ error: "Invalid doctor ID." });
        return;
    }
    const parsed = doctorUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid doctor details.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const existing = db.prepare("SELECT id FROM doctors WHERE id = ?").get(doctorId);
    if (!existing) {
        res.status(404).json({ error: "Doctor not found." });
        return;
    }
    const fields = parsed.data;
    const updates = [];
    const values = [];
    if (fields.full_name !== undefined) {
        updates.push("full_name = ?");
        values.push(fields.full_name);
    }
    if (fields.phone !== undefined) {
        updates.push("phone = ?");
        values.push(fields.phone?.trim() || null);
    }
    if (fields.consultation_fee_minor !== undefined) {
        updates.push("consultation_fee_minor = ?");
        values.push(fields.consultation_fee_minor);
    }
    if (fields.is_active !== undefined) {
        updates.push("is_active = ?");
        values.push(fields.is_active ? 1 : 0);
    }
    updates.push("updated_at = datetime('now')");
    values.push(doctorId);
    db.prepare(`
    UPDATE doctors
    SET ${updates.join(", ")}
    WHERE id = ?
  `).run(...values);
    const doctor = db.prepare(`
    SELECT id, full_name, phone, consultation_fee_minor,
           is_active, created_at, updated_at
    FROM doctors
    WHERE id = ?
  `).get(doctorId);
    res.json({ doctor });
});
export default router;
//# sourceMappingURL=doctors.routes.js.map