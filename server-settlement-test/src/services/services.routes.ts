
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth, requireOwner } from "../auth/auth.routes.js";

const router = Router();

const serviceSchema = z.object({
  name: z.string().trim().min(2).max(150),
  service_type: z.enum(["CONSULTATION", "LAB", "PROCEDURE"]),
  default_price_minor: z.number().int().min(0).max(100_000_000),
  requires_full_payment: z.boolean().default(true),
  lab_provider_id: z.string().uuid().nullable().optional(),
});

const serviceUpdateSchema = serviceSchema.partial().extend({
  is_active: z.boolean().optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  { message: "Provide at least one field to update." },
);

function validateProvider(
  serviceType: string,
  providerId: string | null | undefined,
): string | null {
  if (serviceType !== "LAB" && providerId) {
    return "Only laboratory services can be assigned to a laboratory provider.";
  }

  if (serviceType === "LAB" && !providerId) {
    return "A laboratory provider must be assigned to every laboratory service.";
  }

  if (serviceType === "LAB" && providerId) {
    const provider = db.prepare(`
      SELECT id FROM lab_providers
      WHERE id = ? AND is_active = 1
    `).get(providerId);

    if (!provider) {
      return "The selected laboratory provider does not exist or is inactive.";
    }
  }

  return null;
}

// List services. Staff only see active services.
router.get("/", requireAuth, (req, res) => {
  const user = res.locals.user as { role: "OWNER" | "STAFF" };
  const includeInactive =
    user.role === "OWNER" && req.query.includeInactive === "true";

  const services = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.service_type,
      s.default_price_minor,
      s.requires_full_payment,
      s.is_active,
      s.lab_provider_id,
      lp.name AS lab_provider_name,
      lp.default_provider_share_basis_points,
      s.created_at,
      s.updated_at
    FROM services s
    LEFT JOIN lab_providers lp ON lp.id = s.lab_provider_id
    ${includeInactive ? "" : "WHERE s.is_active = 1"}
    ORDER BY s.service_type, s.name COLLATE NOCASE
  `).all();

  res.json({ services });
});

// Create service. Owner only.
router.post("/", requireAuth, requireOwner, (req, res) => {
  const parsed = serviceSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid service details.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;
  const providerId = data.lab_provider_id ?? null;

  const providerError = validateProvider(data.service_type, providerId);

  if (providerError) {
    res.status(400).json({ error: providerError });
    return;
  }

  const id = randomUUID();

  db.prepare(`
    INSERT INTO services (
      id, name, service_type, default_price_minor,
      requires_full_payment, lab_provider_id, is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    data.name,
    data.service_type,
    data.default_price_minor,
    data.requires_full_payment ? 1 : 0,
    providerId,
  );

  const service = db.prepare(`
    SELECT
      s.id, s.name, s.service_type, s.default_price_minor,
      s.requires_full_payment, s.is_active, s.lab_provider_id,
      lp.name AS lab_provider_name,
      lp.default_provider_share_basis_points,
      s.created_at, s.updated_at
    FROM services s
    LEFT JOIN lab_providers lp ON lp.id = s.lab_provider_id
    WHERE s.id = ?
  `).get(id);

  res.status(201).json({ service });
});

// Update service. Owner only.
router.patch("/:id", requireAuth, requireOwner, (req, res) => {
  const serviceId = req.params.id;

  if (typeof serviceId !== "string" || serviceId.length === 0) {
    res.status(400).json({ error: "Invalid service ID." });
    return;
  }

  const parsed = serviceUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid service details.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const existing = db.prepare(`
    SELECT id, service_type, lab_provider_id
    FROM services
    WHERE id = ?
  `).get(serviceId) as {
    id: string;
    service_type: string;
    lab_provider_id: string | null;
  } | undefined;

  if (!existing) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  const fields = parsed.data;

  const resultingType = fields.service_type ?? existing.service_type;
  const resultingProviderId =
    fields.lab_provider_id !== undefined
      ? fields.lab_provider_id
      : existing.lab_provider_id;

  const providerError = validateProvider(
    resultingType,
    resultingProviderId,
  );

  if (providerError) {
    res.status(400).json({ error: providerError });
    return;
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (fields.name !== undefined) {
    updates.push("name = ?");
    values.push(fields.name);
  }

  if (fields.service_type !== undefined) {
    updates.push("service_type = ?");
    values.push(fields.service_type);
  }

  if (fields.default_price_minor !== undefined) {
    updates.push("default_price_minor = ?");
    values.push(fields.default_price_minor);
  }

  if (fields.requires_full_payment !== undefined) {
    updates.push("requires_full_payment = ?");
    values.push(fields.requires_full_payment ? 1 : 0);
  }

  if (fields.lab_provider_id !== undefined || fields.service_type !== undefined) {
    updates.push("lab_provider_id = ?");
    values.push(resultingProviderId);
  }

  if (fields.is_active !== undefined) {
    updates.push("is_active = ?");
    values.push(fields.is_active ? 1 : 0);
  }

  updates.push("updated_at = datetime('now')");
  values.push(serviceId);

  db.prepare(`
    UPDATE services
    SET ${updates.join(", ")}
    WHERE id = ?
  `).run(...values);

  const service = db.prepare(`
    SELECT
      s.id, s.name, s.service_type, s.default_price_minor,
      s.requires_full_payment, s.is_active, s.lab_provider_id,
      lp.name AS lab_provider_name,
      lp.default_provider_share_basis_points,
      s.created_at, s.updated_at
    FROM services s
    LEFT JOIN lab_providers lp ON lp.id = s.lab_provider_id
    WHERE s.id = ?
  `).get(serviceId);

  res.json({ service });
});

export default router;
