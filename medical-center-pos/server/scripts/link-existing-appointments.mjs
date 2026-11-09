
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database(
  "data/medical-center.sqlite",
  { fileMustExist: true }
);

const sessionId =
  "74718fa6-578e-44ba-9b86-9000b00655e6";

const doctorId =
  "f5d87aee-c565-41c7-98ab-f12d208d8c7f";

const exceptionId =
  "bfd0c6b6-8ddc-455b-bf6a-8bb825c22ef4";

const appointmentDate = "2026-11-09";

const actorId =
  "cfce5244-e975-4304-9a67-2cf2402ae328";

const appointmentIds = [
  "35fd8ad0-189b-4fd5-8146-2ca32883fa23",
  "61a09380-6674-41b0-8b29-80dec43b13e7",
];

try {
  const linkAppointments = db.transaction(() => {
    const session = db.prepare(`
      SELECT *
      FROM doctor_sessions
      WHERE id = ?
    `).get(sessionId);

    if (
      !session ||
      session.doctor_id !== doctorId ||
      session.session_date !== appointmentDate ||
      session.start_time !== "14:00" ||
      session.end_time !== "17:00" ||
      session.status !== "SCHEDULED"
    ) {
      throw new Error(
        "Expected doctor session not found or changed."
      );
    }

    const exception = db.prepare(`
      SELECT id
      FROM schedule_exceptions
      WHERE id = ?
        AND doctor_id = ?
        AND session_date = ?
        AND status = 'CHANGED'
        AND start_time = '14:00'
        AND end_time = '17:00'
    `).get(exceptionId, doctorId, appointmentDate);

    if (!exception) {
      throw new Error(
        "Expected schedule exception not found or changed."
      );
    }

    const otherSessions = db.prepare(`
      SELECT COUNT(*) AS count
      FROM doctor_sessions
      WHERE doctor_id = ?
        AND session_date = ?
        AND id != ?
    `).get(doctorId, appointmentDate, sessionId);

    if (otherSessions.count !== 0) {
      throw new Error(
        "Other sessions exist; manual association required."
      );
    }

    const unlinked = db.prepare(`
      SELECT id
      FROM appointments
      WHERE doctor_id = ?
        AND appointment_date = ?
        AND doctor_session_id IS NULL
    `).all(doctorId, appointmentDate);

    const expected = [...appointmentIds].sort();
    const actual = unlinked.map(a => a.id).sort();

    if (
      JSON.stringify(actual) !==
      JSON.stringify(expected)
    ) {
      throw new Error(
        "Unlinked appointments differ from expected records."
      );
    }

    const update = db.prepare(`
      UPDATE appointments
      SET doctor_session_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND doctor_id = ?
        AND appointment_date = ?
        AND schedule_exception_id = ?
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

    for (const appointmentId of appointmentIds) {
      const result = update.run(
        sessionId,
        appointmentId,
        doctorId,
        appointmentDate,
        exceptionId
      );

      if (result.changes !== 1) {
        throw new Error(
          `Could not link appointment ${appointmentId}`
        );
      }

      audit.run(
        actorId,
        appointmentId,
        JSON.stringify({
          action: "LINK_DOCTOR_SESSION",
          doctor_session_id: sessionId,
          reason: "Historical appointment association",
          migration_reference: "Milestone 3 Step 4"
        })
      );
    }

    return appointmentIds.length;
  });

  const count = linkAppointments.immediate();

  console.log(
    `SUCCESS: Linked ${count} appointments to session ${sessionId}`
  );
} finally {
  db.close();
}
