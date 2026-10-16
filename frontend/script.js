// CarePoint hospital management dashboard
// Patient and appointment records are loaded from the hospital backend.
function localDateISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeMobilePhone(value) {
  let phone = String(value || '').trim().replace(/[\s()-]/g, '');
  if (/^\d{10}$/.test(phone)) phone = `+91${phone}`;
  else if (/^0\d{10}$/.test(phone)) phone = `+91${phone.slice(1)}`;
  else if (/^91\d{10}$/.test(phone)) phone = `+${phone}`;
  else if (/^00[1-9]\d{7,14}$/.test(phone)) phone = `+${phone.slice(2)}`;
  return phone;
}

const API_BASE_URL = (window.location.port === '5500' || window.location.port === '5501' || window.location.protocol === 'file:')
  ? `${window.location.protocol === 'https:' ? 'https:' : 'http:'}//${window.location.hostname || 'localhost'}:3001`
  : '';

function readLocalObject(key, fallback) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    return stored && typeof stored === 'object' ? { ...fallback, ...stored } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

let adminProfile = null;
let preferences = readLocalObject('carepointPreferences', { timeFormat: '12h', compactView: false, reducedMotion: false });
let selectedDoctorDepartment = 'all';
let selectedDoctorStatus = 'all';
let selectedInvoiceStatus = 'all';
let adminAccounts = [];
let adminAccountsError = '';
let adminAccountsLoaded = false;
let smsConfigured = false;
let demoOtpEnabled = false;
let demoSmsEnabled = false;
let pendingChallengeToken = '';
let pendingPhoneMasked = '';

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api/${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status}).`);
  return data;
}

const todayISO = localDateISO();
let doctors = [];
let patients = [];
let departments = [];
let invoices = [];

let appointments = [];
let appointmentsLoading = true;
let appointmentsError = '';
let patientsLoading = true;
let patientsError = '';
let doctorsLoading = true;
let doctorsError = '';
let departmentsLoading = true;
let departmentsError = '';
let invoicesLoading = true;
let invoicesError = '';
let currentPage = 'dashboard';
let searchTerm = '';

const pageContent = document.getElementById('pageContent');
const pageTitle = document.getElementById('pageTitle');
const modal = document.getElementById('appointmentModal');
const patientModal = document.getElementById('patientModal');
const dataModal = document.getElementById('dataModal');
const detailModal = document.getElementById('detailModal');
const detailModalEyebrow = document.getElementById('detailModalEyebrow');
const detailModalTitle = document.getElementById('detailModalTitle');
const detailModalContent = document.getElementById('detailModalContent');
const notificationModal = document.getElementById('notificationModal');
const notificationList = document.getElementById('notificationList');
const profileModal = document.getElementById('profileModal');
const profileForm = document.getElementById('profileForm');
const dataForm = document.getElementById('dataForm');
const dataModalTitle = document.getElementById('dataModalTitle');
const dataModalEyebrow = document.getElementById('dataModalEyebrow');
const dataModalIntro = document.getElementById('dataModalIntro');
const dataModalFields = document.getElementById('dataModalFields');
const dataModalSubmit = document.getElementById('dataModalSubmit');
const toast = document.getElementById('toast');
const globalSearchBox = document.getElementById('globalSearchBox');
const globalSearch = document.getElementById('globalSearch');
const searchResults = document.getElementById('searchResults');
const searchToggle = document.getElementById('searchToggle');
const authScreen = document.getElementById('authScreen');
const authForm = document.getElementById('authForm');
const authNameField = document.getElementById('authNameField');
const authEmailField = document.getElementById('authEmailField');
const authPhoneField = document.getElementById('authPhoneField');
const authPasswordField = document.getElementById('authPasswordField');
const authTitle = document.getElementById('authTitle');
const authIntro = document.getElementById('authIntro');
const authEyebrow = document.getElementById('authEyebrow');
const authMessage = document.getElementById('authMessage');
const authModeToggle = document.getElementById('authModeToggle');
const authForgotToggle = document.getElementById('authForgotToggle');
const authRegisterToggle = document.getElementById('authRegisterToggle');
const authSubmit = document.getElementById('authSubmit');
const otpForm = document.getElementById('otpForm');
const otpIntro = document.getElementById('otpIntro');
const otpMessage = document.getElementById('otpMessage');
const otpSubmit = document.getElementById('otpSubmit');
const resetForm = document.getElementById('resetForm');
const appShell = document.querySelector('.app-shell');
let modalOpener = null;
let patientModalOpener = null;
let dataModalOpener = null;
let detailModalOpener = null;
let notificationModalOpener = null;
let profileModalOpener = null;
let activeDataType = '';
let activeDataRecord = null;

function safe(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function initialsFor(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function formatDate(dateValue) {
  if (!dateValue) return '—';
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return safe(dateValue);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTime(timeValue) {
  if (!timeValue) return '—';
  const [hour, minute] = timeValue.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return safe(timeValue);
  if (preferences.timeFormat === '24h') return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${String(hour % 12 || 12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatCurrency(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(value);
}

function avatar(initials, color = 'mint') {
  return `<span class="avatar avatar-${safe(color)}">${safe(initials)}</span>`;
}

function personCell(name, detail, initials, color) {
  return `<div class="person-cell">${avatar(initials, color)}<span class="person-name"><strong>${safe(name)}</strong><small>${safe(detail)}</small></span></div>`;
}

function statusBadge(status) {
  const statusClass = String(status).toLowerCase().replace(/\s+/g, '-');
  return `<span class="status ${safe(statusClass)}">${safe(status)}</span>`;
}

function appointmentRows(items) {
  if (!items.length) {
    const emptyMessage = searchTerm.trim() ? 'No appointments match your search.' : 'No appointments found yet.';
    const message = appointmentsLoading ? 'Loading appointments...' : appointmentsError || emptyMessage;
    return `<tr><td colspan="7"><div class="empty-state">${safe(message)}</div></td></tr>`;
  }
  return items.map((item) => `<tr>
    <td>${personCell(item.patient, item.id, item.initials || initialsFor(item.patient), item.color || 'mint')}</td>
    <td>${safe(item.doctor)}</td><td>${safe(item.department)}</td><td>${formatDate(item.date)}</td><td>${formatTime(item.time)}</td><td>${statusBadge(item.status)}</td>
    <td><button class="text-button" data-action="appointment-details" data-name="${safe(item.id)}" aria-label="Appointment details for ${safe(item.patient)}">Details</button></td>
  </tr>`).join('');
}

function appointmentsTable(items, compact = false) {
  const visible = compact ? items.slice(0, 5) : items;
  return `<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Doctor</th><th>Department</th><th>Date</th><th>Time</th><th>Status</th><th>Action</th></tr></thead><tbody>${appointmentRows(visible)}</tbody></table></div>`;
}

function dashboardView() {
  const confirmed = appointments.filter((item) => item.status === 'Confirmed').length;
  const todayAppointments = appointments.filter((item) => item.date === todayISO).length;
  const availableDoctors = doctors.filter((doctor) => doctor.status === 'Available').length;
  const monthlyRevenue = invoices
    .filter((invoice) => invoice.status === 'Paid' && invoice.month === todayISO.slice(0, 7))
    .reduce((total, invoice) => total + Number(invoice.amount || 0), 0);
  const topDoctors = [...doctors].sort((first, second) => second.patients - first.patients).slice(0, 3);
  const doctorsMarkup = doctorsLoading
    ? '<div class="empty-state">Loading doctors...</div>'
    : doctorsError
      ? `<div class="empty-state">${safe(doctorsError)}</div>`
      : topDoctors.length
        ? topDoctors.map((doctor) => `<div class="doctor-row">${avatar(doctor.initials, doctor.color)}<span class="doctor-info"><strong>${safe(doctor.name)}</strong><small>${safe(doctor.department)}</small></span><span class="availability ${doctor.status === 'Available' ? '' : 'busy'}">${doctor.status === 'Available' ? '● Available' : '● Busy'}</span></div>`).join('')
        : '<div class="empty-state">No doctors found.</div>';
  const todaySchedule = appointments
    .filter((item) => item.date === todayISO)
    .sort((first, second) => first.time.localeCompare(second.time));
  const scheduleMarkup = appointmentsLoading
    ? '<p class="empty-state">Loading today’s schedule...</p>'
    : appointmentsError
      ? `<p class="empty-state">${safe(appointmentsError)}</p>`
      : todaySchedule.length
        ? todaySchedule.map((item) => `<div class="schedule-item"><span class="schedule-time">${formatTime(item.time)}</span><span class="schedule-line"></span><span class="schedule-detail"><strong>${safe(item.patient)}</strong><small>${safe(item.doctor)} · ${safe(item.department)}</small></span></div>`).join('')
        : '<p class="empty-state">No appointments scheduled for today.</p>';
  return `<div class="welcome-row"><div><h2>Good morning, Admin <span>☀️</span></h2><p>Here’s what’s happening at <strong>CarePoint Hospital</strong> today.</p></div><button class="button button-primary" data-action="new-appointment"><span>＋</span> New appointment</button></div>
    <div class="stat-grid">
      <article class="stat-card"><div class="stat-top">Total patients <span class="stat-icon teal">♙</span></div><div class="stat-value">${patientsLoading ? '—' : patientsError ? 'Unavailable' : patients.length.toLocaleString('en-IN')}</div><div class="stat-note">${patientsError ? safe(patientsError) : 'Registered patients'}</div></article>
      <article class="stat-card"><div class="stat-top">Appointments today <span class="stat-icon blue">▣</span></div><div class="stat-value">${todayAppointments}</div><div class="stat-note">${confirmed} confirmed in this list</div></article>
      <article class="stat-card"><div class="stat-top">Available doctors <span class="stat-icon orange">⚕</span></div><div class="stat-value">${doctorsLoading ? '—' : doctorsError ? 'Unavailable' : `${availableDoctors} <span class="stat-change">of ${doctors.length}</span>`}</div><div class="stat-note">Across all departments</div></article>
      <article class="stat-card"><div class="stat-top">Monthly revenue <span class="stat-icon purple">₹</span></div><div class="stat-value">${invoicesLoading ? '—' : invoicesError ? 'Unavailable' : formatCurrency(monthlyRevenue)}</div><div class="stat-note">Paid invoices this month</div></article>
    </div>
    <div class="content-grid"><section class="panel"><div class="panel-header"><div><h3>Recent appointments</h3><p>Track your latest patient visits</p></div><button class="text-button" data-page="appointments">View all →</button></div>${appointmentsTable(appointments, true)}<div class="table-footer"><span>Showing ${Math.min(5, appointments.length)} of ${appointments.length} appointments</span><button data-page="appointments">See all appointments</button></div></section>
      <div class="side-stack"><section class="panel schedule-panel"><div class="panel-header"><div><h3>Today’s schedule</h3><p>Your next appointments</p></div><span class="schedule-date">${formatDate(todayISO)}</span></div><div class="schedule-list">${scheduleMarkup}</div></section>
      <section class="panel doctor-panel"><div class="panel-header"><div><h3>Top doctors</h3><p>Doctors on duty today</p></div><button class="text-button" data-page="doctors">View all →</button></div><div class="doctor-list">${doctorsMarkup}</div></section></div></div>`;
}

function appointmentsView() {
  const filtered = filterItems(appointments, ['patient', 'doctor', 'department', 'status', 'id']);
  return `<div class="section-toolbar"><div><h2>Appointments</h2><p>Manage patient visits and booking status.</p></div><button class="button button-primary" data-action="new-appointment"><span>＋</span> New appointment</button></div><section class="panel table-panel"><div class="panel-header"><div><h3>All appointments</h3><p>${appointments.length} appointments in your schedule</p></div><label class="table-search"><span>⌕</span><input class="page-search" type="search" placeholder="Search appointments" value="${safe(searchTerm)}" aria-label="Search appointments" /></label></div><div id="appointmentsTable">${appointmentsTable(filtered)}</div></section>`;
}

function patientsView() {
  const filtered = filterItems(patients, ['id', 'name', 'phone', 'gender', 'conditionDetails', 'assignedDoctor']);
  const rows = patientsLoading
    ? '<tr><td colspan="7"><div class="empty-state">Loading patients...</div></td></tr>'
    : patientsError
      ? `<tr><td colspan="7"><div class="empty-state">${safe(patientsError)}</div></td></tr>`
      : filtered.length
        ? filtered.map((person) => {
          const gender = person.gender ? `${person.gender[0].toUpperCase()}${person.gender.slice(1)}` : 'Not provided';
          const initials = initialsFor(person.name || 'Patient');
          const color = ['mint', 'blue', 'peach', 'lavender', 'rose'][Number(person.id || 0) % 5];
          const condition = person.conditionDetails || 'Not entered';
          const conditionSummary = condition.length > 60 ? `${condition.slice(0, 60)}...` : condition;
          return `<tr><td>${personCell(person.name, `Patient · #${person.id}`, initials, color)}</td><td>${safe(person.age ?? 'Not provided')}</td><td>${safe(gender)}</td><td>${safe(person.phone || 'Not provided')}</td><td>${safe(person.assignedDoctor || 'Unassigned')}</td><td>${safe(conditionSummary)}</td><td><button class="text-button" data-action="patient-details" data-name="${safe(person.id)}">View case</button></td></tr>`;
        }).join('')
        : `<tr><td colspan="7"><div class="empty-state">${searchTerm.trim() ? 'No patients match your search.' : 'No patients found yet.'}</div></td></tr>`;
  return `<div class="section-toolbar"><div><h2>Patients</h2><p>Patient cases, doctor assignments and admin instructions.</p></div><button class="button button-primary" data-action="new-patient"><span>+</span> Add patient</button></div><section class="panel table-panel"><div class="panel-header"><div><h3>Patient directory</h3><p>${patients.length} registered patients</p></div><label class="table-search"><span>Search</span><input class="page-search" type="search" placeholder="Search patients" value="${safe(searchTerm)}" aria-label="Search patients" /></label></div><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Age</th><th>Gender</th><th>Phone</th><th>Assigned doctor</th><th>Reported illness / symptoms</th><th>Case</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function doctorsView() {
  const filtered = filterItems(doctors, ['name', 'department', 'status'])
    .filter((doctor) => selectedDoctorDepartment === 'all' || doctor.department === selectedDoctorDepartment)
    .filter((doctor) => selectedDoctorStatus === 'all' || doctor.status === selectedDoctorStatus);
  const content = doctorsLoading
    ? '<div class="panel empty-state">Loading doctors...</div>'
    : doctorsError
      ? `<div class="panel empty-state">${safe(doctorsError)}</div>`
      : filtered.length
        ? filtered.map((doctor) => `<article class="doctor-card doctor-card-interactive"><button type="button" class="card-hit-area" data-action="doctor-details" data-name="${safe(doctor.name)}" aria-label="View details for ${safe(doctor.name)}"></button><div class="doctor-card-head">${avatar(doctor.initials, doctor.color)}<div><h3>${safe(doctor.name)}</h3><p>${safe(doctor.department)}</p></div></div><div class="doctor-card-meta"><span>Experience <strong>${safe(doctor.experience)}</strong></span><span>${safe(doctor.patients)} patient visits</span><span class="availability ${doctor.status === 'Available' ? '' : 'busy'}">${safe(doctor.status)}</span></div></article>`).join('')
        : '<div class="panel empty-state">No doctors match your search.</div>';
  return `<div class="section-toolbar"><div><h2>Doctors</h2><p>Meet the specialists caring for your patients.</p></div><button class="button button-primary" data-action="add-doctor"><span>＋</span> Add doctor</button></div><div class="doctor-grid">${content}</div>`;
}

function departmentsView() {
  const filtered = filterItems(departments, ['name', 'description']);
  const content = departmentsLoading
    ? '<div class="panel empty-state">Loading departments...</div>'
    : departmentsError
      ? `<div class="panel empty-state">${safe(departmentsError)}</div>`
      : filtered.map((department) => `<article class="simple-card simple-card-interactive"><button type="button" class="card-hit-area" data-action="department-details" data-name="${safe(department.name)}" aria-label="View details for ${safe(department.name)}"></button><span class="stat-icon ${safe(department.color)}">${safe(department.icon)}</span><h3>${safe(department.name)}</h3><p>${safe(department.description)}</p><div class="doctor-card-meta"><span><strong>${safe(department.doctors)}</strong> doctors</span><span><strong>${safe(department.patients)}</strong> patients</span></div></article>`).join('') || '<div class="panel empty-state">No departments match your search.</div>';
  return `<div class="section-toolbar"><div><h2>Departments</h2><p>Explore care teams and services across the hospital.</p></div><button class="button button-primary" data-action="add-department"><span>＋</span> Add department</button></div><div class="simple-grid">${content}</div>`;
}

function billingView() {
  const filtered = filterItems(invoices, ['id', 'patient', 'service', 'status']);
  const rows = invoicesLoading
    ? '<tr><td colspan="6"><div class="empty-state">Loading invoices...</div></td></tr>'
    : invoicesError
      ? `<tr><td colspan="6"><div class="empty-state">${safe(invoicesError)}</div></td></tr>`
      : filtered.length
        ? filtered.map((bill) => `<tr><td>${safe(bill.id)}</td><td>${safe(bill.patient)}</td><td>${safe(bill.service)}</td><td><strong>${formatCurrency(bill.amount)}</strong></td><td>${statusBadge(bill.status)}</td><td><button class="text-button" data-action="invoice-view" data-name="${safe(bill.id)}">View →</button></td></tr>`).join('')
        : '<tr><td colspan="6"><div class="empty-state">No invoices match your search.</div></td></tr>';
  return `<div class="section-toolbar"><div><h2>Billing</h2><p>Review invoices and payment status.</p></div><button class="button button-primary" data-action="new-invoice"><span>＋</span> Create invoice</button></div><section class="panel table-panel"><div class="panel-header"><div><h3>Recent invoices</h3><p>${invoices.length} invoices stored in the hospital database</p></div><label class="table-search"><span>⌕</span><input class="page-search" type="search" placeholder="Search invoices" value="${safe(searchTerm)}" aria-label="Search invoices" /></label></div><div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Patient</th><th>Service</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function settingsView() {
  return `<div class="section-toolbar"><div><h2>Settings</h2><p>Manage display preferences and secure admin accounts.</p></div></div>
    <div class="settings-layout">
      <form class="panel settings-form" id="settingsForm">
        <div class="settings-section"><h3>Display preferences</h3><p>These choices are saved in this browser.</p>
          <label class="form-field">Time format<select name="timeFormat"><option value="12h" ${preferences.timeFormat === '12h' ? 'selected' : ''}>12-hour (2:30 PM)</option><option value="24h" ${preferences.timeFormat === '24h' ? 'selected' : ''}>24-hour (14:30)</option></select></label>
          <label class="check-field"><input type="checkbox" name="compactView" ${preferences.compactView ? 'checked' : ''} /> Use compact spacing</label>
          <label class="check-field"><input type="checkbox" name="reducedMotion" ${preferences.reducedMotion ? 'checked' : ''} /> Reduce animations</label>
        </div>
        <div class="modal-actions"><button class="button button-quiet" type="button" data-action="reset-settings">Restore defaults</button><button class="button button-primary" type="submit">Save settings</button></div>
      </form>
      <section class="panel settings-form settings-section"><h3>Change your password</h3><p>Changing it signs out any other sessions for your account.</p>
        <form id="passwordForm">
          <label class="form-field">Current password<input name="currentPassword" type="password" required autocomplete="current-password" /></label>
          <label class="form-field">New password<input name="newPassword" type="password" required minlength="10" maxlength="200" autocomplete="new-password" /></label>
          <label class="form-field">Confirm new password<input name="confirmPassword" type="password" required minlength="10" maxlength="200" autocomplete="new-password" /></label>
          <div class="modal-actions"><button class="button button-primary" type="submit">Update password</button></div>
        </form>
      </section>
      <section class="panel settings-form settings-section"><h3>Add an admin account</h3><p>Each admin signs in with their own email and password.</p>
        <form id="adminForm">
          <label class="form-field">Full name<input name="name" required maxlength="100" autocomplete="name" /></label>
          <label class="form-field">Email<input name="email" type="email" required maxlength="150" autocomplete="email" /></label>
          <label class="form-field">Mobile number<input name="phone" type="tel" required maxlength="20" autocomplete="tel" placeholder="9876543210 or +919876543210" title="Enter a 10-digit Indian mobile or include your country code." /></label>
          <label class="form-field">Initial password<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password" /></label>
          <div class="modal-actions"><button class="button button-primary" type="submit">Create admin</button></div>
        </form>
      </section>
      <section class="panel settings-form settings-section"><h3>Admin accounts</h3><p>Only account details are listed here; passwords are never shown.</p><div id="adminList" class="admin-list"><p class="detail-empty">Loading accounts...</p></div></section>
    </div>`;
}

function helpView() {
  return `<div class="section-toolbar"><div><h2>Help &amp; support</h2><p>Quick answers and live connection status for this workspace.</p></div></div>
    <section class="panel help-panel"><div class="panel-header"><div><h3>Frequently asked questions</h3><p>Click a question to see the steps.</p></div></div>
      <div class="faq-list">
        <details><summary>How do I book an appointment?</summary><p>Choose <strong>New appointment</strong> on the dashboard or Appointments page, select a department and doctor, then save.</p></details>
        <details><summary>How do I add a patient or doctor?</summary><p>Open Patients or Doctors from the sidebar and use the Add button. Saved records are sent to the hospital database.</p></details>
        <details><summary>Where can I see invoice details?</summary><p>Open Billing and choose <strong>View</strong> on an invoice to see its patient, service, amount, and payment status.</p></details>
        <details><summary>Where are profile and display settings saved?</summary><p>Admin profile details and hospital records are saved in MySQL. Display preferences remain in this browser.</p></details>
      </div>
      <div class="system-check"><div><h3>System connection</h3><p id="systemStatus">Check whether the backend and database are reachable.</p></div><button class="button button-primary" type="button" data-action="check-system">Check connection</button></div>
    </section>`;
}

function filterItems(items, keys) {
  const term = searchTerm.trim().toLowerCase();
  if (!term) return items;
  return items.filter((item) => keys.some((key) => String(item[key] ?? '').toLowerCase().includes(term)));
}

function addFilterSelect(actions, labelText, id, selectedValue, options) {
  const label = document.createElement('label');
  label.className = 'filter-field';
  label.textContent = labelText;
  const select = document.createElement('select');
  select.id = id;
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = value === selectedValue;
    select.append(option);
  }
  label.append(select);
  actions.append(label);
}

function setupPageFilters() {
  if (currentPage === 'doctors') {
    const toolbar = pageContent.querySelector('.section-toolbar');
    if (!toolbar) return;
    const actions = document.createElement('div');
    actions.className = 'section-actions';
    addFilterSelect(actions, 'Department', 'doctorDepartmentFilter', selectedDoctorDepartment, [
      ['all', 'All departments'],
      ...departments.map((department) => [department.name, department.name])
    ]);
    addFilterSelect(actions, 'Availability', 'doctorStatusFilter', selectedDoctorStatus, [
      ['all', 'All doctors'], ['Available', 'Available'], ['In consultation', 'In consultation']
    ]);
    const addButton = toolbar.querySelector('button[data-action="add-doctor"]');
    if (addButton) actions.append(addButton);
    toolbar.append(actions);
  }
  if (currentPage === 'billing') {
    const toolbar = pageContent.querySelector('.section-toolbar');
    if (!toolbar) return;
    const actions = document.createElement('div');
    actions.className = 'section-actions';
    addFilterSelect(actions, 'Payment status', 'invoiceStatusFilter', selectedInvoiceStatus, [
      ['all', 'All invoices'], ['Paid', 'Paid'], ['Pending', 'Pending'], ['Cancelled', 'Cancelled']
    ]);
    const addButton = toolbar.querySelector('button[data-action="new-invoice"]');
    if (addButton) actions.append(addButton);
    toolbar.append(actions);

    pageContent.querySelectorAll('.table-panel tbody tr td:nth-child(5) .status').forEach((badge) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `${badge.className} status-filter-button`;
      button.dataset.action = 'filter-invoices-by-status';
      button.dataset.status = badge.textContent.trim();
      button.setAttribute('aria-label', `Show ${badge.textContent.trim()} invoices`);
      button.textContent = badge.textContent;
      badge.replaceWith(button);
    });
  }
}

function render() {
  const titles = { dashboard: 'Dashboard', appointments: 'Appointments', patients: 'Patients', doctors: 'Doctors', departments: 'Departments', billing: 'Billing', settings: 'Settings', help: 'Help & support' };
  pageTitle.textContent = titles[currentPage] || 'Dashboard';
  const views = {
    dashboard: dashboardView,
    appointments: appointmentsView,
    patients: patientsView,
    doctors: doctorsView,
    departments: departmentsView,
    billing: billingView,
    settings: settingsView,
    help: helpView
  };
  pageContent.innerHTML = (views[currentPage] || dashboardView)();
  setupPageFilters();
  if (currentPage === 'settings') {
    renderAdminList();
    if (!adminAccountsLoaded) loadAdmins();
  }
  const welcomeHeading = pageContent.querySelector('.welcome-row h2');
  if (welcomeHeading?.firstChild) welcomeHeading.firstChild.textContent = `Good morning, ${adminProfile.name} `;
  const statsPages = ['patients', 'appointments', 'doctors', 'billing'];
  pageContent.querySelectorAll('.stat-card').forEach((card, index) => {
    card.dataset.page = statsPages[index];
    if (statsPages[index] === 'doctors') {
      card.dataset.filterStatus = 'Available';
      card.dataset.filterDepartment = 'all';
    }
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', statsPages[index] === 'doctors' ? 'Open available doctors' : `Open ${statsPages[index]}`);
  });
  if (currentPage === 'patients') {
    const header = pageContent.querySelector('thead tr');
    const filteredPatients = filterItems(patients, ['id', 'name', 'phone', 'gender']);
    const patientRows = pageContent.querySelectorAll('tbody tr');
    if (header && filteredPatients.length) {
      const actionHeader = document.createElement('th');
      actionHeader.textContent = 'Action';
      header.append(actionHeader);
      patientRows.forEach((row, index) => {
        const patient = filteredPatients[index];
        if (!patient) return;
        const cell = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-button';
        button.dataset.action = 'patient-details';
        button.dataset.name = String(patient.id);
        button.setAttribute('aria-label', `Patient details for ${patient.name}`);
        button.textContent = 'Details';
        cell.append(button);
        row.append(cell);
      });
    }
  }
  if (currentPage === 'dashboard') {
    const todayAppointments = appointments.filter((item) => item.date === todayISO).sort((first, second) => first.time.localeCompare(second.time));
    pageContent.querySelectorAll('.schedule-item').forEach((row, index) => {
      const appointment = todayAppointments[index];
      if (!appointment) return;
      row.dataset.action = 'appointment-details';
      row.dataset.name = appointment.id;
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-label', `View appointment for ${appointment.patient}`);
    });
    pageContent.querySelectorAll('.doctor-row').forEach((row) => {
      const doctorName = row.querySelector('.doctor-info strong')?.textContent.trim();
      if (!doctorName) return;
      row.dataset.action = 'doctor-details';
      row.dataset.name = doctorName;
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-label', `View details for ${doctorName}`);
    });
  }
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.page === currentPage));
  const appointmentNavCount = document.querySelector('.nav-link[data-page="appointments"] .nav-count');
  if (appointmentNavCount) appointmentNavCount.textContent = appointmentsLoading ? '…' : appointments.length;
  const notificationButton = document.getElementById('notificationButton');
  const notificationDot = notificationButton.querySelector('i');
  const pendingNotifications = appointments.filter((item) => item.status === 'Pending').length + invoices.filter((item) => item.status === 'Pending').length;
  notificationDot.hidden = pendingNotifications === 0;
  notificationButton.setAttribute('aria-label', pendingNotifications ? `Notifications, ${pendingNotifications} pending` : 'Notifications, all caught up');
  const pageSearch = document.querySelector('.page-search');
  if (pageSearch) {
    pageSearch.addEventListener('input', (event) => {
      searchTerm = event.target.value;
      const cursor = event.target.selectionStart;
      render();
      const next = document.querySelector('.page-search');
      if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
    });
  }
  if (document.activeElement === globalSearch && globalSearch.value.trim()) renderGlobalSearchResults(globalSearch.value);
}

async function loadAppointments() {
  try {
    appointments = await apiRequest('appointments');
    appointmentsError = '';
  } catch (error) {
    appointments = [];
    appointmentsError = error.message;
  } finally {
    appointmentsLoading = false;
    render();
  }
}

async function loadPatients() {
  try {
    patients = await apiRequest('patients');
    patientsError = '';
  } catch (error) {
    patients = [];
    patientsError = error.message;
  } finally {
    patientsLoading = false;
    render();
  }
}

async function loadDoctors() {
  try {
    doctors = await apiRequest('doctors');
    doctorsError = '';
  } catch (error) {
    doctors = [];
    doctorsError = error.message;
  } finally {
    doctorsLoading = false;
    updateDoctorOptions();
    updatePatientDoctorOptions();
    render();
  }
}

async function loadDepartments() {
  try {
    departments = await apiRequest('departments');
    departmentsError = '';
  } catch (error) {
    departments = [];
    departmentsError = error.message;
  } finally {
    departmentsLoading = false;
    updateDepartmentOptions();
    render();
  }
}

async function loadInvoices() {
  try {
    invoices = await apiRequest('invoices');
    invoicesError = '';
  } catch (error) {
    invoices = [];
    invoicesError = error.message;
  } finally {
    invoicesLoading = false;
    render();
  }
}

function renderAdminList() {
  const adminList = document.getElementById('adminList');
  if (!adminList) return;
  if (adminAccountsError) {
    adminList.innerHTML = `<p class="detail-empty">${safe(adminAccountsError)}</p>`;
    return;
  }
  adminList.innerHTML = adminAccounts.length
    ? adminAccounts.map((admin) => `<div class="admin-list-item"><span class="avatar avatar-admin">${safe(initialsFor(admin.name || 'Admin'))}</span><span class="admin-list-copy"><strong>${safe(admin.name)}</strong><small>${safe(admin.email)} · ${safe(admin.role || 'Administrator')}</small></span>${Number(admin.id) === Number(adminProfile?.id) ? '<span class="admin-you">You</span>' : ''}</div>`).join('')
    : '<p class="detail-empty">No admin accounts found.</p>';
}

async function loadAdmins() {
  try {
    adminAccounts = await apiRequest('admins');
    adminAccountsError = '';
  } catch (error) {
    adminAccounts = [];
    adminAccountsError = error.message;
  }
  adminAccountsLoaded = true;
  renderAdminList();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function openModal() {
  modalOpener = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const dateField = modal.querySelector('input[name="date"]');
  if (dateField) dateField.min = localDateISO();
  if (dateField && !dateField.value) dateField.value = localDateISO();
  modal.querySelector('input[name="patient"]').focus();
}

function openPatientModal() {
  patientModalOpener = document.activeElement;
  updatePatientDoctorOptions();
  patientModal.classList.add('open');
  patientModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  patientModal.querySelector('input[name="name"]').focus();
}

function openDataModal(type, record = null) {
  const configurations = {
    doctor: {
      eyebrow: 'DOCTOR',
      title: 'Add a doctor',
      intro: 'Doctor details will be saved to the hospital database.',
      submit: 'Save doctor',
      fields: `<label class="form-field">Doctor name<input name="name" required maxlength="150" placeholder="e.g. Dr. Asha Kumar" /></label>
        <div class="form-row"><label class="form-field">Department<select name="department" required><option value="">Select department</option>${departments.map((department) => `<option value="${safe(department.name)}">${safe(department.name)}</option>`).join('')}</select></label>
        <label class="form-field">Status<select name="status" required><option>Available</option><option>In consultation</option></select></label></div>
        <div class="form-row"><label class="form-field">Experience<input name="experience" maxlength="50" placeholder="e.g. 5 years" /></label>
        <label class="form-field">Patient visits<input name="patients" type="number" min="0" step="1" value="0" required /></label></div>
        <label class="form-field">Card color<select name="color"><option value="mint">Mint</option><option value="blue">Blue</option><option value="peach">Peach</option><option value="lavender">Lavender</option><option value="rose">Rose</option></select></label>`
    },
    department: {
      eyebrow: 'DEPARTMENT',
      title: 'Add a department',
      intro: 'Department details will be saved to the hospital database.',
      submit: 'Save department',
      fields: `<label class="form-field">Department name<input name="name" required maxlength="100" placeholder="e.g. Oncology" /></label>
        <label class="form-field">Description<input name="description" required maxlength="255" placeholder="Care and services provided" /></label>
        <div class="form-row"><label class="form-field">Doctor count<input name="doctors" type="number" min="0" step="1" value="0" required /></label>
        <label class="form-field">Patient count<input name="patients" type="number" min="0" step="1" value="0" required /></label></div>
        <div class="form-row"><label class="form-field">Icon<input name="icon" maxlength="32" value="＋" /></label>
        <label class="form-field">Card color<select name="color"><option value="blue">Blue</option><option value="teal">Teal</option><option value="orange">Orange</option><option value="purple">Purple</option><option value="rose">Rose</option></select></label></div>`
    },
    patient: {
      eyebrow: 'PATIENT',
      title: 'Add a patient',
      intro: 'Patient details will be saved to the hospital database.',
      submit: 'Save patient',
      fields: `<label class="form-field">Full name<input name="name" required maxlength="100" placeholder="Patient name" /></label>
        <div class="form-row"><label class="form-field">Age<input name="age" type="number" min="0" max="130" step="1" /></label>
        <label class="form-field">Gender<select name="gender" required><option value="">Select gender</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></label></div>
        <label class="form-field">Phone<input name="phone" type="tel" maxlength="20" placeholder="Optional" /></label>
        <label class="form-field">Reported illness, diagnosis or symptoms<textarea name="conditionDetails" rows="3" maxlength="5000" placeholder="Enter patient-reported symptoms or a clinician-confirmed diagnosis."></textarea></label>
        <label class="form-field">Doctor for the patient<select name="assignedDoctorId" required><option value="">Select doctor</option>${doctors.map((doctor) => `<option value="${safe(doctor.id)}">${safe(doctor.name)} · ${safe(doctor.department)}</option>`).join('')}</select></label>
        <label class="form-field">Message for the patient<textarea name="patientMessage" rows="3" maxlength="5000" placeholder="Tell the patient which doctor to contact and what appointment to book."></textarea></label>
        <label class="form-field">Private case handoff for the doctor<textarea name="doctorInstructions" rows="3" maxlength="5000" placeholder="Relevant case details for the assigned doctor."></textarea></label>`
    },
    invoice: {
      eyebrow: 'BILLING',
      title: 'Create an invoice',
      intro: 'Invoice details will be saved to the hospital database.',
      submit: 'Save invoice',
      fields: `<label class="form-field">Patient name<input name="patient" required maxlength="150" placeholder="Patient name" /></label>
        <label class="form-field">Service<input name="service" required maxlength="180" placeholder="e.g. Consultation · Cardiology" /></label>
        <div class="form-row"><label class="form-field">Amount (₹)<input name="amount" type="number" min="0" step="0.01" required /></label>
        <label class="form-field">Status<select name="status" required><option>Pending</option><option>Paid</option><option>Cancelled</option></select></label></div>`
    }
  };
  const configuration = configurations[type];
  if (!configuration) return;
  activeDataType = type;
  activeDataRecord = record;
  dataModalOpener = document.activeElement;
  dataForm.reset();
  dataModalEyebrow.textContent = configuration.eyebrow;
  dataModalTitle.textContent = record ? `Edit ${type}` : configuration.title;
  dataModalIntro.textContent = record ? 'Update this record in the hospital database.' : configuration.intro;
  dataModalSubmit.innerHTML = `${configuration.submit} <span>→</span>`;
  dataModalFields.innerHTML = configuration.fields;
  if (record) dataModalSubmit.textContent = 'Save changes';
  if (record) {
    const values = type === 'doctor'
      ? { name: record.name, department: record.department, status: record.status, experience: record.experience, patients: record.patients, color: record.color }
      : type === 'department'
        ? { name: record.name, description: record.description, doctors: record.doctors, patients: record.patients, icon: record.icon, color: record.color }
        : type === 'patient'
          ? { name: record.name, age: record.age, gender: record.gender, phone: record.phone, conditionDetails: record.conditionDetails, assignedDoctorId: record.assignedDoctorId, patientMessage: record.patientMessage, doctorInstructions: record.doctorInstructions }
          : { patient: record.patient, service: record.service, amount: record.amount, status: record.status };
    for (const [fieldName, value] of Object.entries(values)) {
      const field = dataForm.elements.namedItem(fieldName);
      if (field) field.value = value ?? '';
    }
  }
  dataModal.classList.add('open');
  dataModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  dataModalFields.querySelector('input, select')?.focus();
}

function printRecordSummary(title, subtitle, sections) {
  const printWindow = window.open('', '_blank', 'width=800,height=900');
  if (!printWindow) {
    showToast('Allow pop-ups to print this case summary.');
    return;
  }
  const sectionMarkup = sections.map(([heading, value]) => `<section><h2>${safe(heading)}</h2><p>${safe(value || 'Not entered')}</p></section>`).join('');
  printWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(title)}</title><style>body{max-width:760px;margin:40px auto;padding:0 24px;color:#1f2937;font:16px/1.55 Arial,sans-serif}h1{margin-bottom:4px}header{margin-bottom:28px;border-bottom:2px solid #dce5ec;padding-bottom:16px}header p{color:#64748b}section{margin:20px 0;padding:14px 16px;border:1px solid #dce5ec;border-radius:8px;break-inside:avoid}h2{margin:0 0 8px;font-size:14px;color:#31516a}section p{margin:0;white-space:pre-wrap}@media print{body{margin:0 auto;padding:0 12px}}</style></head><body><header><h1>${safe(title)}</h1><p>${safe(subtitle)}</p><small>CarePoint Hospital · Prepared ${safe(new Date().toLocaleString())}</small></header>${sectionMarkup}</body></html>`);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 300);
}

function printPatientInstructions(patient) {
  const doctor = doctors.find((entry) => String(entry.id) === String(patient.assignedDoctorId));
  printRecordSummary(`Patient instructions: ${patient.name}`, `Patient ID #${patient.id} · Share this page with the patient`, [
    ['Assigned doctor', doctor ? `${doctor.name} · ${doctor.department}` : 'No doctor assigned'],
    ['Reported illness, diagnosis or symptoms', patient.conditionDetails],
    ['Message from the hospital admin', patient.patientMessage],
    ['Hospital contact', 'Contact the hospital to confirm the appointment date and time.']
  ]);
}

function printDoctorHandoff(doctor) {
  const assignedCases = patients.filter((patient) => String(patient.assignedDoctorId || '') === String(doctor.id));
  const sections = assignedCases.flatMap((patient) => [
    [`Patient ${patient.name} · #${patient.id}`, `Age: ${patient.age ?? 'Not provided'} · Gender: ${patient.gender || 'Not provided'} · Phone: ${patient.phone || 'Not provided'}`],
    ['Reported illness, diagnosis or symptoms', patient.conditionDetails],
    ['Admin handoff for doctor', patient.doctorInstructions]
  ]);
  printRecordSummary(`Assigned patient handoff: ${doctor.name}`, `${doctor.department} · Confidential patient case details`, sections.length ? sections : [['Assigned patients', 'No patients assigned.']]);
}
function openDetailModal(type, name) {
  const records = {
    doctor: doctors,
    department: departments,
    patient: patients,
    appointment: appointments,
    invoice: invoices
  }[type] || [];
  const record = ['doctor', 'department'].includes(type)
    ? records.find((item) => item.name === name)
    : records.find((item) => String(item.id) === String(name));
  if (!record) {
    showToast('Could not find that record. Refresh the page and try again.');
    return;
  }

  detailModalOpener = document.activeElement;
  if (type === 'doctor') {
    const assignedCases = patients.filter((patient) => String(patient.assignedDoctorId || '') === String(record.id));
    const caseMarkup = patientsLoading
      ? '<p class="detail-empty">Loading assigned patient records...</p>'
      : patientsError
        ? `<p class="detail-empty">${safe(patientsError)}</p>`
        : assignedCases.length
          ? assignedCases.map((patient) => `<article class="case-card"><div class="case-card-head"><strong>${safe(patient.name)} · #${safe(patient.id)}</strong><span>${safe(patient.phone || 'No phone')}</span></div><p><b>Reported illness / symptoms:</b> ${safe(patient.conditionDetails || 'Not entered')}</p><p><b>Admin handoff:</b> ${safe(patient.doctorInstructions || 'No private handoff note entered.')}</p><button class="text-button" type="button" data-action="patient-details" data-name="${safe(patient.id)}">Open patient record</button></article>`).join('')
          : '<p class="detail-empty">No patients have been assigned to this doctor.</p>';
    detailModalEyebrow.textContent = 'DOCTOR PROFILE';
    detailModalTitle.textContent = record.name;
    detailModalContent.innerHTML = `<div class="detail-grid">
      <div class="detail-stat"><span>Department</span><strong>${safe(record.department || 'Not assigned')}</strong></div>
      <div class="detail-stat"><span>Availability</span><strong>${safe(record.status || 'Not specified')}</strong></div>
      <div class="detail-stat"><span>Experience</span><strong>${safe(record.experience || 'Not specified')}</strong></div>
      <div class="detail-stat"><span>Patient visits</span><strong>${safe(record.patients ?? 0)}</strong></div>
    </div>
    <h3 class="detail-section-title">Assigned patient case handoff</h3>
    <p class="detail-description">These admin-entered case details are available for the assigned doctor. Confirm any information with the patient during the visit.</p>
    <div class="case-list">${caseMarkup}</div>`;} else if (type === 'department') {
    const assignedDoctors = doctors.filter((doctor) => doctor.department === record.name);
    const doctorList = assignedDoctors.length
      ? assignedDoctors.map((doctor) => `<div class="detail-doctor">${avatar(doctor.initials || initialsFor(doctor.name), doctor.color)}<span class="detail-doctor-copy"><strong>${safe(doctor.name)}</strong><small>${safe(doctor.experience || 'Experience not listed')}</small></span><span class="availability ${doctor.status === 'Available' ? '' : 'busy'}">${safe(doctor.status || 'Unknown')}</span></div>`).join('')
      : '<p class="detail-empty">No doctors are assigned to this department yet.</p>';
    detailModalEyebrow.textContent = 'DEPARTMENT';
    detailModalTitle.textContent = record.name;
    detailModalContent.innerHTML = `<p class="detail-description">${safe(record.description || 'No description available.')}</p>
      <div class="detail-grid">
        <div class="detail-stat"><span>Doctors listed</span><strong>${safe(record.doctors ?? assignedDoctors.length)}</strong></div>
        <div class="detail-stat"><span>Patients</span><strong>${safe(record.patients ?? 0)}</strong></div>
        <div class="detail-stat"><span>Doctors in directory</span><strong>${assignedDoctors.length}</strong></div>
      </div>
      <h3 class="detail-section-title">Doctors in this department</h3>
      <div class="detail-doctor-list">${doctorList}</div>`;
  } else if (type === 'patient') {
    const assignedDoctor = doctors.find((doctor) => String(doctor.id) === String(record.assignedDoctorId)) || null;
    detailModalEyebrow.textContent = 'PATIENT CASE';
    detailModalTitle.textContent = record.name;
    detailModalContent.innerHTML = `<div class="detail-grid">
      <div class="detail-stat"><span>Patient ID</span><strong>#${safe(record.id)}</strong></div>
      <div class="detail-stat"><span>Age</span><strong>${safe(record.age ?? 'Not provided')}</strong></div>
      <div class="detail-stat"><span>Gender</span><strong>${safe(record.gender || 'Not provided')}</strong></div>
      <div class="detail-stat"><span>Phone</span><strong>${safe(record.phone || 'Not provided')}</strong></div>
      <div class="detail-stat"><span>Registered</span><strong>${formatDate(record.registeredAt)}</strong></div>
      <div class="detail-stat"><span>Assigned doctor</span><strong>${safe(assignedDoctor ? `${assignedDoctor.name} · ${assignedDoctor.department}` : 'Not assigned')}</strong></div>
    </div>
    <section class="case-note"><h3>Reported illness, diagnosis or symptoms</h3><p>${safe(record.conditionDetails || 'No illness or symptom details entered.')}</p></section>
    <section class="case-note patient-message"><h3>Message for the patient</h3><p>${safe(record.patientMessage || 'No patient message entered.')}</p></section>
    <section class="case-note"><h3>Private doctor handoff</h3><p>${safe(record.doctorInstructions || 'No private handoff note entered.')}</p></section>`;} else if (type === 'appointment') {
    detailModalEyebrow.textContent = 'APPOINTMENT';
    detailModalTitle.textContent = `${record.patient} · ${record.id}`;
    const appointmentActions = record.status === 'Pending'
      ? `<div class="detail-actions"><button class="button button-primary" type="button" data-action="appointment-status" data-name="${safe(record.id)}" data-status="Confirmed">Confirm appointment</button><button class="button button-quiet" type="button" data-action="appointment-status" data-name="${safe(record.id)}" data-status="Cancelled">Cancel appointment</button></div>`
      : record.status === 'Confirmed'
        ? `<div class="detail-actions"><button class="button button-quiet" type="button" data-action="appointment-status" data-name="${safe(record.id)}" data-status="Cancelled">Cancel appointment</button></div>`
        : '';
    detailModalContent.innerHTML = `<div class="detail-grid">
      <div class="detail-stat"><span>Patient</span><strong>${safe(record.patient)}</strong></div>
      <div class="detail-stat"><span>Status</span><strong>${safe(record.status)}</strong></div>
      <div class="detail-stat"><span>Doctor</span><strong>${safe(record.doctor)}</strong></div>
      <div class="detail-stat"><span>Department</span><strong>${safe(record.department)}</strong></div>
      <div class="detail-stat"><span>Date</span><strong>${formatDate(record.date)}</strong></div>
      <div class="detail-stat"><span>Time</span><strong>${formatTime(record.time)}</strong></div>
    </div>${appointmentActions}`;
  } else {
    detailModalEyebrow.textContent = 'INVOICE';
    detailModalTitle.textContent = record.id;
    detailModalContent.innerHTML = `<div class="detail-grid">
      <div class="detail-stat"><span>Patient</span><strong>${safe(record.patient)}</strong></div>
      <div class="detail-stat"><span>Payment status</span><strong>${safe(record.status)}</strong></div>
      <div class="detail-stat"><span>Service</span><strong>${safe(record.service)}</strong></div>
      <div class="detail-stat"><span>Amount</span><strong>${formatCurrency(record.amount)}</strong></div>
      <div class="detail-stat"><span>Billing month</span><strong>${safe(record.month || 'Not available')}</strong></div>
    </div>`;
  }

  if (type === 'doctor' || type === 'department') {
    if (type === 'department') {
      detailModalContent.querySelectorAll('.detail-doctor .availability').forEach((badge) => {
        const doctorName = badge.parentElement.querySelector('.detail-doctor-copy strong')?.textContent || '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${badge.className} status-filter-button`;
        button.dataset.action = 'filter-doctors';
        button.dataset.department = record.name;
        button.dataset.status = badge.textContent.trim();
        button.dataset.name = doctorName;
        button.textContent = badge.textContent;
        button.setAttribute('aria-label', `Show ${badge.textContent.trim()} doctors in ${record.name}`);
        badge.replaceWith(button);
      });
    }
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const browseButton = document.createElement('button');
    browseButton.type = 'button';
    browseButton.className = 'button button-primary';
    browseButton.dataset.action = 'filter-doctors';
    browseButton.dataset.department = type === 'doctor' ? record.department : record.name;
    browseButton.dataset.status = 'all';
    browseButton.textContent = type === 'doctor' ? 'View doctors in this department' : 'View department doctors';
    actions.append(browseButton);
    if (type === 'doctor') {
      const handoffButton = document.createElement('button');
      handoffButton.type = 'button';
      handoffButton.className = 'button button-quiet';
      handoffButton.dataset.action = 'print-doctor-handoff';
      handoffButton.dataset.id = String(record.id);
      handoffButton.textContent = 'Print assigned cases';
      actions.append(handoffButton);
    }
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'button button-quiet';
    editButton.dataset.action = 'edit-record';
    editButton.dataset.type = type;
    editButton.dataset.id = String(record.id);
    editButton.textContent = 'Edit';
    actions.append(editButton);
    detailModalContent.append(actions);
  }

  if (type === 'patient' || type === 'invoice') {
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'button button-quiet';
    editButton.dataset.action = 'edit-record';
    editButton.dataset.type = type;
    editButton.dataset.id = String(record.id);
    editButton.textContent = 'Edit';
    actions.append(editButton);
    if (type === 'patient') {
      const printButton = document.createElement('button');
      printButton.type = 'button';
      printButton.className = 'button button-quiet';
      printButton.dataset.action = 'print-patient-instructions';
      printButton.dataset.id = String(record.id);
      printButton.textContent = 'Print patient instructions';
      actions.append(printButton);
      if (record.assignedDoctorId) {
        const appointmentButton = document.createElement('button');
        appointmentButton.type = 'button';
        appointmentButton.className = 'button button-primary';
        appointmentButton.dataset.action = 'patient-book-appointment';
        appointmentButton.dataset.id = String(record.id);
        appointmentButton.textContent = 'Book with assigned doctor';
        actions.append(appointmentButton);
      }
    }
    detailModalContent.append(actions);
  }
  detailModal.classList.add('open');
  detailModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('detailModalClose').focus();
}

function updateDoctorOptions() {
  const departmentField = document.getElementById('appointmentForm').elements.department;
  const doctorField = document.getElementById('appointmentForm').elements.doctor;
  const selectedDepartment = departmentField.value;
  const availableDoctors = doctors.filter((doctor) => !selectedDepartment || doctor.department === selectedDepartment);
  doctorField.innerHTML = `<option value="">Select doctor</option>${availableDoctors.map((doctor) => `<option value="${safe(doctor.name)}">${safe(doctor.name)}</option>`).join('')}`;
}

function updatePatientDoctorOptions() {
  const fields = [
    document.getElementById('patientForm')?.elements.namedItem('assignedDoctorId'),
    activeDataType === 'patient' ? dataForm.elements.namedItem('assignedDoctorId') : null
  ].filter(Boolean);
  for (const doctorField of fields) {
    const previousValue = doctorField.value;
    doctorField.innerHTML = `<option value="">Select doctor</option>${doctors.map((doctor) => `<option value="${safe(doctor.id)}">${safe(doctor.name)} · ${safe(doctor.department)}</option>`).join('')}`;
    if (doctors.some((doctor) => String(doctor.id) === previousValue)) doctorField.value = previousValue;
  }
}

function updateDepartmentOptions() {
  const departmentField = document.getElementById('appointmentForm').elements.department;
  const previousValue = departmentField.value;
  departmentField.innerHTML = `<option value="">Select department</option>${departments.map((department) => `<option value="${safe(department.name)}">${safe(department.name)}</option>`).join('')}`;
  if (departments.some((department) => department.name === previousValue)) departmentField.value = previousValue;
  updateDoctorOptions();
}

function closeModal() {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (modalOpener instanceof HTMLElement) modalOpener.focus();
}

function closePatientModal() {
  patientModal.classList.remove('open');
  patientModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (patientModalOpener instanceof HTMLElement) patientModalOpener.focus();
}

function closeDataModal() {
  dataModal.classList.remove('open');
  dataModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  activeDataType = '';
  activeDataRecord = null;
  if (dataModalOpener instanceof HTMLElement) dataModalOpener.focus();
}

function closeDetailModal() {
  detailModal.classList.remove('open');
  detailModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (detailModalOpener instanceof HTMLElement && detailModalOpener.isConnected) detailModalOpener.focus();
}

function writeLocalObject(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    showToast('Browser storage is unavailable; this change could not be saved.');
    return false;
  }
}

function applyProfile() {
  const name = adminProfile.name || 'Admin User';
  const role = adminProfile.role || 'Administrator';
  document.querySelectorAll('.profile-copy strong, .top-profile strong').forEach((element) => { element.textContent = name; });
  document.querySelectorAll('.profile-copy small, .top-profile small').forEach((element) => { element.textContent = role; });
  document.querySelectorAll('.avatar-admin').forEach((element) => { element.textContent = initialsFor(name); });
  document.querySelectorAll('.profile-mini, .top-profile').forEach((element) => { element.setAttribute('aria-label', `Profile: ${name}`); });
}

function applyPreferences() {
  document.body.classList.toggle('compact-view', Boolean(preferences.compactView));
  document.body.classList.toggle('reduced-motion', Boolean(preferences.reducedMotion));
}

async function openProfileModal() {
  profileModalOpener = document.activeElement;
  try {
    const result = await apiRequest('auth/profile');
    if (result.admin) {
      adminProfile = result.admin;
      applyProfile();
    }
  } catch (error) {
    showToast(`Could not refresh the profile from the database: ${error.message}`);
  }
  profileForm.elements.name.value = adminProfile.name || '';
  profileForm.elements.email.value = adminProfile.email || '';
  profileForm.elements.phone.value = adminProfile.phone || '';
  profileForm.elements.role.value = adminProfile.role || '';
  profileModal.classList.add('open');
  profileModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  profileForm.elements.name.focus();
}

function closeProfileModal() {
  profileModal.classList.remove('open');
  profileModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (profileModalOpener instanceof HTMLElement && profileModalOpener.isConnected) profileModalOpener.focus();
}

function setAuthMode(mode, message = '') {
  authScreen.hidden = false;
  appShell.hidden = true;
  authForm.hidden = mode === 'error';
  otpForm.hidden = true;
  if (resetForm) resetForm.hidden = true;
  if (authModeToggle) {
    authModeToggle.hidden = mode !== 'error';
    authModeToggle.textContent = 'Retry connection';
  }
  authMessage.hidden = !message;
  authMessage.textContent = message;
  authForm.dataset.mode = mode;

  const nameInput = authForm.elements.name;
  const emailInput = authForm.elements.email;
  const phoneInput = authForm.elements.phone;
  const passwordInput = authForm.elements.password;

  if (mode === 'setup' || mode === 'register') {
    authEyebrow.textContent = 'ADMIN REGISTRATION';
    authTitle.textContent = 'Create Admin Account';
    authIntro.textContent = 'Enter your details to create an administrator account.';
    if (authNameField) authNameField.hidden = false;
    if (authEmailField) authEmailField.hidden = false;
    if (authPhoneField) authPhoneField.hidden = false;
    if (authPasswordField) authPasswordField.hidden = false;

    nameInput.required = true;
    emailInput.required = true;
    phoneInput.required = true;
    passwordInput.required = true;

    phoneInput.placeholder = 'e.g. 9876543210';
    authSubmit.textContent = 'Create account & Sign in';

    if (authRegisterToggle) {
      authRegisterToggle.hidden = false;
      authRegisterToggle.textContent = 'Already have an account? Sign in';
    }
    if (authForgotToggle) authForgotToggle.hidden = true;
  } else if (mode === 'login') {
    authEyebrow.textContent = 'SECURE ADMIN ACCESS';
    authTitle.textContent = 'Admin Sign In';
    authIntro.textContent = 'Sign in with your email or mobile number and password.';
    if (authNameField) authNameField.hidden = true;
    if (authEmailField) authEmailField.hidden = false;
    if (authPhoneField) authPhoneField.hidden = false;
    if (authPasswordField) authPasswordField.hidden = false;

    nameInput.required = false;
    emailInput.required = false;
    phoneInput.required = false;
    passwordInput.required = true;

    phoneInput.placeholder = 'e.g. 9876543210';
    authSubmit.textContent = 'Sign in';

    if (authRegisterToggle) {
      authRegisterToggle.hidden = false;
      authRegisterToggle.textContent = 'New admin? Create an account';
    }
    if (authForgotToggle) {
      authForgotToggle.hidden = false;
      authForgotToggle.textContent = 'Forgot / Reset password?';
    }
  } else if (mode === 'forgot') {
    authEyebrow.textContent = 'PASSWORD RECOVERY';
    authTitle.textContent = 'Reset Admin Password';
    authIntro.textContent = 'Enter your registered email or mobile number to receive a verification code.';
    if (authNameField) authNameField.hidden = true;
    if (authEmailField) authEmailField.hidden = false;
    if (authPhoneField) authPhoneField.hidden = true;
    if (authPasswordField) authPasswordField.hidden = true;

    nameInput.required = false;
    emailInput.required = true;
    phoneInput.required = false;
    passwordInput.required = false;

    authSubmit.textContent = 'Send verification code';

    if (authRegisterToggle) {
      authRegisterToggle.hidden = false;
      authRegisterToggle.textContent = 'Back to sign in';
    }
    if (authForgotToggle) authForgotToggle.hidden = true;
  } else {
    authEyebrow.textContent = 'SECURE ADMIN ACCESS';
    authTitle.textContent = 'Service unavailable';
    authIntro.textContent = 'Could not connect to the database. Check MySQL backend.';
    if (authRegisterToggle) authRegisterToggle.hidden = true;
    if (authForgotToggle) authForgotToggle.hidden = true;
  }
  authSubmit.disabled = false;
}

function showOtpStep(challengeToken, phoneMasked, demoCode = '') {
  pendingChallengeToken = challengeToken;
  pendingPhoneMasked = phoneMasked;
  authForm.hidden = true;
  otpForm.hidden = false;
  if (resetForm) resetForm.hidden = true;
  authModeToggle.hidden = true;
  if (authForgotToggle) authForgotToggle.hidden = true;
  otpIntro.textContent = demoCode
    ? `LOCAL DEMO OTP: ${demoCode}. It was not sent by SMS. Use it to continue. It expires in 10 minutes.`
    : `Enter the SMS code sent to ${phoneMasked}. The code expires after a short time.`;
  document.getElementById('otpCodeLabel').textContent = demoCode ? 'Local demo verification code' : 'SMS verification code';
  otpMessage.hidden = true;
  otpMessage.textContent = '';
  otpForm.elements.code.value = '';
  otpForm.elements.code.focus();
}

function showResetStep(challengeToken, phoneMasked, demoCode = '') {
  pendingChallengeToken = challengeToken;
  pendingPhoneMasked = phoneMasked;
  authForm.hidden = true;
  otpForm.hidden = true;
  if (resetForm) resetForm.hidden = false;
  authModeToggle.hidden = true;
  if (authForgotToggle) authForgotToggle.hidden = true;
  const resetIntroEl = document.getElementById('resetIntro');
  const resetMessageEl = document.getElementById('resetMessage');
  const resetCodeLabel = document.getElementById('resetCodeLabel');
  if (resetIntroEl) {
    resetIntroEl.textContent = demoCode
      ? `LOCAL DEMO OTP: ${demoCode}. It was not sent by SMS. Use it with your new password to reset.`
      : `Enter the SMS code sent to ${phoneMasked} and enter your new password.`;
  }
  if (resetCodeLabel) {
    resetCodeLabel.textContent = demoCode ? 'Local demo verification code' : 'SMS verification code';
  }
  if (resetMessageEl) {
    resetMessageEl.hidden = true;
    resetMessageEl.textContent = '';
  }
  if (resetForm) {
    resetForm.elements.code.value = '';
    resetForm.elements.newPassword.value = '';
    resetForm.elements.code.focus();
  }
}

function enterApplication(admin) {
  adminProfile = admin;
  pendingChallengeToken = '';
  pendingPhoneMasked = '';
  authScreen.hidden = true;
  appShell.hidden = false;
  authForm.hidden = false;
  otpForm.hidden = true;
  authMessage.hidden = true;
  currentPage = 'dashboard';
  searchTerm = '';
  applyProfile();
  applyPreferences();
  render();
  loadAppointments();
  loadPatients();
  loadDoctors();
  loadDepartments();
  loadInvoices();
}

async function checkAuthentication() {
  try {
    const status = await apiRequest('auth/status');
    smsConfigured = Boolean(status.smsConfigured);
    demoOtpEnabled = Boolean(status.demoOtpEnabled);
    demoSmsEnabled = Boolean(status.demoSmsEnabled);
    if (status.authenticated && status.admin) {
      enterApplication(status.admin);
    } else {
      const mode = status.setupRequired ? 'setup' : 'login';
      setAuthMode(mode);
    }
  } catch (error) {
    setAuthMode('error', error.message || 'Could not reach the backend. Start the backend and MySQL, then retry.');
  }
}

async function handleLogout() {
  try {
    await apiRequest('auth/logout', { method: 'POST' });
    adminProfile = null;
    adminAccounts = [];
    appointments = [];
    patients = [];
    doctors = [];
    departments = [];
    invoices = [];
    adminAccountsLoaded = false;
    adminAccountsError = '';
    closeProfileModal();
    setAuthMode('login');
    authForm.reset();
  } catch (error) {
    showToast(error.message);
  }
}

function openNotificationModal() {
  notificationModalOpener = document.activeElement;
  const notices = [
    ...appointments.filter((item) => item.status === 'Pending').map((item) => ({ type: 'appointment', id: item.id, title: `Appointment for ${item.patient}`, detail: `${formatDate(item.date)} · ${formatTime(item.time)} with ${item.doctor}` })),
    ...invoices.filter((item) => item.status === 'Pending').map((item) => ({ type: 'invoice', id: item.id, title: `Invoice ${item.id} is unpaid`, detail: `${item.patient} · ${formatCurrency(item.amount)}` }))
  ];
  notificationList.innerHTML = notices.length
    ? `<div class="notification-items">${notices.map((notice) => `<button class="notification-item" type="button" data-action="notification-item" data-type="${notice.type}" data-name="${safe(notice.id)}"><span class="notification-copy"><strong>${safe(notice.title)}</strong><small>${safe(notice.detail)}</small></span><span class="text-button">Open</span></button>`).join('')}</div>`
    : '<p class="detail-empty">You are all caught up. There are no pending appointments or invoices.</p>';
  notificationModal.classList.add('open');
  notificationModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  notificationModal.querySelector('button')?.focus();
}

function closeNotificationModal() {
  notificationModal.classList.remove('open');
  notificationModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (notificationModalOpener instanceof HTMLElement && notificationModalOpener.isConnected) notificationModalOpener.focus();
}

function renderGlobalSearchResults(query) {
  const term = query.trim().toLowerCase();
  if (!term) {
    searchResults.hidden = true;
    searchResults.innerHTML = '';
    return;
  }
  const matches = [
    ...patients.filter((item) => `${item.name} ${item.id} ${item.phone || ''}`.toLowerCase().includes(term)).map((item) => ({ type: 'patient', id: item.id, title: item.name, detail: `Patient · #${item.id}` })),
    ...appointments.filter((item) => `${item.patient} ${item.doctor} ${item.department} ${item.id} ${item.status}`.toLowerCase().includes(term)).map((item) => ({ type: 'appointment', id: item.id, title: item.patient, detail: `Appointment · ${item.doctor} · ${formatDate(item.date)}` })),
    ...doctors.filter((item) => `${item.name} ${item.department} ${item.status}`.toLowerCase().includes(term)).map((item) => ({ type: 'doctor', id: item.name, title: item.name, detail: `Doctor · ${item.department}` })),
    ...departments.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(term)).map((item) => ({ type: 'department', id: item.name, title: item.name, detail: `Department · ${item.description}` })),
    ...invoices.filter((item) => `${item.id} ${item.patient} ${item.service} ${item.status}`.toLowerCase().includes(term)).map((item) => ({ type: 'invoice', id: item.id, title: item.id, detail: `Invoice · ${item.patient} · ${formatCurrency(item.amount)}` }))
  ].slice(0, 10);
  searchResults.innerHTML = matches.length
    ? matches.map((item) => `<button class="search-result" type="button" role="option" data-action="search-result" data-type="${item.type}" data-name="${safe(item.id)}"><strong>${safe(item.title)}</strong><small>${safe(item.detail)}</small></button>`).join('')
    : appointmentsLoading || patientsLoading || doctorsLoading || departmentsLoading || invoicesLoading
      ? '<div class="search-empty">Loading records...</div>'
      : '<div class="search-empty">No matching records found.</div>';
  searchResults.hidden = false;
}

async function checkSystemConnection() {
  const status = document.getElementById('systemStatus');
  if (!status) return;
  status.textContent = 'Checking backend and database...';
  try {
    const [healthResponse, database, authStatus] = await Promise.all([
      fetch(`${API_BASE_URL}/api/health`, { credentials: 'include' }),
      apiRequest('db-check'),
      apiRequest('auth/status')
    ]);
    if (!healthResponse.ok || !database.success) throw new Error('Connection check failed.');
    const smsStatus = authStatus.appointmentSmsConfigured
      ? 'Twilio messaging ready'
      : authStatus.demoSmsEnabled
        ? 'local demo SMS simulation active (no texts sent)'
        : 'SMS unavailable';
    status.textContent = `Backend is online. Database connected: ${database.database}. Appointment SMS: ${smsStatus}.`;
  } catch (error) {
    status.textContent = `Connection check failed: ${error.message}`;
  }
}

async function updateAppointmentStatus(code, status, button) {
  if (!['Pending', 'Confirmed', 'Cancelled'].includes(status)) return;
  if (status === 'Cancelled' && !window.confirm(`Cancel appointment ${code}?`)) return;
  button.disabled = true;
  try {
    const updated = await apiRequest(`appointments/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    appointments = appointments.map((item) => item.id === updated.id ? updated : item);
    appointmentsError = '';
    closeDetailModal();
    render();
    showToast(`Appointment ${status.toLowerCase()}.`);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('#globalSearchBox')) searchResults.hidden = true;
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) {
    event.preventDefault();
    currentPage = pageButton.dataset.page;
    if (currentPage === 'doctors' && pageButton.dataset.filterStatus) selectedDoctorStatus = pageButton.dataset.filterStatus;
    if (currentPage === 'doctors' && pageButton.dataset.filterDepartment) selectedDoctorDepartment = pageButton.dataset.filterDepartment;
    searchTerm = '';
    globalSearch.value = '';
    globalSearchBox.classList.remove('open');
    searchToggle.setAttribute('aria-expanded', 'false');
    searchResults.hidden = true;
    render();
    document.getElementById('sidebar').classList.remove('open');
    return;
  }
  const actionElement = event.target.closest('[data-action]');
  const action = actionElement?.dataset.action;
  if (action === 'new-appointment') { openModal(); return; }
  if (action === 'new-patient') { openPatientModal(); return; }
  if (action === 'add-doctor') { openDataModal('doctor'); return; }
  if (action === 'add-department') { openDataModal('department'); return; }
  if (action === 'new-invoice') { openDataModal('invoice'); return; }
  if (action === 'edit-record') {
    const type = actionElement.dataset.type;
    const records = { doctor: doctors, department: departments, patient: patients, invoice: invoices }[type] || [];
    const record = records.find((item) => String(item.id) === String(actionElement.dataset.id));
    if (!record) {
      showToast('Could not find that record. Refresh the page and try again.');
      return;
    }
    closeDetailModal();
    openDataModal(type, record);
    return;
  }
  if (action === 'doctor-details') { openDetailModal('doctor', actionElement.dataset.name); return; }
  if (action === 'department-details') { openDetailModal('department', actionElement.dataset.name); return; }
  if (action === 'patient-details') { openDetailModal('patient', actionElement.dataset.name); return; }
  if (action === 'print-patient-instructions') {
    const patient = patients.find((item) => String(item.id) === String(actionElement.dataset.id));
    if (patient) printPatientInstructions(patient);
    return;
  }
  if (action === 'print-doctor-handoff') {
    const doctor = doctors.find((item) => String(item.id) === String(actionElement.dataset.id));
    if (doctor) printDoctorHandoff(doctor);
    return;
  }
  if (action === 'patient-book-appointment') {
    const patient = patients.find((item) => String(item.id) === String(actionElement.dataset.id));
    const assignedDoctor = doctors.find((item) => String(item.id) === String(patient?.assignedDoctorId));
    if (!patient || !assignedDoctor) { showToast('Patient or assigned doctor could not be found.'); return; }
    closeDetailModal();
    openModal();
    appointmentForm.elements.patient.value = patient.name;
    appointmentForm.elements.patientPhone.value = patient.phone || '';
    appointmentForm.elements.smsConsent.checked = false;
    updateAppointmentSmsRequirement();
    appointmentForm.elements.department.value = assignedDoctor.department;
    updateDoctorOptions();
    appointmentForm.elements.doctor.value = assignedDoctor.name;
    return;
  }
  if (action === 'appointment-details') { openDetailModal('appointment', actionElement.dataset.name); return; }
  if (action === 'invoice-view' || action === 'invoice-details') { openDetailModal('invoice', actionElement.dataset.name); return; }
  if (action === 'filter-doctors') {
    selectedDoctorDepartment = actionElement.dataset.department || 'all';
    selectedDoctorStatus = ['Available', 'In consultation'].includes(actionElement.dataset.status) ? actionElement.dataset.status : 'all';
    if (detailModal.classList.contains('open')) closeDetailModal();
    currentPage = 'doctors';
    searchTerm = '';
    render();
    return;
  }
  if (action === 'filter-invoices-by-status') {
    selectedInvoiceStatus = actionElement.dataset.status || 'all';
    render();
    return;
  }
  if (action === 'search-result') {
    searchResults.hidden = true;
    globalSearch.value = '';
    globalSearch.focus();
    openDetailModal(actionElement.dataset.type, actionElement.dataset.name);
    return;
  }
  if (action === 'notification-item') {
    const { type, name } = actionElement.dataset;
    closeNotificationModal();
    openDetailModal(type, name);
    return;
  }
  if (action === 'appointment-status') { updateAppointmentStatus(actionElement.dataset.name, actionElement.dataset.status, actionElement); return; }
  if (action === 'check-system') { checkSystemConnection(); return; }
  if (action === 'reset-settings') {
    preferences = { timeFormat: '12h', compactView: false, reducedMotion: false };
    writeLocalObject('carepointPreferences', preferences);
    applyPreferences();
    render();
    showToast('Display settings restored.');
    return;
  }
  if (event.target === modal) closeModal();
  if (event.target === patientModal) closePatientModal();
  if (event.target === dataModal) closeDataModal();
  if (event.target === detailModal) closeDetailModal();
  if (event.target === notificationModal) closeNotificationModal();
  if (event.target === profileModal) closeProfileModal();
});

pageContent.addEventListener('change', (event) => {
  if (event.target.id === 'doctorDepartmentFilter') selectedDoctorDepartment = event.target.value;
  else if (event.target.id === 'doctorStatusFilter') selectedDoctorStatus = event.target.value;
  else if (event.target.id === 'invoiceStatusFilter') selectedInvoiceStatus = event.target.value;
  else return;
  render();
});

const appointmentForm = document.getElementById('appointmentForm');
const appointmentPatientPhone = appointmentForm.elements.patientPhone;
const appointmentSmsConsent = appointmentForm.elements.smsConsent;
function updateAppointmentSmsRequirement() {
  appointmentPatientPhone.required = appointmentSmsConsent.checked;
}
appointmentSmsConsent.addEventListener('change', updateAppointmentSmsRequirement);
updateAppointmentSmsRequirement();
appointmentForm.elements.department.addEventListener('change', updateDoctorOptions);
updateDoctorOptions();

appointmentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const patient = String(data.get('patient')).trim();
  const date = String(data.get('date'));
  const submitButton = appointmentForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const appointment = await apiRequest('appointments', {
      method: 'POST',
      body: JSON.stringify({
        patient,
        patientPhone: normalizeMobilePhone(String(data.get('patientPhone') || '')),
        smsConsent: appointmentSmsConsent.checked,
        date,
        time: String(data.get('time')),
        doctor: String(data.get('doctor')),
        department: String(data.get('department'))
      })
    });
    appointments.unshift(appointment);
    appointmentsError = '';
    event.currentTarget.reset();
    updateAppointmentSmsRequirement();
    updateDoctorOptions();
    closeModal();
    currentPage = 'appointments';
    searchTerm = '';
    render();
    const smsNotification = appointment.smsNotification || {};
    if (smsNotification.confirmation === 'sent') {
      showToast(smsNotification.reminderScheduled
        ? 'Appointment saved; Twilio accepted the confirmation SMS and the 24-hour reminder is scheduled.'
        : 'Appointment saved; Twilio accepted the confirmation SMS. No separate 24-hour reminder is needed for this booking.');
    } else if (smsNotification.confirmation === 'simulated') {
      showToast(smsNotification.reminderScheduled
        ? 'Appointment saved; demo confirmation and reminder were simulated. No SMS was sent.'
        : 'Appointment saved; demo confirmation was simulated. No SMS was sent.');
    } else if (smsNotification.confirmation === 'queued') {
      showToast('Appointment saved; SMS is queued for retry. Check the Twilio Messaging configuration.');
    } else {
      showToast('Appointment saved. SMS was not sent because the patient mobile number and consent are required.');
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById('closeModal').addEventListener('click', closeModal);
document.getElementById('cancelModal').addEventListener('click', closeModal);
document.getElementById('patientCloseModal').addEventListener('click', closePatientModal);
document.getElementById('patientCancelModal').addEventListener('click', closePatientModal);
document.getElementById('dataModalClose').addEventListener('click', closeDataModal);
document.getElementById('dataModalCancel').addEventListener('click', closeDataModal);
document.getElementById('detailModalClose').addEventListener('click', closeDetailModal);
document.getElementById('notificationModalClose').addEventListener('click', closeNotificationModal);
document.getElementById('profileModalClose').addEventListener('click', closeProfileModal);
document.getElementById('profileModalCancel').addEventListener('click', closeProfileModal);
document.getElementById('logoutButton').addEventListener('click', handleLogout);
document.querySelectorAll('.profile-mini, .top-profile').forEach((button) => button.addEventListener('click', openProfileModal));
if (authModeToggle) authModeToggle.addEventListener('click', checkAuthentication);
if (authRegisterToggle) {
  authRegisterToggle.addEventListener('click', () => {
    const current = authForm.dataset.mode;
    if (current === 'register' || current === 'setup') {
      setAuthMode('login');
    } else {
      setAuthMode('register');
    }
  });
}
authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = authForm.dataset.mode;
  if (!['setup', 'register', 'login', 'forgot'].includes(mode)) return;
  const data = new FormData(authForm);
  const submitButton = authForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    if (mode === 'forgot') {
      const email = String(data.get('email') || '').trim();
      const phone = String(data.get('phone') || '').trim();
      const result = await apiRequest('auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ phone: email || phone })
      });
      authForm.reset();
      showResetStep(result.challengeToken, result.phoneMasked, result.demoCode || '');
      return;
    }
    if (mode === 'setup' || mode === 'register') {
      const name = String(data.get('name') || '').trim();
      const email = String(data.get('email') || '').trim();
      const phone = String(data.get('phone') || '').trim();
      const password = String(data.get('password') || '');
      const result = await apiRequest('auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, phone, password })
      });
      authForm.reset();
      if (result.authenticated && result.admin) {
        showToast('Admin account created! Signed in successfully.');
        enterApplication(result.admin);
        return;
      }
      if (result.otpRequired) {
        showOtpStep(result.challengeToken, result.phoneMasked, result.demoCode || '');
        return;
      }
      return;
    }
    if (mode === 'login') {
      const email = String(data.get('email') || '').trim();
      const phone = String(data.get('phone') || '').trim();
      const password = String(data.get('password') || '');
      if (!email && !phone) {
        setAuthMode('login', 'Please enter your email or mobile number.');
        return;
      }
      const result = await apiRequest('auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, phone, password })
      });
      authForm.reset();
      if (result.authenticated && result.admin) {
        showToast('Signed in successfully!');
        enterApplication(result.admin);
        return;
      }
      if (result.otpRequired) {
        showOtpStep(result.challengeToken, result.phoneMasked, result.demoCode || '');
        return;
      }
    }
  } catch (error) {
    setAuthMode(mode, error.message);
  } finally {
    submitButton.disabled = false;
  }
});
otpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = otpForm.querySelector('button[type="submit"]');
  button.disabled = true;
  otpMessage.hidden = true;
  try {
    const result = await apiRequest('auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ challengeToken: pendingChallengeToken, code: String(new FormData(otpForm).get('code')).trim() })
    });
    enterApplication(result.admin);
  } catch (error) {
    otpMessage.textContent = error.message;
    otpMessage.hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.getElementById('otpResend').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  otpMessage.hidden = true;
  try {
    const result = await apiRequest('auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify({ challengeToken: pendingChallengeToken })
    });
    otpIntro.textContent = result.demoCode
      ? `LOCAL DEMO OTP: ${result.demoCode}. It was not sent by SMS. Use it to continue. It expires in 10 minutes.`
      : `A new SMS code was sent to ${result.phoneMasked || pendingPhoneMasked}.`;
  } catch (error) {
    otpMessage.textContent = error.message;
    otpMessage.hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.getElementById('otpBack').addEventListener('click', () => {
  pendingChallengeToken = '';
  pendingPhoneMasked = '';
  otpForm.hidden = true;
  setAuthMode('login');
});
if (resetForm) {
  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = resetForm.querySelector('button[type="submit"]');
    button.disabled = true;
    const resetMsg = document.getElementById('resetMessage');
    if (resetMsg) resetMsg.hidden = true;
    try {
      const data = new FormData(resetForm);
      const result = await apiRequest('auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          challengeToken: pendingChallengeToken,
          code: String(data.get('code')).trim(),
          newPassword: String(data.get('newPassword'))
        })
      });
      showToast('Password reset successfully! Signed in.');
      enterApplication(result.admin);
    } catch (error) {
      if (resetMsg) {
        resetMsg.textContent = error.message;
        resetMsg.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });
}
const resetResendBtn = document.getElementById('resetResend');
if (resetResendBtn) {
  resetResendBtn.addEventListener('click', async (event) => {
    if (!pendingChallengeToken) return;
    const button = event.currentTarget;
    button.disabled = true;
    const resetMsg = document.getElementById('resetMessage');
    const resetIntroEl = document.getElementById('resetIntro');
    if (resetMsg) resetMsg.hidden = true;
    try {
      const result = await apiRequest('auth/resend-otp', {
        method: 'POST',
        body: JSON.stringify({ challengeToken: pendingChallengeToken })
      });
      if (resetIntroEl) {
        resetIntroEl.textContent = result.demoCode
          ? `LOCAL DEMO OTP: ${result.demoCode}. Use it with your new password to reset. Expires in 10 minutes.`
          : `A new SMS code was sent to ${result.phoneMasked || pendingPhoneMasked}.`;
      }
      if (result.demoCode && resetMsg) {
        resetMsg.hidden = false;
        resetMsg.innerHTML = `<strong>LOCAL DEMO OTP:</strong> Use code <code>${safe(result.demoCode)}</code>.`;
      }
    } catch (error) {
      if (resetMsg) {
        resetMsg.textContent = error.message;
        resetMsg.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });
}
const resetBackBtn = document.getElementById('resetBack');
if (resetBackBtn) {
  resetBackBtn.addEventListener('click', () => {
    pendingChallengeToken = '';
    pendingPhoneMasked = '';
    if (resetForm) resetForm.hidden = true;
    setAuthMode('login');
  });
}
if (authForgotToggle) {
  authForgotToggle.addEventListener('click', () => {
    if (authForm.dataset.mode === 'forgot') {
      setAuthMode('login');
    } else {
      setAuthMode('forgot');
    }
  });
}
document.addEventListener('focusout', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && !input.readOnly &&
      (input.type === 'tel' || input === authForm.elements.phone)) {
    input.value = normalizeMobilePhone(input.value);
  }
});
profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(profileForm);
  const submitButton = profileForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const result = await apiRequest('auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name: String(data.get('name')).trim(), email: String(data.get('email')).trim() })
    });
    adminProfile = result.admin;
    applyProfile();
    closeProfileModal();
    render();
    showToast('Admin profile saved to the database.');
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});
pageContent.addEventListener('submit', (event) => {
  if (event.target.id !== 'settingsForm') return;
  event.preventDefault();
  const data = new FormData(event.target);
  const nextPreferences = {
    timeFormat: String(data.get('timeFormat')) === '24h' ? '24h' : '12h',
    compactView: data.has('compactView'),
    reducedMotion: data.has('reducedMotion')
  };
  if (!writeLocalObject('carepointPreferences', nextPreferences)) return;
  preferences = nextPreferences;
  applyPreferences();
  render();
  showToast('Display settings saved.');
});
pageContent.addEventListener('submit', async (event) => {
  if (event.target.id === 'passwordForm') {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const newPassword = String(data.get('newPassword'));
    if (newPassword !== String(data.get('confirmPassword'))) {
      showToast('New password and confirmation do not match.');
      return;
    }
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      await apiRequest('auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: String(data.get('currentPassword')), newPassword })
      });
      form.reset();
      showToast('Password updated. Other sessions for this admin were signed out.');
    } catch (error) {
      showToast(error.message);
    } finally {
      submitButton.disabled = false;
    }
    return;
  }
  if (event.target.id === 'adminForm') {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const admin = await apiRequest('admins', {
        method: 'POST',
        body: JSON.stringify({ name: String(data.get('name')).trim(), email: String(data.get('email')).trim(), phone: normalizeMobilePhone(String(data.get('phone'))), password: String(data.get('password')) })
      });
      adminAccounts.push(admin);
      adminAccountsError = '';
      renderAdminList();
      form.reset();
      showToast('Admin account created. They can now sign in with their own credentials.');
    } catch (error) {
      showToast(error.message);
    } finally {
      submitButton.disabled = false;
    }
  }
});
const patientForm = document.getElementById('patientForm');
patientForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(patientForm);
  const submitButton = patientForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const patient = await apiRequest('patients', {
      method: 'POST',
      body: JSON.stringify({
        name: String(data.get('name')).trim(),
        age: String(data.get('age')).trim(),
        gender: String(data.get('gender')),
        phone: normalizeMobilePhone(String(data.get('phone'))),
        conditionDetails: String(data.get('conditionDetails')).trim(),
        assignedDoctorId: String(data.get('assignedDoctorId') || ''),
        patientMessage: String(data.get('patientMessage')).trim(),
        doctorInstructions: String(data.get('doctorInstructions')).trim()
      })
    });
    patients.unshift(patient);
    patientsError = '';
    patientForm.reset();
    closePatientModal();
    currentPage = 'patients';
    searchTerm = '';
    render();
    showToast('Patient saved to the database.');
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});
dataForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(dataForm);
  const submitButton = dataForm.querySelector('button[type="submit"]');
  const dataType = activeDataType;
  const editedRecord = activeDataRecord;
  const method = editedRecord ? 'PATCH' : 'POST';
  let endpoint;
  let payload;
  submitButton.disabled = true;
  if (dataType === 'doctor') {
    endpoint = `doctors${editedRecord ? `/${encodeURIComponent(editedRecord.id)}` : ''}`;
    payload = {
      name: String(data.get('name')).trim(),
      department: String(data.get('department')),
      status: String(data.get('status')),
      experience: String(data.get('experience')).trim(),
      patients: String(data.get('patients')),
      color: String(data.get('color'))
    };
  } else if (dataType === 'department') {
    endpoint = `departments${editedRecord ? `/${encodeURIComponent(editedRecord.id)}` : ''}`;
    payload = {
      name: String(data.get('name')).trim(),
      description: String(data.get('description')).trim(),
      doctors: String(data.get('doctors')),
      patients: String(data.get('patients')),
      icon: String(data.get('icon')).trim(),
      color: String(data.get('color'))
    };
  } else if (dataType === 'patient') {
    endpoint = `patients${editedRecord ? `/${encodeURIComponent(editedRecord.id)}` : ''}`;
    payload = {
      name: String(data.get('name')).trim(),
      age: String(data.get('age')).trim(),
      gender: String(data.get('gender')),
      phone: normalizeMobilePhone(String(data.get('phone'))),
      conditionDetails: String(data.get('conditionDetails')).trim(),
      assignedDoctorId: String(data.get('assignedDoctorId') || ''),
      patientMessage: String(data.get('patientMessage')).trim(),
      doctorInstructions: String(data.get('doctorInstructions')).trim()
    };
  } else {
    endpoint = `invoices${editedRecord ? `/${encodeURIComponent(editedRecord.id)}` : ''}`;
    payload = {
      patient: String(data.get('patient')).trim(),
      service: String(data.get('service')).trim(),
      amount: String(data.get('amount')),
      status: String(data.get('status'))
    };
  }

  try {
    const saved = await apiRequest(endpoint, {
      method,
      body: JSON.stringify(payload)
    });
    const pageForType = { doctor: 'doctors', department: 'departments', patient: 'patients', invoice: 'billing' };
    const messageForType = {
      doctor: editedRecord ? 'Doctor updated in the database.' : 'Doctor saved to the database.',
      department: editedRecord ? 'Department updated in the database.' : 'Department saved to the database.',
      patient: editedRecord ? 'Patient updated in the database.' : 'Patient saved to the database.',
      invoice: editedRecord ? 'Invoice updated in the database.' : 'Invoice saved to the database.'
    };
    const replaceOrAdd = (items) => editedRecord
      ? items.map((item) => String(item.id) === String(editedRecord.id) ? saved : item)
      : [saved, ...items];
    if (dataType === 'doctor') {
      doctors = replaceOrAdd(doctors).sort((first, second) => second.patients - first.patients);
      doctorsError = '';
      doctorsLoading = false;
      updateDoctorOptions();
      updatePatientDoctorOptions();
      await loadDepartments();
    } else if (dataType === 'department') {
      departments = replaceOrAdd(departments);
      if (editedRecord && editedRecord.name !== saved.name) {
        doctors = doctors.map((doctor) => doctor.department === editedRecord.name ? { ...doctor, department: saved.name } : doctor);
      }
      departmentsError = '';
      departmentsLoading = false;
      updateDepartmentOptions();
    } else if (dataType === 'patient') {
      patients = replaceOrAdd(patients);
      patientsError = '';
      patientsLoading = false;
    } else {
      invoices = replaceOrAdd(invoices);
      invoicesError = '';
      invoicesLoading = false;
    }
    currentPage = pageForType[dataType];
    searchTerm = '';
    closeDataModal();
    render();
    showToast(messageForType[dataType]);
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});
document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('notificationButton').addEventListener('click', openNotificationModal);
searchToggle.addEventListener('click', () => {
  if (!window.matchMedia('(max-width: 780px)').matches) {
    globalSearch.focus();
    return;
  }
  const isOpen = globalSearchBox.classList.toggle('open');
  searchToggle.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    globalSearch.focus();
  } else {
    globalSearch.value = '';
    searchTerm = '';
    searchResults.hidden = true;
    render();
  }
});

globalSearch.addEventListener('input', (event) => {
  renderGlobalSearchResults(event.target.value);
});
document.addEventListener('keydown', (event) => {
  const keyboardAction = event.target.closest('[data-action][role="button"]');
  if (keyboardAction && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    keyboardAction.click();
  }
  const keyboardPage = event.target.closest('[data-page][role="link"]');
  if (keyboardPage && event.key === 'Enter') {
    event.preventDefault();
    keyboardPage.click();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (window.matchMedia('(max-width: 780px)').matches) {
      globalSearchBox.classList.add('open');
      searchToggle.setAttribute('aria-expanded', 'true');
    }
    globalSearch.focus();
    renderGlobalSearchResults(globalSearch.value);
  }
  if (event.key === 'Escape' && !searchResults.hidden) {
    searchResults.hidden = true;
    globalSearch.blur();
  }
  if (event.key === 'Escape' && modal.classList.contains('open')) closeModal();
  if (event.key === 'Escape' && patientModal.classList.contains('open')) closePatientModal();
  if (event.key === 'Escape' && dataModal.classList.contains('open')) closeDataModal();
  if (event.key === 'Escape' && detailModal.classList.contains('open')) closeDetailModal();
  if (event.key === 'Escape' && notificationModal.classList.contains('open')) closeNotificationModal();
  if (event.key === 'Escape' && profileModal.classList.contains('open')) closeProfileModal();
});

applyPreferences();
checkAuthentication();
