const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const { randomBytes, randomInt, scrypt: scryptCallback, createHash, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3001;
const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'carepoint_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

app.use(cors({
  origin(origin, callback) {
    // Allows localhost, local LAN phones, and public tunnel URLs
    callback(null, true);
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Detect cloud-managed databases (e.g. TiDB Cloud, Aiven, ClearDB, or DB_SSL flag)
const isCloudDatabase = process.env.DB_SSL === 'true' ||
  Boolean(process.env.DB_HOST && (
    process.env.DB_HOST.includes('tidbcloud.com') ||
    process.env.DB_HOST.includes('aivencloud.com') ||
    process.env.DB_HOST.includes('cleardb.net') ||
    Number(process.env.DB_PORT) === 4000
  ));

// MySQL connection pool
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hospital_management',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  ssl: isCloudDatabase ? { rejectUnauthorized: false } : undefined
});

let databaseReady;
let appointmentsTableReady;
let dashboardTablesReady;
let patientsTableReady;
let authTablesReady;

async function ensureDatabaseExists() {
  if (!databaseReady) {
    databaseReady = (async () => {
      try {
        const tempConnection = await mysql.createConnection({
          host: process.env.DB_HOST || '127.0.0.1',
          port: Number(process.env.DB_PORT) || 3306,
          user: process.env.DB_USER || 'root',
          password: process.env.DB_PASSWORD || '',
          connectTimeout: 10000,
          ssl: isCloudDatabase ? { rejectUnauthorized: false } : undefined
        });
        const dbName = process.env.DB_NAME || 'hospital_management';
        await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(() => {});
        await tempConnection.end().catch(() => {});
      } catch (err) {
        // In cloud managed databases, connection without database or CREATE DATABASE might be restricted; continue to let pool connect
        console.warn('ensureDatabaseExists skipped or cloud database in use:', err.message);
      }
    })().catch((err) => {
      databaseReady = null;
      throw err;
    });
  }
  await databaseReady;
}

async function ensureAuthTables() {
  await ensureDatabaseExists();
  if (!authTablesReady) {
    authTablesReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS admins (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(150) NOT NULL,
          mobile_phone VARCHAR(20) NULL,
          role VARCHAR(80) NOT NULL DEFAULT 'Administrator',
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY unique_admin_email (email),
          UNIQUE KEY unique_admin_mobile_phone (mobile_phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      const [phoneColumns] = await db.query("SHOW COLUMNS FROM admins LIKE 'mobile_phone'");
      if (!phoneColumns.length) await db.query('ALTER TABLE admins ADD COLUMN mobile_phone VARCHAR(20) NULL AFTER email');
      const [phoneIndexes] = await db.query("SHOW INDEX FROM admins WHERE Key_name = 'unique_admin_mobile_phone'");
      if (!phoneIndexes.length) await db.query('ALTER TABLE admins ADD UNIQUE KEY unique_admin_mobile_phone (mobile_phone)');
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          token_hash CHAR(64) NOT NULL,
          admin_id BIGINT UNSIGNED NOT NULL,
          expires_at DATETIME NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (token_hash),
          KEY idx_admin_sessions_expiry (expires_at),
          CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins(id)
            ON UPDATE CASCADE ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_login_challenges (
          challenge_hash CHAR(64) NOT NULL,
          admin_id BIGINT UNSIGNED NOT NULL,
          expires_at DATETIME NOT NULL,
          attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
          demo_mode TINYINT(1) NOT NULL DEFAULT 0,
          otp_hash CHAR(64) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (challenge_hash),
          UNIQUE KEY unique_admin_login_challenge (admin_id),
          KEY idx_admin_login_challenge_expiry (expires_at),
          CONSTRAINT fk_admin_login_challenge_admin FOREIGN KEY (admin_id) REFERENCES admins(id)
            ON UPDATE CASCADE ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      const [demoModeColumns] = await db.query("SHOW COLUMNS FROM admin_login_challenges LIKE 'demo_mode'");
      if (!demoModeColumns.length) {
        await db.query('ALTER TABLE admin_login_challenges ADD COLUMN demo_mode TINYINT(1) NOT NULL DEFAULT 0 AFTER attempts');
      }
      const [otpHashColumns] = await db.query("SHOW COLUMNS FROM admin_login_challenges LIKE 'otp_hash'");
      if (!otpHashColumns.length) {
        await db.query('ALTER TABLE admin_login_challenges ADD COLUMN otp_hash CHAR(64) NULL AFTER demo_mode');
      }
    })().catch((error) => {
      authTablesReady = null;
      throw error;
    });
  }
  await authTablesReady;
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const entry = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)) : '';
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DURATION_MS
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
}

function publicAdmin(admin) {
  return { id: admin.id, name: admin.name, email: admin.email, phone: admin.mobile_phone || admin.phone || '', role: admin.role };
}

async function getAdminForToken(token) {
  if (!token) return null;
  const [rows] = await db.execute(`
    SELECT admins.id, admins.name, admins.email, admins.mobile_phone, admins.role
    FROM admin_sessions
    INNER JOIN admins ON admins.id = admin_sessions.admin_id
    WHERE admin_sessions.token_hash = ? AND admin_sessions.expires_at > NOW()
    LIMIT 1
  `, [hashSessionToken(token)]);
  return rows[0] || null;
}

async function createAdminSession(connection, adminId, res) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await connection.execute(
    'INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)',
    [hashSessionToken(token), adminId, expiresAt]
  );
  if (res) setSessionCookie(res, token);
  return token;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '16384' || parts[2] !== '8' || parts[3] !== '1') return false;
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

function isTwilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID);
}

function isDemoOtpEnabled() {
  return (process.env.DEMO_OTP_ENABLED === 'true' || process.env.NODE_ENV !== 'production') &&
    process.env.DEMO_OTP_ENABLED !== 'false' &&
    !isTwilioConfigured();
}

function isOtpAvailable() {
  return isTwilioConfigured() || isDemoOtpEnabled();
}

function createDemoOtp() {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validMobilePhone(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone);
}

function normalizeMobilePhone(phone) {
  if (typeof phone !== 'string') return '';
  let normalized = phone.trim().replace(/[\s()-]/g, '');
  if (/^\d{10}$/.test(normalized)) normalized = `+91${normalized}`;
  else if (/^0\d{10}$/.test(normalized)) normalized = `+91${normalized.slice(1)}`;
  else if (/^91\d{10}$/.test(normalized)) normalized = `+${normalized}`;
  else if (/^00[1-9]\d{7,14}$/.test(normalized)) normalized = `+${normalized.slice(2)}`;
  return normalized;
}

function maskPhone(phone) {
  return phone.length > 4 ? `${phone.slice(0, 3)}${'*'.repeat(Math.max(4, phone.length - 7))}${phone.slice(-4)}` : phone;
}

async function twilioVerifyRequest(resource, fields) {
  if (!isTwilioConfigured()) {
    throw httpError('SMS OTP is not configured. Add Twilio Verify settings to the backend .env file.', 503);
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const authHeader = Buffer.from(`${accountSid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  let response;
  try {
    response = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(verifyServiceSid)}/${resource}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw httpError('Could not reach the SMS provider. Check the internet connection and Twilio settings.', 502);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Twilio Verify request failed (${response.status}, code ${result.code || 'unknown'}).`);
    throw httpError('Twilio could not process this OTP. Check the Verify service, phone number format, and SMS permissions.', 502);
  }
  return result;
}

async function createOtpChallenge(connection, adminId, phone) {
  const demoMode = isDemoOtpEnabled();
  if (!isOtpAvailable()) {
    throw httpError('SMS OTP is not configured. Add Twilio Verify settings to the backend .env file.', 503);
  }
  const [recentChallenges] = await connection.execute(`
    SELECT challenge_hash FROM admin_login_challenges
    WHERE admin_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 60 SECOND)
    LIMIT 1
  `, [adminId]);
  if (recentChallenges.length) throw httpError('Please wait 60 seconds before requesting another OTP.', 429);

  const challengeToken = randomBytes(32).toString('base64url');
  const challengeHash = hashSessionToken(challengeToken);
  const demoCode = demoMode ? createDemoOtp() : null;
  const otpHash = demoCode ? createHash('sha256').update(demoCode).digest('hex') : null;
  await connection.execute(`
    INSERT INTO admin_login_challenges (challenge_hash, admin_id, expires_at, attempts, demo_mode, otp_hash)
    VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0, ?, ?)
    ON DUPLICATE KEY UPDATE challenge_hash = VALUES(challenge_hash), expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE), attempts = 0, demo_mode = VALUES(demo_mode), otp_hash = VALUES(otp_hash), created_at = CURRENT_TIMESTAMP
  `, [challengeHash, adminId, demoMode ? 1 : 0, otpHash]);

  if (!demoMode) {
    try {
      await twilioVerifyRequest('Verifications', { To: phone, Channel: 'sms' });
    } catch (error) {
      await connection.execute('DELETE FROM admin_login_challenges WHERE challenge_hash = ?', [challengeHash]).catch(() => {});
      throw error;
    }
  }
  return { challengeToken, demoCode, demoMode };
}

async function verifyOtpCode(phone, code) {
  const result = await twilioVerifyRequest('VerificationCheck', { To: phone, Code: code });
  return result.status === 'approved';
}

function isTwilioMessagingConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_SMS_FROM_NUMBER)
  );
}

function isDemoSmsEnabled() {
  return (process.env.DEMO_SMS_ENABLED === 'true' || process.env.NODE_ENV !== 'production') &&
    process.env.DEMO_SMS_ENABLED !== 'false' &&
    !isTwilioMessagingConfigured();
}

async function sendSmsMessage(phone, message) {
  if (!isTwilioMessagingConfigured()) {
    throw httpError('Appointment SMS is not configured. Add a Twilio Messaging Service SID or sender number to the backend .env file.', 503);
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authHeader = Buffer.from(`${accountSid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const fields = new URLSearchParams({ To: phone, Body: message });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    fields.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  } else {
    fields.set('From', process.env.TWILIO_SMS_FROM_NUMBER);
  }

  let response;
  try {
    response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: fields,
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw httpError('Could not reach the SMS provider. Check the internet connection and Twilio settings.', 502);
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Appointment SMS request failed (${response.status}, code ${result.code || 'unknown'}).`);
    throw httpError('Twilio could not accept the appointment SMS. Check the Messaging Service, sender, and destination permissions.', 502);
  }
  return { sid: result.sid || null, providerStatus: result.status || 'accepted' };
}

function validAdminDetails(name, email, phone, password) {
  return Boolean(
    name && name.length <= 100 &&
    email.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    validMobilePhone(phone) &&
    typeof password === 'string' && password.length >= 10 && password.length <= 200
  );
}

async function requireAdmin(req, res, next) {
  try {
    await ensureAuthTables();
    const admin = await getAdminForToken(getSessionToken(req));
    if (!admin) {
      clearSessionCookie(res);
      return res.status(401).json({ message: 'Please log in to continue.' });
    }
    req.admin = admin;
    return next();
  } catch (error) {
    console.error('Admin session check error:', error.message);
    return res.status(500).json({ message: 'Authentication service is unavailable.' });
  }
}

app.get('/api/auth/status', async (req, res) => {
  try {
    await ensureAuthTables();
    const [[count]] = await db.query('SELECT COUNT(*) AS total FROM admins');
    const admin = await getAdminForToken(getSessionToken(req));
    res.json({
      setupRequired: Number(count.total) === 0,
      authenticated: Boolean(admin),
      smsConfigured: isTwilioConfigured(),
      demoOtpEnabled: isDemoOtpEnabled(),
      demoSmsEnabled: isDemoSmsEnabled(),
      otpAvailable: isOtpAvailable(),
      appointmentSmsConfigured: isTwilioMessagingConfigured(),
      admin: admin ? publicAdmin(admin) : null
    });
  } catch (error) {
    console.error('Authentication status error:', error.message);
    res.status(500).json({ message: 'Database is not ready. Check the backend and MySQL connection.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const phone = normalizeMobilePhone(req.body?.phone);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!validAdminDetails(name, email, phone, password)) {
    return res.status(400).json({ message: 'Enter a name, valid email, E.164 mobile number (+country code), and password with at least 10 characters.' });
  }
  if (!isOtpAvailable()) return res.status(503).json({ message: 'OTP sign-in is unavailable. Configure Twilio Verify or enable local demo OTP in backend/.env.' });

  let connection;
  let lockAcquired = false;
  let transactionStarted = false;
  try {
    await ensureAuthTables();
    connection = await db.getConnection();
    const [[lock]] = await connection.query("SELECT GET_LOCK('carepoint_admin_bootstrap', 10) AS acquired");
    lockAcquired = Number(lock.acquired) === 1;
    if (!lockAcquired) return res.status(503).json({ message: 'Initial admin setup is busy. Please try again.' });
    const [[count]] = await connection.query('SELECT COUNT(*) AS total FROM admins');
    if (Number(count.total) !== 0) return res.status(403).json({ message: 'Initial setup is already complete. Please log in.' });

    const passwordHash = await hashPassword(password);
    await connection.beginTransaction();
    transactionStarted = true;
    const [result] = await connection.execute(
      'INSERT INTO admins (name, email, mobile_phone, password_hash) VALUES (?, ?, ?, ?)',
      [name, email, phone, passwordHash]
    );
    const challenge = await createOtpChallenge(connection, result.insertId, phone);
    await connection.commit();
    transactionStarted = false;
    res.status(201).json({ otpRequired: true, ...challenge, phoneMasked: maskPhone(phone) });
  } catch (error) {
    console.error('Initial admin setup error:', error.message);
    if (transactionStarted && connection) await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'An admin already uses this email or mobile number.' });
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Could not create the initial admin account.' });
  } finally {
    if (connection) {
      if (lockAcquired) await connection.query("SELECT RELEASE_LOCK('carepoint_admin_bootstrap')").catch(() => {});
      connection.release();
    }
  }
});

app.post('/api/auth/login', async (req, res) => {
  const identifier = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const normalizedPhone = normalizeMobilePhone(identifier);
  const isPhone = validMobilePhone(normalizedPhone);
  const isEmail = identifier.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  if ((!isPhone && !isEmail) || !password || password.length > 200) {
    return res.status(400).json({ message: 'Enter your registered email or mobile number and password.' });
  }
  if (!isOtpAvailable()) return res.status(503).json({ message: 'OTP sign-in is unavailable. Configure Twilio Verify or enable local demo OTP in backend/.env.' });
  try {
    await ensureAuthTables();
    const normalizedIdentifier = isEmail ? identifier.toLowerCase() : normalizedPhone;
    const [rows] = await db.execute(
      'SELECT id, name, email, mobile_phone, role, password_hash FROM admins WHERE mobile_phone = ? OR email = ? LIMIT 1',
      [normalizedIdentifier, normalizedIdentifier]
    );
    const admin = rows[0];
    const passwordMatches = admin && password.length <= 200 ? await verifyPassword(password, admin.password_hash) : false;
    if (!passwordMatches) return res.status(401).json({ message: 'Email or mobile number or password is incorrect.' });
    const connection = await db.getConnection();
    try {
      const challenge = await createOtpChallenge(connection, admin.id, admin.mobile_phone);
      res.json({ otpRequired: true, ...challenge, phoneMasked: maskPhone(admin.mobile_phone) });
    } catch (error) {
      console.error('Admin OTP request error:', error.message);
      res.status(error.status || 500).json({ message: error.status ? error.message : 'Could not send the sign-in OTP.' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Admin login error:', error.message);
    res.status(500).json({ message: 'Could not sign in. Check the backend and database.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = getSessionToken(req);
    if (token) {
      await ensureAuthTables();
      await db.execute('DELETE FROM admin_sessions WHERE token_hash = ?', [hashSessionToken(token)]);
    }
    clearSessionCookie(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Admin logout error:', error.message);
    clearSessionCookie(res);
    res.status(500).json({ message: 'Could not sign out cleanly.' });
  }
});

app.post('/api/auth/resend-otp', async (req, res) => {
  const challengeToken = typeof req.body?.challengeToken === 'string' ? req.body.challengeToken : '';
  if (!challengeToken) return res.status(400).json({ message: 'Sign-in challenge expired. Please sign in again.' });
  let connection;
  try {
    await ensureAuthTables();
    connection = await db.getConnection();
    const challengeHash = hashSessionToken(challengeToken);
    const [rows] = await connection.execute(`
      SELECT challenges.admin_id, challenges.demo_mode, admins.mobile_phone AS phone,
      (challenges.created_at > DATE_SUB(NOW(), INTERVAL 60 SECOND)) AS recentlySent
      FROM admin_login_challenges AS challenges
      INNER JOIN admins ON admins.id = challenges.admin_id
      WHERE challenges.challenge_hash = ? AND challenges.expires_at > NOW()
      LIMIT 1
    `, [challengeHash]);
    if (!rows.length) return res.status(401).json({ message: 'Sign-in challenge expired. Please sign in again.' });
    if (Number(rows[0].recentlySent)) return res.status(429).json({ message: 'Please wait 60 seconds before requesting another OTP.' });
    if (Number(rows[0].demo_mode)) {
      if (!isDemoOtpEnabled()) return res.status(503).json({ message: 'This demo OTP challenge is no longer available. Sign in again.' });
      const demoCode = createDemoOtp();
      const otpHash = createHash('sha256').update(demoCode).digest('hex');
      await connection.execute(`
        UPDATE admin_login_challenges
        SET otp_hash = ?, attempts = 0, expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE), created_at = CURRENT_TIMESTAMP
        WHERE challenge_hash = ?
      `, [otpHash, challengeHash]);
      return res.json({ sent: true, demoMode: true, demoCode, phoneMasked: maskPhone(rows[0].phone) });
    }
    if (!isTwilioConfigured()) return res.status(503).json({ message: 'SMS OTP is not configured. Add Twilio Verify settings to backend/.env.' });
    await connection.execute('UPDATE admin_login_challenges SET created_at = CURRENT_TIMESTAMP WHERE challenge_hash = ?', [challengeHash]);
    await twilioVerifyRequest('Verifications', { To: rows[0].phone, Channel: 'sms' });
    res.json({ sent: true, demoMode: false, phoneMasked: maskPhone(rows[0].phone) });
  } catch (error) {
    console.error('OTP resend error:', error.message);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Could not resend the OTP.' });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const challengeToken = typeof req.body?.challengeToken === 'string' ? req.body.challengeToken : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!challengeToken || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ message: 'Enter the verification code sent to your phone.' });
  }

  let connection;
  try {
    await ensureAuthTables();
    connection = await db.getConnection();
    const challengeHash = hashSessionToken(challengeToken);
    const [rows] = await connection.execute(`
      SELECT challenges.admin_id, challenges.attempts, challenges.demo_mode, challenges.otp_hash,
      admins.id, admins.name, admins.email,
      admins.mobile_phone, admins.role
      FROM admin_login_challenges AS challenges
      INNER JOIN admins ON admins.id = challenges.admin_id
      WHERE challenges.challenge_hash = ? AND challenges.expires_at > NOW()
      LIMIT 1
    `, [challengeHash]);
    const challenge = rows[0];
    if (!challenge) return res.status(401).json({ message: 'OTP expired. Sign in again to request a new code.' });
    if (Number(challenge.attempts) >= 5) {
      await connection.execute('DELETE FROM admin_login_challenges WHERE challenge_hash = ?', [challengeHash]);
      return res.status(429).json({ message: 'Too many incorrect OTP attempts. Sign in again to request a new code.' });
    }
    await connection.execute('UPDATE admin_login_challenges SET attempts = attempts + 1 WHERE challenge_hash = ?', [challengeHash]);
    let approved = false;
    if (Number(challenge.demo_mode)) {
      if (!isDemoOtpEnabled()) return res.status(503).json({ message: 'This demo OTP challenge is no longer available. Sign in again.' });
      const submittedHash = createHash('sha256').update(code).digest();
      const expectedHash = /^[a-f0-9]{64}$/i.test(challenge.otp_hash || '')
        ? Buffer.from(challenge.otp_hash, 'hex')
        : Buffer.alloc(0);
      approved = expectedHash.length === submittedHash.length && timingSafeEqual(submittedHash, expectedHash);
    } else {
      if (!isTwilioConfigured()) return res.status(503).json({ message: 'SMS OTP is not configured. Add Twilio Verify settings to backend/.env.' });
      approved = await verifyOtpCode(challenge.mobile_phone, code);
    }
    if (!approved) return res.status(401).json({ message: 'OTP is incorrect or expired. Check the code and try again.' });

    await connection.beginTransaction();
    const [removed] = await connection.execute('DELETE FROM admin_login_challenges WHERE challenge_hash = ?', [challengeHash]);
    if (!removed.affectedRows) {
      await connection.rollback();
      return res.status(401).json({ message: 'OTP was already used. Sign in again to request a new code.' });
    }
    const sessionToken = await createAdminSession(connection, challenge.admin_id);
    await connection.commit();
    setSessionCookie(res, sessionToken);
    res.json({ admin: publicAdmin(challenge) });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('OTP verification error:', error.message);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Could not verify this OTP.' });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const identifier = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const normalizedPhone = normalizeMobilePhone(identifier);
  const isPhone = validMobilePhone(normalizedPhone);
  const isEmail = identifier.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  if (!isPhone && !isEmail) {
    return res.status(400).json({ message: 'Enter your registered email or mobile number.' });
  }
  if (!isOtpAvailable()) {
    return res.status(503).json({ message: 'OTP verification is unavailable. Configure Twilio Verify or enable local demo OTP.' });
  }
  try {
    await ensureAuthTables();
    const normalizedIdentifier = isEmail ? identifier.toLowerCase() : normalizedPhone;
    const [rows] = await db.execute(
      'SELECT id, name, email, mobile_phone, role FROM admins WHERE mobile_phone = ? OR email = ? LIMIT 1',
      [normalizedIdentifier, normalizedIdentifier]
    );
    const admin = rows[0];
    if (!admin) {
      return res.status(404).json({ message: 'No admin account found with this email or mobile number.' });
    }
    const connection = await db.getConnection();
    try {
      const challenge = await createOtpChallenge(connection, admin.id, admin.mobile_phone);
      res.json({ resetRequired: true, ...challenge, phoneMasked: maskPhone(admin.mobile_phone) });
    } catch (error) {
      console.error('Password reset OTP error:', error.message);
      res.status(error.status || 500).json({ message: error.status ? error.message : 'Could not send verification OTP.' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Forgot password error:', error.message);
    res.status(500).json({ message: 'Could not process password reset request.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const challengeToken = typeof req.body?.challengeToken === 'string' ? req.body.challengeToken : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

  if (!challengeToken || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ message: 'Enter the verification code sent to your phone.' });
  }
  if (newPassword.length < 10 || newPassword.length > 200) {
    return res.status(400).json({ message: 'New password must be between 10 and 200 characters.' });
  }

  let connection;
  try {
    await ensureAuthTables();
    connection = await db.getConnection();
    const challengeHash = hashSessionToken(challengeToken);
    const [rows] = await connection.execute(`
      SELECT challenges.admin_id, challenges.attempts, challenges.demo_mode, challenges.otp_hash,
      admins.id, admins.name, admins.email, admins.mobile_phone, admins.role
      FROM admin_login_challenges AS challenges
      INNER JOIN admins ON admins.id = challenges.admin_id
      WHERE challenges.challenge_hash = ? AND challenges.expires_at > NOW()
      LIMIT 1
    `, [challengeHash]);
    const challenge = rows[0];
    if (!challenge) return res.status(401).json({ message: 'OTP expired. Please start the password reset again.' });
    if (Number(challenge.attempts) >= 5) {
      await connection.execute('DELETE FROM admin_login_challenges WHERE challenge_hash = ?', [challengeHash]);
      return res.status(429).json({ message: 'Too many incorrect OTP attempts. Please try again.' });
    }
    await connection.execute('UPDATE admin_login_challenges SET attempts = attempts + 1 WHERE challenge_hash = ?', [challengeHash]);

    let approved = false;
    if (Number(challenge.demo_mode)) {
      if (!isDemoOtpEnabled()) return res.status(503).json({ message: 'This demo OTP challenge is no longer available.' });
      const submittedHash = createHash('sha256').update(code).digest();
      const expectedHash = /^[a-f0-9]{64}$/i.test(challenge.otp_hash || '')
        ? Buffer.from(challenge.otp_hash, 'hex')
        : Buffer.alloc(0);
      approved = expectedHash.length === submittedHash.length && timingSafeEqual(submittedHash, expectedHash);
    } else {
      if (!isTwilioConfigured()) return res.status(503).json({ message: 'SMS OTP is not configured.' });
      approved = await verifyOtpCode(challenge.mobile_phone, code);
    }
    if (!approved) return res.status(401).json({ message: 'OTP is incorrect or expired. Check the code and try again.' });

    const passwordHash = await hashPassword(newPassword);

    await connection.beginTransaction();
    await connection.execute('DELETE FROM admin_login_challenges WHERE challenge_hash = ?', [challengeHash]);
    await connection.execute('DELETE FROM admin_sessions WHERE admin_id = ?', [challenge.admin_id]);
    await connection.execute('UPDATE admins SET password_hash = ? WHERE id = ?', [passwordHash, challenge.admin_id]);
    const sessionToken = await createAdminSession(connection, challenge.admin_id);
    await connection.commit();

    setSessionCookie(res, sessionToken);
    res.json({ success: true, message: 'Password reset successfully.', admin: publicAdmin(challenge) });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Password reset error:', error.message);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Could not reset password.' });
  } finally {
    if (connection) connection.release();
  }
});

app.use('/api', requireAdmin);

app.get('/api/auth/profile', (req, res) => res.json({ admin: publicAdmin(req.admin) }));

app.patch('/api/auth/profile', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!name || name.length > 100 || email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Enter a name and valid email address.' });
  }
  try {
    await db.execute('UPDATE admins SET name = ?, email = ? WHERE id = ?', [name, email, req.admin.id]);
    res.json({ admin: publicAdmin({ ...req.admin, name, email }) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Another admin already uses this email.' });
    console.error('Admin profile update error:', error.message);
    res.status(500).json({ message: 'Could not save this profile.' });
  }
});

app.post('/api/auth/password', async (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (newPassword.length < 10 || newPassword.length > 200) {
    return res.status(400).json({ message: 'New password must be between 10 and 200 characters.' });
  }
  let connection;
  try {
    const [rows] = await db.execute('SELECT password_hash FROM admins WHERE id = ? LIMIT 1', [req.admin.id]);
    if (!rows.length || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }
    const passwordHash = await hashPassword(newPassword);
    connection = await db.getConnection();
    await connection.beginTransaction();
    await connection.execute('UPDATE admins SET password_hash = ? WHERE id = ?', [passwordHash, req.admin.id]);
    await connection.execute('DELETE FROM admin_sessions WHERE admin_id = ?', [req.admin.id]);
    const token = await createAdminSession(connection, req.admin.id);
    await connection.commit();
    setSessionCookie(res, token);
    res.json({ success: true });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Admin password update error:', error.message);
    res.status(500).json({ message: 'Could not update the password.' });
  } finally {
    if (connection) connection.release();
  }
});

app.get('/api/admins', async (req, res) => {
  try {
    const [admins] = await db.query('SELECT id, name, email, role, created_at AS createdAt FROM admins ORDER BY created_at, id');
    res.json(admins);
  } catch (error) {
    console.error('Admin list error:', error.message);
    res.status(500).json({ message: 'Could not load admin accounts.' });
  }
});

app.post('/api/admins', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const phone = normalizeMobilePhone(req.body?.phone);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!validAdminDetails(name, email, phone, password)) {
    return res.status(400).json({ message: 'Enter a name, valid email, E.164 mobile number (+country code), and password with at least 10 characters.' });
  }
  try {
    const passwordHash = await hashPassword(password);
    const [result] = await db.execute('INSERT INTO admins (name, email, mobile_phone, password_hash) VALUES (?, ?, ?, ?)', [name, email, phone, passwordHash]);
    res.status(201).json({ id: result.insertId, name, email, role: 'Administrator' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'An admin already uses this email or mobile number.' });
    console.error('Admin creation error:', error.message);
    res.status(500).json({ message: 'Could not create this admin account.' });
  }
});

const defaultDepartments = [
  ['Cardiology', 'Heart care, diagnostics and treatment.', '♡', 'teal', 8, 124, 1],
  ['Neurology', 'Brain, spine and nervous system care.', '⌁', 'blue', 6, 86, 2],
  ['Orthopedics', 'Bone, joint and muscle treatment.', '✚', 'orange', 7, 102, 3],
  ['Pediatrics', 'Medical care for infants and children.', '♧', 'purple', 5, 74, 4],
  ['Dermatology', 'Skin, hair and nail health services.', '◉', 'teal', 4, 63, 5],
  ['General Medicine', 'Primary and preventive healthcare.', '＋', 'blue', 9, 156, 6]
];

const defaultDoctors = [
  ['Dr. Arjun Mehta', 'Cardiology', 'AM', 'mint', 24, 'Available', '12 years'],
  ['Dr. Priya Nair', 'Neurology', 'PN', 'blue', 18, 'Available', '9 years'],
  ['Dr. Kabir Rao', 'Orthopedics', 'KR', 'peach', 21, 'In consultation', '15 years'],
  ['Dr. Sara Khan', 'General Medicine', 'SK', 'lavender', 16, 'Available', '8 years'],
  ['Dr. Neha Kapoor', 'Dermatology', 'NK', 'rose', 20, 'In consultation', '11 years'],
  ['Dr. Vikram Shah', 'Pediatrics', 'VS', 'blue', 14, 'Available', '7 years']
];

const defaultInvoices = [
  ['INV-2038', 'Aanya Sharma', 'Consultation · Cardiology', 1500, 'Paid'],
  ['INV-2037', 'Rohan Verma', 'Diagnostic · Neurology', 2800, 'Pending'],
  ['INV-2036', 'Meera Iyer', 'Consultation · Orthopedics', 1200, 'Paid'],
  ['INV-2035', 'Dev Patel', 'Consultation · General Medicine', 900, 'Paid'],
  ['INV-2034', 'Ishita Das', 'Treatment · Dermatology', 2100, 'Pending']
];

async function ensureAppointmentsTable() {
  await ensureDatabaseExists();
  if (!appointmentsTableReady) {
    appointmentsTableReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS appointments (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          appointment_code VARCHAR(32) NOT NULL,
          patient_name VARCHAR(150) NOT NULL,
          patient_phone VARCHAR(20) NULL,
          sms_consent TINYINT(1) NOT NULL DEFAULT 0,
          doctor_name VARCHAR(150) NOT NULL,
          department VARCHAR(100) NOT NULL,
          appointment_date DATE NOT NULL,
          appointment_time TIME NOT NULL,
          status ENUM('Pending', 'Confirmed', 'Cancelled') NOT NULL DEFAULT 'Pending',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY unique_appointment_code (appointment_code),
          KEY idx_appointments_date_time (appointment_date, appointment_time)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const [phoneColumns] = await db.query("SHOW COLUMNS FROM appointments LIKE 'patient_phone'");
      if (!phoneColumns.length) await db.query('ALTER TABLE appointments ADD COLUMN patient_phone VARCHAR(20) NULL AFTER patient_name');
      const [consentColumns] = await db.query("SHOW COLUMNS FROM appointments LIKE 'sms_consent'");
      if (!consentColumns.length) await db.query('ALTER TABLE appointments ADD COLUMN sms_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER patient_phone');

      await db.query(`
        CREATE TABLE IF NOT EXISTS appointment_sms_notifications (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          appointment_id BIGINT UNSIGNED NOT NULL,
          notification_type ENUM('confirmation', 'reminder') NOT NULL,
          to_phone VARCHAR(20) NOT NULL,
          message_body VARCHAR(1000) NOT NULL,
          scheduled_at DATETIME NOT NULL,
          status ENUM('pending', 'sending', 'sent', 'failed', 'simulated') NOT NULL DEFAULT 'pending',
          attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
          next_attempt_at DATETIME NULL,
          last_error VARCHAR(255) NULL,
          provider_message_sid VARCHAR(64) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          sent_at DATETIME NULL,
          PRIMARY KEY (id),
          UNIQUE KEY unique_appointment_notification (appointment_id, notification_type),
          KEY idx_due_appointment_sms (status, scheduled_at, next_attempt_at),
          CONSTRAINT fk_appointment_sms_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id)
            ON UPDATE CASCADE ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      const [notificationStatusColumns] = await db.query("SHOW COLUMNS FROM appointment_sms_notifications LIKE 'status'");
      if (notificationStatusColumns.length && !notificationStatusColumns[0].Type.includes("'simulated'")) {
        await db.query(`
          ALTER TABLE appointment_sms_notifications
          MODIFY COLUMN status ENUM('pending', 'sending', 'sent', 'failed', 'simulated')
          NOT NULL DEFAULT 'pending'
        `);
      }
    })().catch((error) => {
      appointmentsTableReady = null;
      throw error;
    });
  }
  await appointmentsTableReady;
}

let smsNotificationSweepRunning = false;

async function deliverAppointmentSms(notificationId) {
  if (!isTwilioMessagingConfigured()) return { status: 'queued' };

  const [claim] = await db.execute(`
    UPDATE appointment_sms_notifications
    SET status = 'sending', attempts = attempts + 1, next_attempt_at = NULL, last_error = NULL
    WHERE id = ? AND status = 'pending' AND scheduled_at <= NOW()
      AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
  `, [notificationId]);
  if (!claim.affectedRows) return { status: 'queued' };

  const [rows] = await db.execute(`
    SELECT to_phone, message_body, attempts
    FROM appointment_sms_notifications
    WHERE id = ? AND status = 'sending'
    LIMIT 1
  `, [notificationId]);
  if (!rows.length) return { status: 'queued' };

  try {
    const result = await sendSmsMessage(rows[0].to_phone, rows[0].message_body);
    await db.execute(`
      UPDATE appointment_sms_notifications
      SET status = 'sent', provider_message_sid = ?, sent_at = NOW(), last_error = NULL
      WHERE id = ?
    `, [result.sid, notificationId]);
    return { status: 'sent', providerStatus: result.providerStatus };
  } catch (error) {
    const attempts = Number(rows[0].attempts);
    const canRetry = attempts < 6;
    const retryDelayMinutes = Math.min(60, 2 ** attempts);
    const nextAttemptAt = canRetry ? new Date(Date.now() + retryDelayMinutes * 60 * 1000) : null;
    await db.execute(`
      UPDATE appointment_sms_notifications
      SET status = ?, next_attempt_at = ?, last_error = ?
      WHERE id = ?
    `, [canRetry ? 'pending' : 'failed', nextAttemptAt, String(error.message || 'SMS provider error').slice(0, 255), notificationId]);
    console.error(`Appointment SMS delivery failed for notification ${notificationId}: ${error.message}`);
    return { status: canRetry ? 'queued' : 'failed' };
  }
}

async function processDueAppointmentSms() {
  if (smsNotificationSweepRunning || !isTwilioMessagingConfigured()) return;
  smsNotificationSweepRunning = true;
  try {
    await ensureAppointmentsTable();
    await db.execute(`
      UPDATE appointment_sms_notifications
      SET status = IF(attempts >= 6, 'failed', 'pending'),
        next_attempt_at = IF(attempts >= 6, NULL, NOW()),
        last_error = 'Recovered after interrupted send.'
      WHERE status = 'sending' AND updated_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)
    `);
    const [rows] = await db.query(`
      SELECT notifications.id
      FROM appointment_sms_notifications AS notifications
      INNER JOIN appointments ON appointments.id = notifications.appointment_id
      WHERE notifications.status = 'pending'
        AND notifications.scheduled_at <= NOW()
        AND (notifications.next_attempt_at IS NULL OR notifications.next_attempt_at <= NOW())
        AND notifications.attempts < 6
        AND appointments.sms_consent = 1
        AND appointments.status <> 'Cancelled'
        AND (notifications.notification_type = 'confirmation'
          OR TIMESTAMP(appointments.appointment_date, appointments.appointment_time) > NOW())
      ORDER BY notifications.scheduled_at, notifications.id
      LIMIT 20
    `);
    for (const row of rows) await deliverAppointmentSms(row.id);
  } catch (error) {
    console.error(`Appointment SMS queue check failed: ${error.message}`);
  } finally {
    smsNotificationSweepRunning = false;
  }
}

function startAppointmentSmsWorker() {
  const timer = setInterval(processDueAppointmentSms, 15000);
  timer.unref();
  processDueAppointmentSms();
}

async function ensureDashboardTables() {
  await ensureDatabaseExists();
  if (!dashboardTablesReady) {
    dashboardTablesReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS departments (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          name VARCHAR(100) NOT NULL,
          description VARCHAR(255) NOT NULL,
          icon VARCHAR(32) NOT NULL DEFAULT '＋',
          color VARCHAR(20) NOT NULL DEFAULT 'blue',
          doctor_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
          patient_count INT UNSIGNED NOT NULL DEFAULT 0,
          sort_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
          PRIMARY KEY (id),
          UNIQUE KEY unique_department_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS doctors (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          name VARCHAR(150) NOT NULL,
          department_id INT UNSIGNED NOT NULL,
          initials VARCHAR(10) NOT NULL,
          color VARCHAR(20) NOT NULL DEFAULT 'mint',
          patient_count INT UNSIGNED NOT NULL DEFAULT 0,
          status ENUM('Available', 'In consultation') NOT NULL DEFAULT 'Available',
          experience VARCHAR(50) NOT NULL DEFAULT '',
          PRIMARY KEY (id),
          UNIQUE KEY unique_doctor_name (name),
          CONSTRAINT fk_doctors_department FOREIGN KEY (department_id) REFERENCES departments(id)
            ON UPDATE CASCADE ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS invoices (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          invoice_number VARCHAR(32) NOT NULL,
          patient_name VARCHAR(150) NOT NULL,
          service VARCHAR(180) NOT NULL,
          amount DECIMAL(12, 2) UNSIGNED NOT NULL,
          status ENUM('Paid', 'Pending', 'Cancelled') NOT NULL DEFAULT 'Pending',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY unique_invoice_number (invoice_number),
          KEY idx_invoices_created_status (created_at, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [[departmentStats]] = await connection.query('SELECT COUNT(*) AS total FROM departments');
        if (Number(departmentStats.total) === 0) {
          for (const department of defaultDepartments) {
            await connection.execute(`
              INSERT INTO departments (name, description, icon, color, doctor_count, patient_count, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `, department);
          }
        }

        const [[doctorStats]] = await connection.query('SELECT COUNT(*) AS total FROM doctors');
        if (Number(doctorStats.total) === 0) {
          const [departmentRows] = await connection.query('SELECT id, name FROM departments');
          const departmentIds = new Map(departmentRows.map((department) => [department.name, department.id]));
          for (const [name, department, initials, color, patients, status, experience] of defaultDoctors) {
            const departmentId = departmentIds.get(department);
            if (!departmentId) continue;
            await connection.execute(`
              INSERT INTO doctors (name, department_id, initials, color, patient_count, status, experience)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [name, departmentId, initials, color, patients, status, experience]);
          }
        }

        const [[invoiceStats]] = await connection.query('SELECT COUNT(*) AS total FROM invoices');
        if (Number(invoiceStats.total) === 0) {
          for (const invoice of defaultInvoices) {
            await connection.execute(`
              INSERT INTO invoices (invoice_number, patient_name, service, amount, status)
              VALUES (?, ?, ?, ?, ?)
            `, invoice);
          }
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    })().catch((error) => {
      dashboardTablesReady = null;
      throw error;
    });
  }
  await dashboardTablesReady;
}

async function ensurePatientsTable() {
  await ensureDatabaseExists();
  if (!patientsTableReady) {
    patientsTableReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS patients (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          name VARCHAR(100) NOT NULL,
          age TINYINT UNSIGNED NULL,
          gender ENUM('male', 'female', 'other') NOT NULL,
          phone VARCHAR(20) NULL,
          condition_details TEXT NULL,
          assigned_doctor_id INT UNSIGNED NULL,
          patient_message TEXT NULL,
          doctor_instructions TEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_patients_assigned_doctor (assigned_doctor_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Existing installations may already have a patients table. Add only the new fields.
      const [columns] = await db.query('SHOW COLUMNS FROM patients');
      const existingColumns = new Set(columns.map((column) => column.Field));
      const migrations = [
        ['condition_details', 'TEXT NULL'],
        ['assigned_doctor_id', 'INT UNSIGNED NULL'],
        ['patient_message', 'TEXT NULL'],
        ['doctor_instructions', 'TEXT NULL'],
        ['created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP']
      ];
      for (const [columnName, definition] of migrations) {
        if (!existingColumns.has(columnName)) {
          await db.query(`ALTER TABLE patients ADD COLUMN ${columnName} ${definition}`);
        }
      }
    })().catch((error) => {
      patientsTableReady = null;
      throw error;
    });
  }
  await patientsTableReady;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// Check backend
app.get('/api/health', (req, res) => {
res.send('Hospital Management System Backend is running!');
});

// Check MySQL connection
app.get('/api/db-check', async (req, res) => {
try {
const [rows] = await db.query('SELECT DATABASE() AS databaseName');
res.json({
success: true,
message: 'MySQL connected successfully',
database: rows[0].databaseName
});
} catch (error) {
console.error('MySQL error:', error.message);
res.status(500).json({
success: false,
message: 'Database connection failed'
});
}
});

// Load departments stored in MySQL
app.get('/api/departments', async (req, res) => {
try {
await ensureDashboardTables();
const [rows] = await db.query(`
  SELECT id, name, description, icon, color, doctor_count AS doctors,
  patient_count AS patients
  FROM departments
  ORDER BY sort_order, name
`);
res.json(rows);
} catch (error) {
console.error('Departments error:', error.message);
res.status(500).json({ message: 'Departments load nahi ho paaye.' });
}
});

// Load doctors stored in MySQL
app.get('/api/doctors', async (req, res) => {
try {
await ensureDashboardTables();
const [rows] = await db.query(`
  SELECT doctors.id, doctors.name, departments.name AS department, doctors.initials,
  doctors.color, doctors.patient_count AS patients, doctors.status, doctors.experience
  FROM doctors
  INNER JOIN departments ON departments.id = doctors.department_id
  ORDER BY doctors.patient_count DESC, doctors.name
`);
res.json(rows);
} catch (error) {
console.error('Doctors error:', error.message);
res.status(500).json({ message: 'Doctors load nahi ho paaye.' });
}
});

// Load invoices stored in MySQL
app.get('/api/invoices', async (req, res) => {
try {
await ensureDashboardTables();
const [rows] = await db.query(`
  SELECT invoice_number AS id, patient_name AS patient, service, amount, status,
  DATE_FORMAT(created_at, '%Y-%m') AS month
  FROM invoices
  ORDER BY created_at DESC, id DESC
`);
res.json(rows);
} catch (error) {
console.error('Invoices error:', error.message);
res.status(500).json({ message: 'Billing records load nahi ho paaye.' });
}
});

app.post('/api/departments', async (req, res) => {
const body = req.body || {};
const name = typeof body.name === 'string' ? body.name.trim() : '';
const description = typeof body.description === 'string' ? body.description.trim() : '';
const icon = typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim() : '＋';
const color = typeof body.color === 'string' ? body.color : 'blue';
const doctorCount = body.doctors === '' || body.doctors === undefined ? 0 : Number(body.doctors);
const patientCount = body.patients === '' || body.patients === undefined ? 0 : Number(body.patients);
const allowedColors = ['teal', 'blue', 'orange', 'purple', 'rose'];

if (!name || name.length > 100 || !description || description.length > 255 || icon.length > 32 ||
  !allowedColors.includes(color) || !Number.isInteger(doctorCount) || doctorCount < 0 ||
  !Number.isInteger(patientCount) || patientCount < 0) {
return res.status(400).json({ message: 'Valid department name, description, color aur counts required hain.' });
}

try {
await ensureDashboardTables();
const [[order]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM departments');
await db.execute(`
  INSERT INTO departments (name, description, icon, color, doctor_count, patient_count, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`, [name, description, icon, color, doctorCount, patientCount, order.nextOrder]);
const [rows] = await db.execute(`
  SELECT id, name, description, icon, color, doctor_count AS doctors, patient_count AS patients
  FROM departments WHERE name = ?
`, [name]);
res.status(201).json(rows[0]);
} catch (error) {
console.error('Department save error:', error.message);
if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Is naam ka department pehle se hai.' });
res.status(500).json({ message: 'Department database mein save nahi ho paaya.' });
}
});

app.patch('/api/departments/:id', async (req, res) => {
const id = Number(req.params.id);
const body = req.body || {};
const name = typeof body.name === 'string' ? body.name.trim() : '';
const description = typeof body.description === 'string' ? body.description.trim() : '';
const icon = typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim() : 'ï¼‹';
const color = typeof body.color === 'string' ? body.color : 'blue';
const doctorCount = body.doctors === '' || body.doctors === undefined ? 0 : Number(body.doctors);
const patientCount = body.patients === '' || body.patients === undefined ? 0 : Number(body.patients);
const allowedColors = ['teal', 'blue', 'orange', 'purple', 'rose'];

if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Valid department ID required hai.' });
if (!name || name.length > 100 || !description || description.length > 255 || icon.length > 32 ||
  !allowedColors.includes(color) || !Number.isInteger(doctorCount) || doctorCount < 0 ||
  !Number.isInteger(patientCount) || patientCount < 0) {
return res.status(400).json({ message: 'Valid department name, description, color aur counts required hain.' });
}

try {
await ensureDashboardTables();
const [existing] = await db.execute('SELECT id FROM departments WHERE id = ? LIMIT 1', [id]);
if (!existing.length) return res.status(404).json({ message: 'Department nahi mila.' });
await db.execute(`
  UPDATE departments SET name = ?, description = ?, icon = ?, color = ?, doctor_count = ?, patient_count = ?
  WHERE id = ?
`, [name, description, icon, color, doctorCount, patientCount, id]);
const [rows] = await db.execute(`
  SELECT id, name, description, icon, color, doctor_count AS doctors, patient_count AS patients
  FROM departments WHERE id = ?
`, [id]);
res.json(rows[0]);
} catch (error) {
console.error('Department update error:', error.message);
if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Is naam ka department pehle se hai.' });
res.status(500).json({ message: 'Department database mein update nahi ho paaya.' });
}
});

app.post('/api/doctors', async (req, res) => {
const body = req.body || {};
const name = typeof body.name === 'string' ? body.name.trim() : '';
const department = typeof body.department === 'string' ? body.department.trim() : '';
const initials = typeof body.initials === 'string' && body.initials.trim()
  ? body.initials.trim().slice(0, 10)
  : name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
const color = typeof body.color === 'string' ? body.color : 'mint';
const patients = body.patients === '' || body.patients === undefined ? 0 : Number(body.patients);
const status = typeof body.status === 'string' ? body.status : 'Available';
const experience = typeof body.experience === 'string' ? body.experience.trim() : '';
const allowedColors = ['mint', 'blue', 'peach', 'lavender', 'rose'];

if (!name || name.length > 150 || !department || department.length > 100 || !initials ||
  !allowedColors.includes(color) || !Number.isInteger(patients) || patients < 0 ||
  !['Available', 'In consultation'].includes(status) || experience.length > 50) {
return res.status(400).json({ message: 'Valid doctor details required hain.' });
}

try {
await ensureDashboardTables();
const [departmentRows] = await db.execute('SELECT id FROM departments WHERE name = ? LIMIT 1', [department]);
if (!departmentRows.length) return res.status(400).json({ message: 'Pehle valid department select karein.' });
await db.execute(`
  INSERT INTO doctors (name, department_id, initials, color, patient_count, status, experience)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`, [name, departmentRows[0].id, initials, color, patients, status, experience]);
await db.execute('UPDATE departments SET doctor_count = doctor_count + 1 WHERE id = ?', [departmentRows[0].id]);
const [rows] = await db.execute(`
  SELECT doctors.id, doctors.name, departments.name AS department, doctors.initials,
  doctors.color, doctors.patient_count AS patients, doctors.status, doctors.experience
  FROM doctors INNER JOIN departments ON departments.id = doctors.department_id
  WHERE doctors.name = ?
`, [name]);
res.status(201).json(rows[0]);
} catch (error) {
console.error('Doctor save error:', error.message);
if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Is naam ke doctor pehle se hain.' });
res.status(500).json({ message: 'Doctor database mein save nahi ho paaya.' });
}
});

app.patch('/api/doctors/:id', async (req, res) => {
const id = Number(req.params.id);
const body = req.body || {};
const name = typeof body.name === 'string' ? body.name.trim() : '';
const department = typeof body.department === 'string' ? body.department.trim() : '';
const initials = typeof body.initials === 'string' && body.initials.trim()
  ? body.initials.trim().slice(0, 10)
  : name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
const color = typeof body.color === 'string' ? body.color : 'mint';
const patients = body.patients === '' || body.patients === undefined ? 0 : Number(body.patients);
const status = typeof body.status === 'string' ? body.status : 'Available';
const experience = typeof body.experience === 'string' ? body.experience.trim() : '';
const allowedColors = ['mint', 'blue', 'peach', 'lavender', 'rose'];

if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Valid doctor ID required hai.' });
if (!name || name.length > 150 || !department || department.length > 100 || !initials ||
  !allowedColors.includes(color) || !Number.isInteger(patients) || patients < 0 ||
  !['Available', 'In consultation'].includes(status) || experience.length > 50) {
return res.status(400).json({ message: 'Valid doctor details required hain.' });
}

let connection;
try {
await ensureDashboardTables();
connection = await db.getConnection();
await connection.beginTransaction();
const [doctorRows] = await connection.execute('SELECT id, department_id FROM doctors WHERE id = ? FOR UPDATE', [id]);
if (!doctorRows.length) {
  await connection.rollback();
  return res.status(404).json({ message: 'Doctor nahi mila.' });
}
const [departmentRows] = await connection.execute('SELECT id FROM departments WHERE name = ? LIMIT 1', [department]);
if (!departmentRows.length) {
  await connection.rollback();
  return res.status(400).json({ message: 'Pehle valid department select karein.' });
}
const previousDepartmentId = Number(doctorRows[0].department_id);
const nextDepartmentId = Number(departmentRows[0].id);
await connection.execute(`
  UPDATE doctors SET name = ?, department_id = ?, initials = ?, color = ?, patient_count = ?, status = ?, experience = ?
  WHERE id = ?
`, [name, nextDepartmentId, initials, color, patients, status, experience, id]);
if (previousDepartmentId !== nextDepartmentId) {
  await connection.execute('UPDATE departments SET doctor_count = GREATEST(doctor_count - 1, 0) WHERE id = ?', [previousDepartmentId]);
  await connection.execute('UPDATE departments SET doctor_count = doctor_count + 1 WHERE id = ?', [nextDepartmentId]);
}
const [updatedRows] = await connection.execute(`
  SELECT doctors.id, doctors.name, departments.name AS department, doctors.initials,
  doctors.color, doctors.patient_count AS patients, doctors.status, doctors.experience
  FROM doctors INNER JOIN departments ON departments.id = doctors.department_id
  WHERE doctors.id = ?
`, [id]);
await connection.commit();
res.json(updatedRows[0]);
} catch (error) {
if (connection) await connection.rollback().catch(() => {});
console.error('Doctor update error:', error.message);
if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Is naam ke doctor pehle se hain.' });
res.status(500).json({ message: 'Doctor database mein update nahi ho paaya.' });
} finally {
if (connection) connection.release();
}
});

app.post('/api/invoices', async (req, res) => {
const body = req.body || {};
const patient = typeof body.patient === 'string' ? body.patient.trim() : '';
const service = typeof body.service === 'string' ? body.service.trim() : '';
const amountInput = body.amount;
const amount = Number(amountInput);
const status = typeof body.status === 'string' ? body.status : 'Pending';

if (!patient || patient.length > 150 || !service || service.length > 180 ||
  !/^\d+(?:\.\d{1,2})?$/.test(String(amountInput)) || !Number.isFinite(amount) ||
  amount < 0 || amount > 9999999999.99 || !['Paid', 'Pending', 'Cancelled'].includes(status)) {
return res.status(400).json({ message: 'Valid patient, service, amount aur status required hain.' });
}

try {
await ensureDashboardTables();
const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
await db.execute(`
  INSERT INTO invoices (invoice_number, patient_name, service, amount, status)
  VALUES (?, ?, ?, ?, ?)
`, [invoiceNumber, patient, service, amount, status]);
const [rows] = await db.execute(`
  SELECT invoice_number AS id, patient_name AS patient, service, amount, status,
  DATE_FORMAT(created_at, '%Y-%m') AS month
  FROM invoices WHERE invoice_number = ?
`, [invoiceNumber]);
res.status(201).json(rows[0]);
} catch (error) {
console.error('Invoice save error:', error.message);
res.status(500).json({ message: 'Invoice database mein save nahi ho paaya.' });
}
});

app.patch('/api/invoices/:invoiceNumber', async (req, res) => {
const invoiceNumber = typeof req.params.invoiceNumber === 'string' ? req.params.invoiceNumber.trim() : '';
const body = req.body || {};
const patient = typeof body.patient === 'string' ? body.patient.trim() : '';
const service = typeof body.service === 'string' ? body.service.trim() : '';
const amountInput = body.amount;
const amount = Number(amountInput);
const status = typeof body.status === 'string' ? body.status : '';

if (!/^INV-[A-Z0-9-]{1,28}$/.test(invoiceNumber)) return res.status(400).json({ message: 'Valid invoice number required hai.' });
if (!patient || patient.length > 150 || !service || service.length > 180 ||
  !/^\d+(?:\.\d{1,2})?$/.test(String(amountInput)) || !Number.isFinite(amount) ||
  amount < 0 || amount > 9999999999.99 || !['Paid', 'Pending', 'Cancelled'].includes(status)) {
return res.status(400).json({ message: 'Valid patient, service, amount aur status required hain.' });
}

try {
await ensureDashboardTables();
const [existing] = await db.execute('SELECT id FROM invoices WHERE invoice_number = ? LIMIT 1', [invoiceNumber]);
if (!existing.length) return res.status(404).json({ message: 'Invoice nahi mila.' });
await db.execute(`
  UPDATE invoices SET patient_name = ?, service = ?, amount = ?, status = ?
  WHERE invoice_number = ?
`, [patient, service, amount, status, invoiceNumber]);
const [rows] = await db.execute(`
  SELECT invoice_number AS id, patient_name AS patient, service, amount, status,
  DATE_FORMAT(created_at, '%Y-%m') AS month
  FROM invoices WHERE invoice_number = ?
`, [invoiceNumber]);
res.json(rows[0]);
} catch (error) {
console.error('Invoice update error:', error.message);
res.status(500).json({ message: 'Invoice database mein update nahi ho paaya.' });
}
});

// Get all patients
app.get('/api/patients', async (req, res) => {
try {
await ensureDashboardTables();
await ensurePatientsTable();
const [rows] = await db.query(`
SELECT patients.id, patients.name, patients.age, patients.gender, patients.phone,
patients.condition_details AS conditionDetails,
patients.assigned_doctor_id AS assignedDoctorId,
doctors.name AS assignedDoctor, departments.name AS assignedDepartment,
patients.patient_message AS patientMessage,
patients.doctor_instructions AS doctorInstructions,
DATE_FORMAT(patients.created_at, '%Y-%m-%d') AS registeredAt
FROM patients
LEFT JOIN doctors ON doctors.id = patients.assigned_doctor_id
LEFT JOIN departments ON departments.id = doctors.department_id
ORDER BY patients.id DESC
`);
res.json(rows);
} catch (error) {
console.error('Patients error:', error.message);
res.status(500).json({
message: 'Patients fetch nahi ho paaye'
});
}
});

// Create a patient record
app.post('/api/patients', async (req, res) => {
const body = req.body || {};
const name = typeof body.name === 'string' ? body.name.trim() : '';
const gender = typeof body.gender === 'string' ? body.gender.toLowerCase() : '';
const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
const age = body.age === '' || body.age === null || body.age === undefined ? null : Number(body.age);
const conditionDetails = typeof body.conditionDetails === 'string' ? body.conditionDetails.trim() : '';
const assignedDoctorId = body.assignedDoctorId === '' || body.assignedDoctorId === null || body.assignedDoctorId === undefined
  ? null
  : Number(body.assignedDoctorId);
const patientMessage = typeof body.patientMessage === 'string' ? body.patientMessage.trim() : '';
const doctorInstructions = typeof body.doctorInstructions === 'string' ? body.doctorInstructions.trim() : '';

if (!name || name.length > 100 || !['male', 'female', 'other'].includes(gender) || assignedDoctorId === null ||
  (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) || phone.length > 20 ||
  (assignedDoctorId !== null && (!Number.isSafeInteger(assignedDoctorId) || assignedDoctorId < 1)) ||
  conditionDetails.length > 5000 || patientMessage.length > 5000 || doctorInstructions.length > 5000) {
return res.status(400).json({ message: 'Patient details, assigned doctor aur notes ki valid values enter karein.' });
}

try {
await ensureDashboardTables();
await ensurePatientsTable();
if (assignedDoctorId !== null) {
  const [doctorRows] = await db.execute('SELECT id FROM doctors WHERE id = ? LIMIT 1', [assignedDoctorId]);
  if (!doctorRows.length) return res.status(400).json({ message: 'Selected doctor nahi mila. Doctor list refresh karke try karein.' });
}
const [result] = await db.execute(
  `INSERT INTO patients (name, age, gender, phone, condition_details, assigned_doctor_id, patient_message, doctor_instructions)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [name, age, gender, phone || null, conditionDetails || null, assignedDoctorId, patientMessage || null, doctorInstructions || null]
);
const [rows] = await db.execute(`
  SELECT patients.id, patients.name, patients.age, patients.gender, patients.phone,
  patients.condition_details AS conditionDetails,
  patients.assigned_doctor_id AS assignedDoctorId,
  doctors.name AS assignedDoctor, departments.name AS assignedDepartment,
  patients.patient_message AS patientMessage,
  patients.doctor_instructions AS doctorInstructions,
  DATE_FORMAT(patients.created_at, '%Y-%m-%d') AS registeredAt
  FROM patients
  LEFT JOIN doctors ON doctors.id = patients.assigned_doctor_id
  LEFT JOIN departments ON departments.id = doctors.department_id
  WHERE patients.id = ?
`, [result.insertId]);
res.status(201).json(rows[0]);
} catch (error) {
console.error('Patient save error:', error.message);
res.status(500).json({ message: 'Patient database mein save nahi ho paaya.' });
}
});

app.patch('/api/patients/:id', async (req, res) => {
const id = Number(req.params.id);
const body = req.body || {};
const name = typeof body.name === 'string' ? body.name.trim() : '';
const gender = typeof body.gender === 'string' ? body.gender.toLowerCase() : '';
const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
const age = body.age === '' || body.age === null || body.age === undefined ? null : Number(body.age);
const conditionDetails = typeof body.conditionDetails === 'string' ? body.conditionDetails.trim() : '';
const assignedDoctorId = body.assignedDoctorId === '' || body.assignedDoctorId === null || body.assignedDoctorId === undefined
  ? null
  : Number(body.assignedDoctorId);
const patientMessage = typeof body.patientMessage === 'string' ? body.patientMessage.trim() : '';
const doctorInstructions = typeof body.doctorInstructions === 'string' ? body.doctorInstructions.trim() : '';

if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'Valid patient ID required hai.' });
if (!name || name.length > 100 || !['male', 'female', 'other'].includes(gender) || assignedDoctorId === null ||
  (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) || phone.length > 20 ||
  (assignedDoctorId !== null && (!Number.isSafeInteger(assignedDoctorId) || assignedDoctorId < 1)) ||
  conditionDetails.length > 5000 || patientMessage.length > 5000 || doctorInstructions.length > 5000) {
return res.status(400).json({ message: 'Patient details, assigned doctor aur notes ki valid values enter karein.' });
}

try {
await ensureDashboardTables();
await ensurePatientsTable();
const [existing] = await db.execute('SELECT id FROM patients WHERE id = ? LIMIT 1', [id]);
if (!existing.length) return res.status(404).json({ message: 'Patient nahi mila.' });
if (assignedDoctorId !== null) {
  const [doctorRows] = await db.execute('SELECT id FROM doctors WHERE id = ? LIMIT 1', [assignedDoctorId]);
  if (!doctorRows.length) return res.status(400).json({ message: 'Selected doctor nahi mila. Doctor list refresh karke try karein.' });
}
await db.execute(`
  UPDATE patients SET name = ?, age = ?, gender = ?, phone = ?, condition_details = ?,
  assigned_doctor_id = ?, patient_message = ?, doctor_instructions = ? WHERE id = ?
`, [name, age, gender, phone || null, conditionDetails || null, assignedDoctorId, patientMessage || null, doctorInstructions || null, id]);
const [rows] = await db.execute(`
  SELECT patients.id, patients.name, patients.age, patients.gender, patients.phone,
  patients.condition_details AS conditionDetails,
  patients.assigned_doctor_id AS assignedDoctorId,
  doctors.name AS assignedDoctor, departments.name AS assignedDepartment,
  patients.patient_message AS patientMessage,
  patients.doctor_instructions AS doctorInstructions,
  DATE_FORMAT(patients.created_at, '%Y-%m-%d') AS registeredAt
  FROM patients
  LEFT JOIN doctors ON doctors.id = patients.assigned_doctor_id
  LEFT JOIN departments ON departments.id = doctors.department_id
  WHERE patients.id = ?
`, [id]);
res.json(rows[0]);
} catch (error) {
console.error('Patient update error:', error.message);
res.status(500).json({ message: 'Patient database mein update nahi ho paaya.' });
}
});

// Get appointments from MySQL
app.get('/api/appointments', async (req, res) => {
try {
await ensureAppointmentsTable();
const [rows] = await db.query(`
SELECT appointment_code AS id, patient_name AS patient, doctor_name AS doctor,
department, DATE_FORMAT(appointment_date, '%Y-%m-%d') AS date,
TIME_FORMAT(appointment_time, '%H:%i') AS time, status
FROM appointments
ORDER BY appointment_date DESC, appointment_time ASC, id DESC
`);
res.json(rows);
} catch (error) {
console.error('Appointments fetch error:', error.message);
res.status(500).json({ message: 'Appointments load nahi ho paaye.' });
}
});

// Save a new appointment in MySQL
app.post('/api/appointments', async (req, res) => {
const body = req.body || {};
const patient = typeof body.patient === 'string' ? body.patient.trim() : '';
const patientPhone = normalizeMobilePhone(body.patientPhone);
const smsConsent = body.smsConsent === true;
const doctor = typeof body.doctor === 'string' ? body.doctor.trim() : '';
const department = typeof body.department === 'string' ? body.department.trim() : '';
const date = body.date;
const time = body.time;

if (!patient || patient.length > 150 || !doctor || doctor.length > 150 || !department || department.length > 100 || !validDate(date) || !validTime(time)) {
return res.status(400).json({ message: 'Patient, department, doctor, valid date aur time required hain.' });
}
if ((patientPhone && !validMobilePhone(patientPhone)) || (smsConsent && !patientPhone)) {
return res.status(400).json({ message: 'SMS ke liye patient ka mobile +country code format mein aur SMS consent zaroori hai.' });
}

try {
await ensureDashboardTables();
const [doctorRows] = await db.execute(`
  SELECT doctors.id
  FROM doctors
  INNER JOIN departments ON departments.id = doctors.department_id
  WHERE doctors.name = ? AND departments.name = ?
  LIMIT 1
`, [doctor, department]);
if (!doctorRows.length) {
  return res.status(400).json({ message: 'Selected doctor department se match nahi karta.' });
}
await ensureAppointmentsTable();
const appointmentCode = `APT-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
const connection = await db.getConnection();
let confirmationNotificationId = null;
let reminderScheduled = false;
const demoSmsMode = isDemoSmsEnabled();
const notificationStatus = demoSmsMode ? 'simulated' : 'pending';
try {
  await connection.beginTransaction();
  const [appointmentResult] = await connection.execute(`
    INSERT INTO appointments (
      appointment_code, patient_name, patient_phone, sms_consent,
      doctor_name, department, appointment_date, appointment_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [appointmentCode, patient, smsConsent ? patientPhone : null, smsConsent ? 1 : 0, doctor, department, date, `${time}:00`]);

  if (smsConsent) {
    const confirmationBody = `CarePoint: Appointment with ${doctor} (${department}) booked for ${date} at ${time}. Reference ${appointmentCode}.`;
    const [confirmationResult] = await connection.execute(`
      INSERT INTO appointment_sms_notifications
        (appointment_id, notification_type, to_phone, message_body, scheduled_at, status)
      VALUES (?, 'confirmation', ?, ?, NOW(), ?)
    `, [appointmentResult.insertId, patientPhone, confirmationBody, notificationStatus]);
    confirmationNotificationId = confirmationResult.insertId;

    const [[reminderWindow]] = await connection.execute(
      'SELECT TIMESTAMP(?, ?) > DATE_ADD(NOW(), INTERVAL 24 HOUR) AS reminderEligible',
      [date, `${time}:00`]
    );
    reminderScheduled = Number(reminderWindow.reminderEligible) === 1;
    if (reminderScheduled) {
      const reminderBody = `CarePoint reminder: Appointment with ${doctor} (${department}) is on ${date} at ${time}. Reference ${appointmentCode}.`;
      await connection.execute(`
        INSERT INTO appointment_sms_notifications
          (appointment_id, notification_type, to_phone, message_body, scheduled_at, status)
        VALUES (?, 'reminder', ?, ?, DATE_SUB(TIMESTAMP(?, ?), INTERVAL 24 HOUR), ?)
      `, [appointmentResult.insertId, patientPhone, reminderBody, date, `${time}:00`, notificationStatus]);
    }
  }
  await connection.commit();
} catch (error) {
  await connection.rollback().catch(() => {});
  throw error;
} finally {
  connection.release();
}

let confirmationSmsStatus = 'not_requested';
if (confirmationNotificationId && demoSmsMode) {
  confirmationSmsStatus = 'simulated';
} else if (confirmationNotificationId) {
  try {
    const delivery = await deliverAppointmentSms(confirmationNotificationId);
    confirmationSmsStatus = delivery.status;
  } catch (error) {
    console.error(`Could not start appointment SMS delivery: ${error.message}`);
    confirmationSmsStatus = 'queued';
  }
}
res.status(201).json({
id: appointmentCode,
patient,
doctor,
department,
date,
time,
status: 'Pending',
smsNotification: { confirmation: confirmationSmsStatus, reminderScheduled, demoMode: demoSmsMode }
});
} catch (error) {
console.error('Appointment save error:', error.message);
res.status(500).json({ message: 'Appointment database mein save nahi ho paayi.' });
}
});

// Update an appointment's booking status
app.patch('/api/appointments/:code', async (req, res) => {
const code = typeof req.params.code === 'string' ? req.params.code.trim() : '';
const status = typeof req.body?.status === 'string' ? req.body.status : '';
if (!code || code.length > 32 || !['Pending', 'Confirmed', 'Cancelled'].includes(status)) {
return res.status(400).json({ message: 'Valid appointment code and status required hain.' });
}

try {
await ensureAppointmentsTable();
await db.execute('UPDATE appointments SET status = ? WHERE appointment_code = ?', [status, code]);
if (status === 'Cancelled') {
  await db.execute(`
    UPDATE appointment_sms_notifications
    SET status = 'failed', next_attempt_at = NULL, last_error = 'Appointment cancelled.'
    WHERE appointment_id = (SELECT id FROM appointments WHERE appointment_code = ? LIMIT 1)
      AND status = 'pending'
  `, [code]);
}
const [rows] = await db.execute(`
  SELECT appointment_code AS id, patient_name AS patient, doctor_name AS doctor,
  department, DATE_FORMAT(appointment_date, '%Y-%m-%d') AS date,
  TIME_FORMAT(appointment_time, '%H:%i') AS time, status
  FROM appointments WHERE appointment_code = ? LIMIT 1
`, [code]);
if (!rows.length) return res.status(404).json({ message: 'Appointment nahi mila.' });
res.json(rows[0]);
} catch (error) {
console.error('Appointment status update error:', error.message);
res.status(500).json({ message: 'Appointment status update nahi ho paaya.' });
}
});
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Start server
function startServer(port) {
  const onListening = () => {
    console.log(`Hospital backend running at http://localhost:${port}`);
    console.log(`Network access (e.g. phone on same Wi-Fi): http://10.106.163.93:${port}`);
    ensureDatabaseExists()
      .then(() => console.log('Connected to MySQL database successfully.'))
      .catch((err) => console.error('Database connection error (Check DB_PASSWORD in backend/.env):', err.message));
    startAppointmentSmsWorker();
  };
  const server = app.listen(port, '0.0.0.0', onListening);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && port !== 3001) {
      console.warn(`Port ${port} is already in use; trying port 3001.`);
      startServer(3001);
      return;
    }
    console.error(`Hospital backend could not start on port ${port}: ${error.message}`);
    process.exitCode = 1;
  });
}

startServer(PORT);
