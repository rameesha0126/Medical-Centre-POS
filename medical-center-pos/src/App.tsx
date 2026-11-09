import { useEffect, useState, type FormEvent } from "react";
import "./App.css";

const API = "http://localhost:3000/api";

type User = {
  id: string;
  username: string;
  displayName: string;
  role: "OWNER" | "STAFF";
};

type DashboardSection =
  | "Overview"
  | "Appointments & Queues"
  | "Patients"
  | "Billing & Payments"
  | "Provider Settlements"
  | "Reports"
  | "Settings";

type Doctor = {
  id: string;
  full_name: string;
  fullName?: string;
  is_active?: number | boolean;
};

type Patient = {
  id: string;
  full_name: string;
  fullName?: string;
  phone: string;
};

type Appointment = {
  id: string;
  patient_id?: string;
  doctor_id?: string;
  appointment_date?: string;
  queue_number: number;
  patient_name?: string;
  doctor_name?: string;
  booking_source: string;
  status: string;
  notes?: string | null;
};

const navigation: {
  label: DashboardSection;
  description: string;
}[] = [
  { label: "Overview", description: "Today's summary" },
  { label: "Appointments & Queues", description: "Bookings and doctor queues" },
  { label: "Patients", description: "Patient registration and search" },
  { label: "Billing & Payments", description: "Invoices and collections" },
  { label: "Provider Settlements", description: "Doctor and laboratory payouts" },
  { label: "Reports", description: "Daily and monthly reports" },
  { label: "Settings", description: "Users and centre configuration" },
];

function localDateString() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status}).`);
  }

  return data as T;
}

function doctorName(doctor: Doctor) {
  return doctor.full_name ?? doctor.fullName ?? "Unnamed doctor";
}

function patientName(patient: Patient) {
  return patient.full_name ?? patient.fullName ?? "Unnamed patient";
}

const statusTransitions: Record<string, string[]> = {
  BOOKED: ["ARRIVED", "CANCELLED", "NO_SHOW"],
  ARRIVED: ["WAITING", "CANCELLED", "NO_SHOW"],
  WAITING: ["READY", "CANCELLED", "NO_SHOW"],
  READY: ["IN_CONSULTATION", "CANCELLED", "NO_SHOW"],
  IN_CONSULTATION: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [activeSection, setActiveSection] =
    useState<DashboardSection>("Overview");

  useEffect(() => {
    let active = true;

    fetch(`${API}/auth/me`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((data) => {
        if (active && data?.user) setUser(data.user);
      })
      .catch(() => {
        if (active) setError("Cannot connect to the local POS server.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const data = await apiRequest<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      setUser(data.user);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    setError("");

    try {
      await apiRequest("/auth/logout", { method: "POST" });
      setUser(null);
      setPassword("");
      setActiveSection("Overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Logout failed.");
    }
  }

  if (loading) {
    return <main className="pos-shell">Loading Medical Center POS…</main>;
  }

  if (user) {
    const visibleNavigation = navigation.filter(
      (item) => item.label !== "Settings" || user.role === "OWNER",
    );

    const sectionDescriptions: Record<DashboardSection, string> = {
      Overview: "An overview of the medical centre's daily operations.",
      "Appointments & Queues":
        "Book appointments, register walk-ins and manage each doctor's queue.",
      Patients: "Register patients and find existing patient records.",
      "Billing & Payments":
        "Create invoices, collect payments and issue receipts.",
      "Provider Settlements":
        "Review doctor fees and laboratory provider balances and payouts.",
      Reports: "Review collections, cash reconciliation and financial reports.",
      Settings: "Manage staff accounts, doctors, services and centre settings.",
    };

    return (
      <div className="dashboard-layout">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">MC</div>
            <div>
              <strong>Medical Center</strong>
              <span>Point of Sale</span>
            </div>
          </div>

          <p className="nav-heading">WORKSPACE</p>

          <nav className="sidebar-nav">
            {visibleNavigation.map((item) => (
              <button
                key={item.label}
                className={`nav-item ${
                  activeSection === item.label ? "active" : ""
                }`}
                onClick={() => setActiveSection(item.label)}
              >
                <span>{item.label}</span>
                <span className="nav-chevron">›</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <span className="status-dot" />
            <span>Local POS</span>
            <span className="offline-label">Offline-ready</span>
          </div>
        </aside>

        <main className="dashboard-main">
          <header className="topbar">
            <div>
              <p className="eyebrow">MEDICAL CENTER POS</p>
              <h1>{activeSection}</h1>
            </div>

            <div className="user-menu">
              <div className="avatar">
                {user.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="user-details">
                <strong>{user.displayName}</strong>
                <span>{user.role}</span>
              </div>
              <button className="logout-button" onClick={handleLogout}>
                Log out
              </button>
            </div>
          </header>

          {error && <p className="error-message global-error">{error}</p>}

          <section className="page-content">
            <div className="welcome-row">
              <div>
                <h2>
                  {activeSection === "Overview"
                    ? `Welcome back, ${user.displayName}`
                    : activeSection}
                </h2>
                <p>{sectionDescriptions[activeSection]}</p>
              </div>
              <span className="role-badge">{user.role}</span>
            </div>

            {activeSection === "Overview" ? (
              <Overview
                onNavigate={setActiveSection}
                displayName={user.displayName}
              />
            ) : activeSection === "Appointments & Queues" ? (
              <AppointmentsPage />
            ) : activeSection === "Patients" ? (
              <PatientsPage />
            ) : (
              <section className="panel section-placeholder">
                <div className="placeholder-symbol">✦</div>
                <h3>{activeSection}</h3>
                <p>{sectionDescriptions[activeSection]}</p>
                <p className="muted">
                  This module has not been implemented yet. Your existing
                  authentication and database remain in place.
                </p>
                <button
                  className="secondary-button"
                  onClick={() => setActiveSection("Overview")}
                >
                  Back to overview
                </button>
              </section>
            )}
          </section>
        </main>
      </div>
    );
  }

  return (
    <main className="pos-shell">
      <section className="pos-card">
        <p className="eyebrow">MEDICAL CENTER POS</p>
        <h1>Sign in</h1>
        <p className="muted">Use your authorized staff account to continue.</p>

        <form onSubmit={handleLogin}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            maxLength={100}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            maxLength={256}
            required
          />

          {error && <p className="error-message">{error}</p>}

          <button
            className="primary-button"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Overview({
  onNavigate,
  displayName,
}: {
  onNavigate: (section: DashboardSection) => void;
  displayName: string;
}) {
  return (
    <>
      <div className="section-heading">
        <h3>Today's operations</h3>
        <span>Live figures will appear when connected</span>
      </div>

      <div className="summary-grid">
        <SummaryCard
          title="Appointments"
          description="Today's bookings and walk-ins"
          icon="calendar"
        />
        <SummaryCard
          title="Pending payments"
          description="Invoices awaiting full payment"
          icon="credit-card"
        />
        <SummaryCard
          title="Patients waiting"
          description="Patients in doctor queues"
          icon="users"
        />
        <SummaryCard
          title="Today's collections"
          description="Confirmed payments received"
          icon="wallet"
        />
      </div>

      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h3>Appointment & queue management</h3>
              <p>Manage patient flow throughout the day.</p>
            </div>
          </div>

          <button
            className="action-row"
            onClick={() => onNavigate("Appointments & Queues")}
          >
            <span className="action-icon">01</span>
            <span>
              <strong>Appointments & queues</strong>
              <small>Bookings, walk-ins and doctor queues</small>
            </span>
            <span className="nav-chevron">›</span>
          </button>

          <button
            className="action-row"
            onClick={() => onNavigate("Patients")}
          >
            <span className="action-icon">02</span>
            <span>
              <strong>Patient records</strong>
              <small>Register and search patients</small>
            </span>
            <span className="nav-chevron">›</span>
          </button>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <h3>Financial operations</h3>
              <p>Payments, settlements and reporting.</p>
            </div>
          </div>

          {(
            [
              ["03", "Billing & payments", "Invoices, collections and receipts", "Billing & Payments"],
              ["04", "Provider settlements", "Doctor and lab provider payouts", "Provider Settlements"],
              ["05", "Reports & reconciliation", "Collections and daily cash closing", "Reports"],
            ] as const
          ).map(([number, title, description, section]) => (
            <button
              className="action-row"
              key={number}
              onClick={() => onNavigate(section)}
            >
              <span className="action-icon">{number}</span>
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
              <span className="nav-chevron">›</span>
            </button>
          ))}
        </section>
      </div>

      <div className="notice">
        <strong>Dashboard foundation</strong>
        <p>
          Welcome back, {displayName}. Appointment and patient management are
          now connected to the local database. Financial cards remain
          placeholders until billing is implemented.
        </p>
      </div>
    </>
  );
}

function AppointmentsPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [selectedDate, setSelectedDate] = useState(localDateString());
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [showBooking, setShowBooking] = useState(false);
  const [saving, setSaving] = useState(false);

  const [patientQuery, setPatientQuery] = useState("");
  const [patientResults, setPatientResults] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [bookingSource, setBookingSource] = useState("PHONE");
  const [appointmentNotes, setAppointmentNotes] = useState("");

  const [newPatientName, setNewPatientName] = useState("");
  const [newPatientPhone, setNewPatientPhone] = useState("");
  const [registeringPatient, setRegisteringPatient] = useState(false);

  async function loadDoctors() {
    setLoadingDoctors(true);
    setPageError("");

    try {
      const data = await apiRequest<{ doctors: Doctor[] }>("/doctors");
      const list = data.doctors ?? [];
      setDoctors(list);

      if (list.length > 0) {
        setSelectedDoctorId((current) =>
          current && list.some((doctor) => doctor.id === current)
            ? current
            : list[0].id,
        );
      } else {
        setSelectedDoctorId("");
      }
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Could not load doctors.",
      );
    } finally {
      setLoadingDoctors(false);
    }
  }

  async function loadQueue() {
    if (!selectedDoctorId || !selectedDate) {
      setAppointments([]);
      return;
    }

    setLoadingQueue(true);
    setPageError("");

    try {
      const params = new URLSearchParams({
        date: selectedDate,
        doctorId: selectedDoctorId,
      });

      const data = await apiRequest<{ appointments: Appointment[] }>(
        `/appointments?${params.toString()}`,
      );

      setAppointments(data.appointments ?? []);
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Could not load the queue.",
      );
    } finally {
      setLoadingQueue(false);
    }
  }

  useEffect(() => {
    void loadDoctors();
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [selectedDoctorId, selectedDate]);

  async function searchPatients(query: string) {
    setPatientQuery(query);
    setSelectedPatient(null);

    if (query.trim().length < 2) {
      setPatientResults([]);
      return;
    }

    try {
      const params = new URLSearchParams({ q: query.trim() });
      const data = await apiRequest<{ patients: Patient[] }>(
        `/patients?${params.toString()}`,
      );
      setPatientResults(data.patients ?? []);
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Patient search failed.",
      );
    }
  }

  async function bookAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedPatient || !selectedDoctorId) {
      setPageError("Select a patient and a doctor before booking.");
      return;
    }

    setSaving(true);
    setPageError("");
    setNotice("");

    try {
      await apiRequest("/appointments", {
        method: "POST",
        body: JSON.stringify({
          patient_id: selectedPatient.id,
          doctor_id: selectedDoctorId,
          appointment_date: selectedDate,
          booking_source: bookingSource,
          notes: appointmentNotes.trim() || null,
        }),
      });

      setNotice(`Appointment booked for ${patientName(selectedPatient)}.`);
      setShowBooking(false);
      setSelectedPatient(null);
      setPatientQuery("");
      setPatientResults([]);
      setAppointmentNotes("");
      await loadQueue();
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Could not book appointment.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(appointmentId: string, status: string) {
    setPageError("");
    setNotice("");

    try {
      await apiRequest(`/appointments/${appointmentId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });

      setNotice(`Appointment status updated to ${statusLabel(status)}.`);
      await loadQueue();
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Could not update appointment.",
      );
    }
  }

  const selectedDoctor = doctors.find(
    (doctor) => doctor.id === selectedDoctorId,
  );

  return (
    <div className="appointments-page">
      <section className="panel queue-controls">
        <div className="panel-heading">
          <div>
            <h3>Doctor's daily queue</h3>
            <p>Select a doctor and date to view appointments.</p>
          </div>
          <button
            className="secondary-button refresh-button"
            onClick={() => void loadQueue()}
            disabled={loadingQueue || !selectedDoctorId}
          >
            {loadingQueue ? "Refreshing…" : "Refresh queue"}
          </button>
        </div>

        <div className="filter-grid">
          <div className="field">
            <label htmlFor="queue-doctor">Doctor</label>
            <select
              id="queue-doctor"
              value={selectedDoctorId}
              onChange={(event) => setSelectedDoctorId(event.target.value)}
              disabled={loadingDoctors || doctors.length === 0}
            >
              {doctors.length === 0 && <option value="">No doctors found</option>}
              {doctors.map((doctor) => (
                <option value={doctor.id} key={doctor.id}>
                  {doctorName(doctor)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="queue-date">Appointment date</label>
            <input
              id="queue-date"
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </div>
        </div>

        {selectedDoctor && (
          <div className="queue-summary">
            <span>
              Queue for <strong>{doctorName(selectedDoctor)}</strong>
            </span>
            <span>
              <strong>{appointments.length}</strong>{" "}
              {appointments.length === 1 ? "appointment" : "appointments"}
            </span>
          </div>
        )}
      </section>

      {pageError && <p className="error-message inline-message">{pageError}</p>}
      {notice && <p className="success-message">{notice}</p>}

      <section className="panel queue-panel">
        <div className="panel-heading">
          <div>
            <h3>Appointments</h3>
            <p>Appointments are numbered separately for each doctor.</p>
          </div>
          <button
            className="primary-action"
            onClick={() => {
              setShowBooking((current) => !current);
              setPageError("");
              setNotice("");
            }}
            disabled={!selectedDoctorId}
          >
            {showBooking ? "Close booking" : "+ New appointment"}
          </button>
        </div>

        {showBooking && (
          <form className="booking-form" onSubmit={bookAppointment}>
            <h4>Book an appointment</h4>

            <div className="field">
              <label htmlFor="patient-search">Find existing patient</label>
              <input
                id="patient-search"
                value={patientQuery}
                onChange={(event) => void searchPatients(event.target.value)}
                placeholder="Search by patient name or phone"
                autoComplete="off"
              />
              {patientResults.length > 0 && (
                <div className="patient-results">
                  {patientResults.map((patient) => (
                    <button
                      type="button"
                      key={patient.id}
                      className="patient-result"
                      onClick={() => {
                        setSelectedPatient(patient);
                        setPatientQuery(patientName(patient));
                        setPatientResults([]);
                      }}
                    >
                      <strong>{patientName(patient)}</strong>
                      <span>{patient.phone}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedPatient && (
              <p className="selected-patient">
                Selected patient: <strong>{patientName(selectedPatient)}</strong>
                {" · "}
                {selectedPatient.phone}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setSelectedPatient(null);
                    setPatientQuery("");
                  }}
                >
                  Change
                </button>
              </p>
            )}

            {!selectedPatient && (
              <details className="register-patient">
                <summary>Register a new patient</summary>
                <div className="register-fields">
                  <div className="field">
                    <label htmlFor="new-patient-name">Patient name</label>
                    <input
                      id="new-patient-name"
                      value={newPatientName}
                      onChange={(event) => setNewPatientName(event.target.value)}
                      required
                      maxLength={150}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="new-patient-phone">Phone number</label>
                    <input
                      id="new-patient-phone"
                      value={newPatientPhone}
                      onChange={(event) => setNewPatientPhone(event.target.value)}
                      required
                      maxLength={30}
                    />
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={
                      registeringPatient ||
                      !newPatientName.trim() ||
                      !newPatientPhone.trim()
                    }
                    onClick={() => {
                      const form = document.getElementById(
                        "new-patient-name",
                      ) as HTMLInputElement | null;
                      if (form?.value.trim()) {
                        void registerPatientFromButton(
                          newPatientName,
                          newPatientPhone,
                          setRegisteringPatient,
                          setPageError,
                          setSelectedPatient,
                          setPatientQuery,
                          setNewPatientName,
                          setNewPatientPhone,
                          setNotice,
                        );
                      }
                    }}
                  >
                    {registeringPatient ? "Registering…" : "Register patient"}
                  </button>
                </div>
              </details>
            )}

            <div className="filter-grid">
              <div className="field">
                <label htmlFor="booking-source">Booking source</label>
                <select
                  id="booking-source"
                  value={bookingSource}
                  onChange={(event) => setBookingSource(event.target.value)}
                >
                  <option value="PHONE">Phone</option>
                  <option value="MESSAGE">Message</option>
                  <option value="WALK_IN">Walk-in</option>
                  <option value="IN_PERSON">In-person</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="appointment-notes">Notes (optional)</label>
                <input
                  id="appointment-notes"
                  value={appointmentNotes}
                  onChange={(event) => setAppointmentNotes(event.target.value)}
                  maxLength={500}
                  placeholder="Optional notes"
                />
              </div>
            </div>

            <div className="booking-actions">
              <button
                className="primary-action"
                type="submit"
                disabled={saving || !selectedPatient}
              >
                {saving ? "Booking…" : "Confirm appointment"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setShowBooking(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {loadingQueue ? (
          <p className="empty-state">Loading appointments…</p>
        ) : appointments.length === 0 ? (
          <div className="empty-state">
            <strong>No appointments for this date</strong>
            <p>Choose another date or create a new appointment.</p>
          </div>
        ) : (
          <div className="queue-list">
            {appointments
              .slice()
              .sort((a, b) => a.queue_number - b.queue_number)
              .map((appointment) => {
                const nextStatuses =
                  statusTransitions[appointment.status] ?? [];

                return (
                  <article className="queue-item" key={appointment.id}>
                    <div className="queue-number">
                      <span>QUEUE</span>
                      <strong>{appointment.queue_number}</strong>
                    </div>

                    <div className="queue-patient">
                      <strong>
                        {appointment.patient_name ?? "Patient"}
                      </strong>
                      <span>
                        {appointment.booking_source.replaceAll("_", " ")}
                      </span>
                    </div>

                    <div className="queue-status-area">
                      <span
                        className={`status-pill status-${appointment.status.toLowerCase()}`}
                      >
                        {statusLabel(appointment.status)}
                      </span>
                      {nextStatuses.length > 0 && (
                        <select
                          aria-label={`Update status for queue ${appointment.queue_number}`}
                          value=""
                          onChange={(event) => {
                            if (event.target.value) {
                              void updateStatus(
                                appointment.id,
                                event.target.value,
                              );
                            }
                          }}
                        >
                          <option value="">Update status…</option>
                          {nextStatuses.map((status) => (
                            <option value={status} key={status}>
                              {statusLabel(status)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </article>
                );
              })}
          </div>
        )}
      </section>

      <div className="notice">
        <strong>Payment control reminder</strong>
        <p>
          Billing has not been implemented yet. Do not move an appointment to
          IN CONSULTATION until payment verification is enforced by the backend.
        </p>
      </div>
    </div>
  );
}

async function registerPatientFromButton(
  name: string,
  phone: string,
  setRegistering: (value: boolean) => void,
  setError: (value: string) => void,
  setSelectedPatient: (value: Patient | null) => void,
  setPatientQuery: (value: string) => void,
  setName: (value: string) => void,
  setPhone: (value: string) => void,
  setNotice: (value: string) => void,
) {
  setRegistering(true);
  setError("");

  try {
    const data = await apiRequest<{ patient: Patient }>("/patients", {
      method: "POST",
      body: JSON.stringify({
        full_name: name.trim(),
        phone: phone.trim(),
      }),
    });

    setSelectedPatient(data.patient);
    setPatientQuery(patientName(data.patient));
    setName("");
    setPhone("");
    setNotice("Patient registered. You can now book the appointment.");
  } catch (err) {
    setError(
      err instanceof Error ? err.message : "Could not register patient.",
    );
  } finally {
    setRegistering(false);
  }
}

function PatientsPage() {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  async function search() {
    setLoadingPatients(true);
    setPageError("");

    try {
      const params = new URLSearchParams({ q: query.trim() });
      const data = await apiRequest<{ patients: Patient[] }>(
        `/patients?${params.toString()}`,
      );
      setPatients(data.patients ?? []);
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Patient search failed.",
      );
    } finally {
      setLoadingPatients(false);
    }
  }

  async function createPatient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setPageError("");
    setNotice("");

    try {
      await apiRequest("/patients", {
        method: "POST",
        body: JSON.stringify({
          full_name: name.trim(),
          phone: phone.trim(),
        }),
      });

      setNotice("Patient registered successfully.");
      setName("");
      setPhone("");
      await search();
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Could not register patient.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="patients-page">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>Register a patient</h3>
            <p>Only the patient's name and phone number are required.</p>
          </div>
        </div>

        <form className="patient-registration-form" onSubmit={createPatient}>
          <div className="field">
            <label htmlFor="patient-name">Full name</label>
            <input
              id="patient-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={150}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="patient-phone">Phone number</label>
            <input
              id="patient-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={30}
              required
            />
          </div>
          <button className="primary-action" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Register patient"}
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>Patient records</h3>
            <p>Search using a patient's name or phone number.</p>
          </div>
        </div>

        <form
          className="patient-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <input
            aria-label="Search patients"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Enter name or phone number"
          />
          <button className="secondary-button" type="submit">
            Search
          </button>
        </form>

        {pageError && <p className="error-message inline-message">{pageError}</p>}
        {notice && <p className="success-message">{notice}</p>}

        {loadingPatients ? (
          <p className="empty-state">Searching…</p>
        ) : patients.length > 0 ? (
          <div className="patient-table">
            <div className="patient-table-heading">
              <span>Patient name</span>
              <span>Phone</span>
            </div>
            {patients.map((patient) => (
              <div className="patient-table-row" key={patient.id}>
                <strong>{patientName(patient)}</strong>
                <span>{patient.phone}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">
            Search for a patient to see matching records.
          </p>
        )}
      </section>
    </div>
  );
}

function SummaryCard({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: string;
}) {
  return (
    <section className="summary-card">
      <div className="summary-card-top">
        <span>{title}</span>
        <span className="summary-icon">{icon}</span>
      </div>
      <div className="summary-value">—</div>
      <p>{description}</p>
      <span className="data-pending">Awaiting database integration</span>
    </section>
  );
}