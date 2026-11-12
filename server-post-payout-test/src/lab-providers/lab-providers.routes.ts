
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth, requireOwner } from "../auth/auth.routes.js";

const router = Router();

const providerSchema = z.object({
  name: z.string().trim().min(2).max(150),
  phone: z.string().trim().max(30).nullable().optional(),
  contact_person: z.string().trim().max(150).nullable().optional(),
  default_provider_share_basis_points: z.number().int().min(0).max(10000),
});

const providerUpdateSchema = providerSchema.extend({
  is_active: z.boolean().optional(),
}).partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Provide at least one field to update." },
);

router.get("/", requireAuth, (req, res) => {
  const user = res.locals.user as { role: "OWNER" | "STAFF" };
  const includeInactive =
    user.role === "OWNER" && req.query.includeInactive === "true";

  const providers = db.prepare(`
    SELECT id, name, phone, contact_person,
           default_provider_share_basis_points,
           is_active, created_at, updated_at
    FROM lab_providers
    ${includeInactive ? "" : "WHERE is_active = 1"}
    ORDER BY name COLLATE NOCASE
  `).all();

  res.json({ providers });
});

router.post("/", requireAuth, requireOwner, (req, res) => {
  const parsed = providerSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid laboratory provider details.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const id = randomUUID();
  const data = parsed.data;

  db.prepare(`
    INSERT INTO lab_providers (
      id, name, phone, contact_person,
      default_provider_share_basis_points
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.phone?.trim() || null,
    data.contact_person?.trim() || null,
    data.default_provider_share_basis_points,
  );

  const provider = db.prepare(`
    SELECT id, name, phone, contact_person,
           default_provider_share_basis_points,
           is_active, created_at, updated_at
    FROM lab_providers
    WHERE id = ?
  `).get(id);

  res.status(201).json({ provider });
});

router.patch("/:id", requireAuth, requireOwner, (req, res) => {
  const providerId = req.params.id;

  if (typeof providerId !== "string" || providerId.length === 0) {
    res.status(400).json({ error: "Invalid provider ID." });
    return;
  }

  const parsed = providerUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid laboratory provider details.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const existing = db.prepare(
    "SELECT id FROM lab_providers WHERE id = ?",
  ).get(providerId);

  if (!existing) {
    res.status(404).json({ error: "Laboratory provider not found." });
    return;
  }

  const fields = parsed.data;

  if (fields.is_active === false) {
    const assigned = db.prepare(`
      SELECT COUNT(*) AS count
      FROM services
      WHERE lab_provider_id = ?
        AND service_type = 'LAB'
        AND is_active = 1
    `).get(providerId) as { count: number };

    if (assigned.count > 0) {
      res.status(409).json({
        error: "This provider is assigned to active laboratory services. Reassign or deactivate those services first.",
      });
      return;
    }
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (fields.name !== undefined) {
    updates.push("name = ?");
    values.push(fields.name);
  }

  if (fields.phone !== undefined) {
    updates.push("phone = ?");
    values.push(fields.phone?.trim() || null);
  }

  if (fields.contact_person !== undefined) {
    updates.push("contact_person = ?");
    values.push(fields.contact_person?.trim() || null);
  }

  if (fields.default_provider_share_basis_points !== undefined) {
    updates.push("default_provider_share_basis_points = ?");
    values.push(fields.default_provider_share_basis_points);
  }

  if (fields.is_active !== undefined) {
    updates.push("is_active = ?");
    values.push(fields.is_active ? 1 : 0);
  }

  updates.push("updated_at = datetime('now')");
  values.push(providerId);

  db.prepare(`
    UPDATE lab_providers
    SET ${updates.join(", ")}
    WHERE id = ?
  `).run(...values);

  const provider = db.prepare(`
    SELECT id, name, phone, contact_person,
           default_provider_share_basis_points,
           is_active, created_at, updated_at
    FROM lab_providers
    WHERE id = ?
  `).get(providerId);

  res.json({ provider });
});

export default router;
