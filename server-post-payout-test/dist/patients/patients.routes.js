import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth } from "../auth/auth.routes.js";
const router = Router();
const patientSchema = z.object({
    full_name: z.string().trim().min(2).max(150),
    phone: z.string().trim().min(3).max(30),
});
// Search patients by name or phone number.
// An empty search returns an empty list rather than all patient records.
router.get("/", requireAuth, (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length > 150) {
        res.status(400).json({
            error: "Search text must be 150 characters or fewer.",
        });
        return;
    }
    if (!query) {
        res.json({ patients: [] });
        return;
    }
    const searchTerm = `%${query}%`;
    const patients = db.prepare(`
    SELECT id, full_name, phone, created_at, updated_at
    FROM patients
    WHERE full_name LIKE ? COLLATE NOCASE
       OR phone LIKE ?
    ORDER BY full_name COLLATE NOCASE
    LIMIT 50
  `).all(searchTerm, searchTerm);
    res.json({ patients });
});
// Register a patient. Both owner and staff can register patients.
router.post("/", requireAuth, (req, res) => {
    const parsed = patientSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid patient details.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const id = randomUUID();
    try {
        db.prepare(`
      INSERT INTO patients (id, full_name, phone)
      VALUES (?, ?, ?)
    `).run(id, parsed.data.full_name, parsed.data.phone);
    }
    catch (error) {
        console.error("Patient registration failed:", error);
        res.status(500).json({ error: "Could not register patient." });
        return;
    }
    const patient = db.prepare(`
    SELECT id, full_name, phone, created_at, updated_at
    FROM patients
    WHERE id = ?
  `).get(id);
    res.status(201).json({ patient });
});
export default router;
//# sourceMappingURL=patients.routes.js.map