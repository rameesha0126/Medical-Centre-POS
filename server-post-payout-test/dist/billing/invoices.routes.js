import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { requireAuth } from "../auth/auth.routes.js";
const router = Router();
const createInvoiceSchema = z.object({
    patient_id: z.string().uuid(),
    appointment_id: z.string().uuid().optional(),
    items: z.array(z.object({
        service_id: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
    })).min(1).max(30),
});
function localDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
}
function getInvoiceDetails(invoiceId) {
    const invoice = db.prepare(`
    SELECT
      i.id,
      i.invoice_number,
      i.patient_id,
      p.full_name AS patient_name,
      p.phone AS patient_phone,
      i.appointment_id,
      i.status,
      i.subtotal_minor,
      i.discount_minor,
      i.total_minor,
      i.created_by,
      i.created_at
    FROM invoices i
    INNER JOIN patients p ON p.id = i.patient_id
    WHERE i.id = ?
  `).get(invoiceId);
    if (!invoice)
        return null;
    const items = db.prepare(`
    SELECT
      ii.id,
      ii.service_id,
      ii.doctor_id,
      d.full_name AS doctor_name,
      ii.lab_provider_id,
      lp.name AS lab_provider_name,
      ii.description,
      ii.quantity,
      ii.unit_price_minor,
      ii.line_total_minor,
      ii.provider_share_minor,
      ii.center_share_minor
    FROM invoice_items ii
    LEFT JOIN doctors d ON d.id = ii.doctor_id
    LEFT JOIN lab_providers lp ON lp.id = ii.lab_provider_id
    WHERE ii.invoice_id = ?
    ORDER BY ii.rowid
  `).all(invoiceId);
    return { ...invoice, items };
}
// POST /api/invoices
// Owner and staff can create invoices.
router.post("/", requireAuth, (req, res) => {
    const parsed = createInvoiceSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid invoice details.",
            details: parsed.error.flatten(),
        });
        return;
    }
    const data = parsed.data;
    const user = res.locals.user;
    const patient = db.prepare(`
    SELECT id FROM patients WHERE id = ?
  `).get(data.patient_id);
    if (!patient) {
        res.status(404).json({ error: "Patient not found." });
        return;
    }
    // Combine duplicate service entries so each service appears once.
    const quantities = new Map();
    for (const item of data.items) {
        const totalQuantity = (quantities.get(item.service_id) ?? 0) + item.quantity;
        if (totalQuantity > 100) {
            res.status(400).json({
                error: "The total quantity of a service cannot exceed 100.",
            });
            return;
        }
        quantities.set(item.service_id, totalQuantity);
    }
    const appointment = data.appointment_id
        ? db.prepare(`
        SELECT id, patient_id, doctor_id, status
        FROM appointments
        WHERE id = ?
      `).get(data.appointment_id)
        : undefined;
    if (data.appointment_id && !appointment) {
        res.status(404).json({ error: "Appointment not found." });
        return;
    }
    if (appointment) {
        if (appointment.patient_id !== data.patient_id) {
            res.status(400).json({
                error: "The appointment does not belong to this patient.",
            });
            return;
        }
        if (["CANCELLED", "NO_SHOW", "COMPLETED"].includes(appointment.status)) {
            res.status(409).json({
                error: "An invoice cannot be created for this appointment status.",
            });
            return;
        }
        const existingInvoice = db.prepare(`
      SELECT id
      FROM invoices
      WHERE appointment_id = ?
        AND status != 'CANCELLED'
      LIMIT 1
    `).get(data.appointment_id);
        if (existingInvoice) {
            res.status(409).json({
                error: "An invoice already exists for this appointment.",
            });
            return;
        }
    }
    const serviceIds = [...quantities.keys()];
    const services = new Map();
    for (const serviceId of serviceIds) {
        const service = db.prepare(`
      SELECT
        s.id,
        s.name,
        s.service_type,
        s.default_price_minor,
        s.lab_provider_id,
        lp.default_provider_share_basis_points
      FROM services s
      LEFT JOIN lab_providers lp ON lp.id = s.lab_provider_id
      WHERE s.id = ? AND s.is_active = 1
    `).get(serviceId);
        if (!service) {
            res.status(404).json({
                error: "One or more services were not found or are inactive.",
                service_id: serviceId,
            });
            return;
        }
        services.set(serviceId, service);
    }
    const serviceTypes = [...services.values()].map((service) => service.service_type);
    // Consultation invoices must be linked to an appointment.
    if (!appointment && serviceTypes.includes("CONSULTATION")) {
        res.status(400).json({
            error: "A consultation invoice must be linked to an appointment.",
        });
        return;
    }
    // Keep consultation invoices separate from lab and procedure invoices.
    if (appointment) {
        const consultationServiceId = serviceIds.length === 1 ? serviceIds[0] : undefined;
        if (serviceTypes.length !== 1 ||
            serviceTypes[0] !== "CONSULTATION" ||
            !consultationServiceId ||
            quantities.get(consultationServiceId) !== 1) {
            res.status(400).json({
                error: "An appointment invoice must contain exactly one consultation service with quantity 1.",
            });
            return;
        }
    }
    if (!appointment && serviceTypes.includes("CONSULTATION")) {
        res.status(400).json({
            error: "Consultation services require an appointment.",
        });
        return;
    }
    if (appointment && serviceTypes.some((type) => type !== "CONSULTATION")) {
        res.status(400).json({
            error: "Laboratory tests and procedures must be invoiced separately from consultations.",
        });
        return;
    }
    const calculatedItems = [];
    for (const [serviceId, quantity] of quantities.entries()) {
        const service = services.get(serviceId);
        const unitPrice = service.default_price_minor;
        const lineTotal = unitPrice * quantity;
        let doctorId = null;
        let labProviderId = null;
        let providerShare = 0;
        if (service.service_type === "CONSULTATION") {
            if (!appointment) {
                res.status(400).json({
                    error: "Consultation service requires an appointment.",
                });
                return;
            }
            const doctor = db.prepare(`
        SELECT consultation_fee_minor
        FROM doctors
        WHERE id = ?
      `).get(appointment.doctor_id);
            if (!doctor) {
                res.status(404).json({ error: "Appointment doctor not found." });
                return;
            }
            doctorId = appointment.doctor_id;
            providerShare = doctor.consultation_fee_minor * quantity;
            if (providerShare > lineTotal) {
                res.status(400).json({
                    error: `The consultation price for "${service.name}" is lower than the doctor's fixed fee.`,
                });
                return;
            }
        }
        else if (service.service_type === "LAB") {
            if (!service.lab_provider_id ||
                service.default_provider_share_basis_points === null) {
                res.status(400).json({
                    error: `Laboratory service "${service.name}" has no valid provider configuration.`,
                });
                return;
            }
            labProviderId = service.lab_provider_id;
            // Round to the nearest minor currency unit.
            providerShare = Math.round((lineTotal * service.default_provider_share_basis_points) / 10000);
        }
        const centerShare = lineTotal - providerShare;
        calculatedItems.push({
            id: randomUUID(),
            service_id: service.id,
            doctor_id: doctorId,
            lab_provider_id: labProviderId,
            description: service.name,
            quantity,
            unit_price_minor: unitPrice,
            line_total_minor: lineTotal,
            provider_share_minor: providerShare,
            center_share_minor: centerShare,
        });
    }
    const subtotal = calculatedItems.reduce((sum, item) => sum + item.line_total_minor, 0);
    if (!Number.isSafeInteger(subtotal) || subtotal <= 0) {
        res.status(400).json({
            error: "The invoice total must be greater than zero.",
        });
        return;
    }
    const invoiceId = randomUUID();
    const invoiceDate = localDateString();
    const invoicePrefix = `INV-${invoiceDate}-`;
    try {
        const createInvoice = db.transaction(() => {
            // Generate a sequential invoice number safely inside the transaction.
            const previous = db.prepare(`
        SELECT invoice_number
        FROM invoices
        WHERE invoice_number LIKE ?
        ORDER BY invoice_number DESC
        LIMIT 1
      `).get(`${invoicePrefix}%`);
            const previousNumber = previous
                ? Number(previous.invoice_number.slice(invoicePrefix.length))
                : 0;
            const invoiceNumber = `${invoicePrefix}${String(previousNumber + 1).padStart(4, "0")}`;
            db.prepare(`
        INSERT INTO invoices (
          id,
          invoice_number,
          patient_id,
          appointment_id,
          status,
          subtotal_minor,
          discount_minor,
          total_minor,
          created_by
        )
        VALUES (?, ?, ?, ?, 'OPEN', ?, 0, ?, ?)
      `).run(invoiceId, invoiceNumber, data.patient_id, data.appointment_id ?? null, subtotal, subtotal, user.id);
            const insertItem = db.prepare(`
        INSERT INTO invoice_items (
          id,
          invoice_id,
          service_id,
          doctor_id,
          description,
          quantity,
          unit_price_minor,
          line_total_minor,
          provider_share_minor,
          center_share_minor,
          lab_provider_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const item of calculatedItems) {
                insertItem.run(item.id, invoiceId, item.service_id, item.doctor_id, item.description, item.quantity, item.unit_price_minor, item.line_total_minor, item.provider_share_minor, item.center_share_minor, item.lab_provider_id);
            }
            db.prepare(`
        INSERT INTO audit_logs (
          user_id,
          action,
          entity_type,
          entity_id,
          details_json
        )
        VALUES (?, 'CREATE', 'INVOICE', ?, ?)
      `).run(user.id, invoiceId, JSON.stringify({
                invoice_number: invoiceNumber,
                patient_id: data.patient_id,
                appointment_id: data.appointment_id ?? null,
                total_minor: subtotal,
                item_count: calculatedItems.length,
            }));
            return invoiceNumber;
        });
        createInvoice.immediate();
        const invoice = getInvoiceDetails(invoiceId);
        res.status(201).json({
            message: "Invoice created successfully.",
            invoice,
        });
    }
    catch (error) {
        console.error("Invoice creation failed:", error);
        res.status(500).json({
            error: "Could not create invoice.",
        });
    }
});
// GET /api/invoices/:id
// Retrieve an invoice and its stored line-item calculations.
router.get("/:id", requireAuth, (req, res) => {
    const invoiceId = req.params.id;
    if (typeof invoiceId !== "string" ||
        !z.string().uuid().safeParse(invoiceId).success) {
        res.status(400).json({ error: "Invalid invoice ID." });
        return;
    }
    const invoice = getInvoiceDetails(invoiceId);
    if (!invoice) {
        res.status(404).json({ error: "Invoice not found." });
        return;
    }
    res.json({ invoice });
});
export default router;
//# sourceMappingURL=invoices.routes.js.map