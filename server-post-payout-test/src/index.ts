import express from "express";
import cors from "cors";
import authRouter from "./auth/auth.routes.js";
import doctorsRouter from "./doctors/doctors.routes.js";
import patientsRouter from "./patients/patients.routes.js";
import schedulesRouter from "./schedules/schedules.routes.js";
import appointmentsRouter from "./appointments/appointments.routes.js";
import labProvidersRouter from "./lab-providers/lab-providers.routes.js";
import servicesRouter from "./services/services.routes.js";
import invoicesRouter from "./billing/invoices.routes.js";
import paymentsRouter from "./billing/payments.routes.js";
import cashSessionsRouter from "./cash-sessions/cash-sessions.routes.js";
import doctorSessionsRouter from "./doctor-sessions/doctor-sessions.routes.js";

const app = express();
const PORT = 3000;

app.use(
    cors({ 
        origin: "http://localhost:5173", 
        credentials: true,
    }),
);

app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    application: "medical-center-pos",
    database: "connected",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/doctors", doctorsRouter);
app.use("/api/patients", patientsRouter);
app.use("/api/schedules", schedulesRouter);
app.use("/api/appointments", appointmentsRouter);
app.use("/api/lab-providers", labProvidersRouter);
app.use("/api/services", servicesRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/invoices", paymentsRouter);
app.use("/api/cash-sessions", cashSessionsRouter);
app.use("/api/doctor-sessions", doctorSessionsRouter);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Medical Center POS API running at http://127.0.0.1:${PORT}`);
});
