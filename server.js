'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_UPLOAD_FILES = 5;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_MULTIPART_BYTES = 80 * 1024 * 1024;
const OPERATOR_RATES = {
  Betway: { workerEarnings: 40, managerEarnings: 15 },
  ToonieBet: { workerEarnings: 40, managerEarnings: 20 },
  OLG: { workerEarnings: 50, managerEarnings: 25 }
};
const REPORT_RECIPIENT = process.env.REPORT_RECIPIENT || 'pickrpicks@gmail.com';
const REPORT_SCHEDULE_TOKEN = process.env.REPORT_SCHEDULE_TOKEN || '';

function availableOperatorRates(db, user) {
  return { ...(db.operatorRates || {}), ...(user?.operatorRates || {}) };
}

function now() { return new Date().toISOString(); }
function id(prefix = '') { return prefix + crypto.randomBytes(10).toString('hex'); }
function normalize(v) { return String(v || '').trim(); }
function normalizeRef(v) { return normalize(v).toLowerCase().replace(/\s+/g, ''); }
function safeFileName(v) { return path.basename(String(v || 'file').replace(/[\\/]/g, '_')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'file'; }

function reportPeriod(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function isLastDayOfMonth(date = new Date()) {
  const tomorrow = new Date(date);
  tomorrow.setDate(date.getDate() + 1);
  return tomorrow.getMonth() !== date.getMonth();
}

function isInReportMonth(value, date) {
  if (!value) return false;
  const item = new Date(value);
  return item.getFullYear() === date.getFullYear() && item.getMonth() === date.getMonth();
}

function buildMonthlyReportPdf(db, date = new Date()) {
  const commissions = (db.commissions || []).filter(c => c.status === 'paid' && isInReportMonth(c.paidAt, date));
  const reimbursements = (db.submissions || []).filter(s => s.reimbursement?.status === 'paid' && isInReportMonth(s.reimbursement.paidAt, date));
  const commissionTotal = commissions.reduce((total, item) => total + Number(item.amount || 0), 0);
  const reimbursementTotal = reimbursements.reduce((total, item) => total + Number(item.reimbursement.amount || 0), 0);
  const period = reportPeriod(date);
  const userName = id => db.users.find(user => user.id === id)?.name || 'Unknown';
  const pdf = new PDFDocument({ margin: 48 });
  const chunks = [];
  pdf.on('data', chunk => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  pdf.fontSize(22).text('Pickr Monthly Payout Report');
  pdf.moveDown(0.3).fontSize(11).fillColor('#555').text(`Reporting month: ${date.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}`);
  pdf.moveDown().fillColor('#111').fontSize(14).text('Monthly totals');
  pdf.fontSize(11).text(`Commission payouts: $${commissionTotal.toFixed(2)}`);
  pdf.text(`Deposit reimbursements: $${reimbursementTotal.toFixed(2)}`);
  pdf.font('Helvetica-Bold').text(`Total paid: $${(commissionTotal + reimbursementTotal).toFixed(2)}`);
  pdf.font('Helvetica').moveDown().fontSize(14).text('Commission payouts');
  if (commissions.length) {
    commissions.forEach(item => pdf.fontSize(10).text(`${new Date(item.paidAt).toLocaleDateString('en-CA')}  |  ${userName(item.userId)}  |  ${item.operator}  |  $${Number(item.amount || 0).toFixed(2)}`));
  } else {
    pdf.fontSize(10).text('No commission payouts recorded this month.');
  }
  pdf.moveDown().fontSize(14).text('Deposit reimbursements');
  if (reimbursements.length) {
    reimbursements.forEach(item => pdf.fontSize(10).text(`${new Date(item.reimbursement.paidAt).toLocaleDateString('en-CA')}  |  ${userName(item.affiliateId)}  |  ${item.operator}  |  $${Number(item.reimbursement.amount || 0).toFixed(2)}`));
  } else {
    pdf.fontSize(10).text('No deposit reimbursements recorded this month.');
  }
  pdf.moveDown(2).fontSize(9).fillColor('#777').text(`Generated ${now()} · Pickr Affiliate Portal`);
  pdf.end();
  return completed.then(buffer => ({ buffer, period, commissionTotal, reimbursementTotal, total: commissionTotal + reimbursementTotal, commissionCount: commissions.length, reimbursementCount: reimbursements.length }));
}

async function sendMonthlyReport(db, date = new Date()) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    const error = new Error('Monthly email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD first.');
    error.statusCode = 503;
    throw error;
  }
  const report = await buildMonthlyReportPdf(db, date);
  db.reports = db.reports || [];
  if (db.reports.some(item => item.period === report.period && item.status === 'sent')) return { ...report, alreadySent: true };
  const fileName = `monthly-reports/pickr-payout-report-${report.period}.pdf`;
  await store.putUpload(fileName, report.buffer, 'application/pdf');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: REPORT_RECIPIENT,
    subject: `Pickr payout report — ${report.period}`,
    text: `Attached is the Pickr monthly payout report for ${report.period}. Total paid: $${report.total.toFixed(2)}.`,
    attachments: [{ filename: `pickr-payout-report-${report.period}.pdf`, content: report.buffer, contentType: 'application/pdf' }]
  });
  db.reports.push({ id: id('rpt_'), period: report.period, status: 'sent', sentAt: now(), sentTo: REPORT_RECIPIENT, storagePath: fileName, total: report.total, commissionCount: report.commissionCount, reimbursementCount: report.reimbursementCount });
  return report;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, original] = String(stored || '').split(':');
  if (!salt || !original) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const originalBuffer = Buffer.from(original, 'hex');
  return originalBuffer.length === candidate.length && crypto.timingSafeEqual(originalBuffer, candidate);
}

async function ensureDb() {
  await store.ensureLocalDirs();
  if (await store.dbExists()) return;
  const created = now();
  const db = {
    users: [
      {
        id: 'usr_prav',
        name: 'Prav',
        email: 'prav@pickr.com',
        passwordHash: 'c864e6c93e44b29ca748281118b780d5:e6fd1a3c550cd1d9a244d19f69ed7947b7b5d9b2954aa444680cd5898a4bfb225e518fd0e2621c7c4324f4c184ae2b2477f17df14f26b46fe37deee508a07ab2',
        role: 'admin',
        active: true,
        createdAt: created
      },
      {
        id: 'usr_prian',
        name: 'Prian',
        email: 'prian@pickr.com',
        passwordHash: '3dd14ae9778b24256cf235aace272ede:030cb2e707cba8d4a2782d727475646ce4313f82b54bdba0397303c6c345d1b1a2f2c18b85b9fcecb1ee9cf5ca694e5a04fb9d85568682724e6e1d10585285c3',
        role: 'account_manager',
        active: true,
        managedBy: null,
        createdAt: created
      },
      {
        id: 'usr_harish',
        name: 'Harish',
        email: 'harish@pickr.com',
        passwordHash: '7c24bce3435ca6cd442af471b0c2e71c:4ef1cacdf01f92740be85302d63f6a31209897cb689c679141392b7b439581f836a59ff30cda32f323426db16377af453285f59d80c3f35d30be947e628c6ab2',
        role: 'commission_worker',
        active: true,
        managedBy: 'usr_prian',
        createdAt: created
      }
    ],
    submissions: [],
    commissions: [],
    operatorRates: OPERATOR_RATES,
    audit: [
      { id: id('aud_'), type: 'system.seed', actorId: 'system', at: created, meta: { message: 'Pickr database created' } }
    ]
  };
  await store.saveDb(db);
}

function loadDb() {
  return store.loadDb();
}

function saveDb(db) {
  return store.saveDb(db);
}

const DEMO_EMAILS = ['admin@demo.local', 'affiliate@demo.local'];

/**
 * Provisions a real admin account from the ADMIN_EMAIL / ADMIN_PASSWORD
 * environment variables and disables the built-in demo logins.
 *
 * - Creates the admin if it does not exist (using the provided password).
 * - If it already exists, ensures it is an active admin but does NOT overwrite
 *   the password, so any later in-app password change is preserved.
 * - Deactivates the demo accounts so they can no longer sign in.
 */
async function applyAdminConfig() {
  const email = normalize(process.env.ADMIN_EMAIL).toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email) return;

  const db = await loadDb();
  let changed = false;

  const existing = db.users.find(u => u.email.toLowerCase() === email);
  if (existing) {
    if (existing.role !== 'admin' || !existing.active) {
      existing.role = 'admin';
      existing.active = true;
      changed = true;
    }
  } else {
    if (password.length < 8) {
      console.warn('ADMIN_PASSWORD must be at least 8 characters to create the admin account. Skipping admin creation.');
    } else {
      db.users.push({
        id: id('usr_'),
        name: normalize(process.env.ADMIN_NAME) || 'Administrator',
        email,
        passwordHash: hashPassword(password),
        role: 'admin',
        active: true,
        createdAt: now()
      });
      changed = true;
      console.log(`Created admin account for ${email}.`);
    }
  }

  // Disable the demo logins once a real admin email is configured.
  for (const demo of DEMO_EMAILS) {
    if (demo === email) continue;
    const u = db.users.find(x => x.email.toLowerCase() === demo);
    if (u && u.active) {
      u.active = false;
      changed = true;
    }
  }

  if (changed) {
    audit(db, 'system', 'admin.provisioned', { email });
    await saveDb(db);
    console.log('Demo logins disabled; admin configuration applied.');
  }
}

async function applyOperatorRates() {
  const db = await loadDb();
  if (JSON.stringify(db.operatorRates) === JSON.stringify(OPERATOR_RATES)) return;
  db.operatorRates = OPERATOR_RATES;
  audit(db, 'system', 'operator_rates.updated', { operators: Object.keys(OPERATOR_RATES).join(', ') });
  await saveDb(db);
}

function audit(db, actorId, type, meta = {}) {
  db.audit.unshift({ id: id('aud_'), actorId, type, at: now(), meta });
  db.audit = db.audit.slice(0, 3000);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function getSession(req, db) {
  const authorization = String(req.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  const sid = bearer ? bearer[1] : parseCookies(req).sid;
  if (!sid) return null;
  const session = (db.sessions || []).find(item => item.sid === sid);
  if (!session || Date.now() > session.expiresAt) return null;
  return session;
}

function getUser(req, db) {
  const session = getSession(req, db);
  if (!session) return null;
  const user = db.users.find(u => u.id === session.userId && u.active);
  if (!user) return null;
  return user;
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, createdAt: user.createdAt };
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      data += chunk;
      if (Buffer.byteLength(data) > 1_000_000) {
        tooLarge = true;
        const err = new Error('Request too large');
        err.statusCode = 413;
        reject(err);
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch {
        const err = new Error('Invalid JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readBuffer(req, maxBytes = MAX_MULTIPART_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        const err = new Error('Upload is too large. Use up to 5 files, maximum 15 MB each.');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function parseMultipartBuffer(buffer, contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    const err = new Error('Invalid upload form.');
    err.statusCode = 400;
    throw err;
  }
  const boundary = match[1] || match[2];
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const headerBreak = Buffer.from('\r\n\r\n');
  const fields = {};
  const files = [];

  let pos = buffer.indexOf(delimiter);
  if (pos < 0) {
    const err = new Error('Invalid upload body.');
    err.statusCode = 400;
    throw err;
  }
  pos += delimiter.length;

  while (pos < buffer.length) {
    if (buffer.slice(pos, pos + 2).toString() === '--') break;
    if (buffer.slice(pos, pos + 2).toString() === '\r\n') pos += 2;

    const headersEnd = buffer.indexOf(headerBreak, pos);
    if (headersEnd < 0) break;
    const headerText = buffer.slice(pos, headersEnd).toString('utf8');
    const bodyStart = headersEnd + headerBreak.length;
    const bodyEnd = buffer.indexOf(nextDelimiter, bodyStart);
    if (bodyEnd < 0) break;

    const disposition = headerText.split(/\r\n/).find(line => /^content-disposition:/i.test(line)) || '';
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const typeLine = headerText.split(/\r\n/).find(line => /^content-type:/i.test(line));
    const mimeType = typeLine ? typeLine.split(':').slice(1).join(':').trim().toLowerCase() : 'application/octet-stream';
    const content = buffer.slice(bodyStart, bodyEnd);

    if (nameMatch) {
      const fieldName = nameMatch[1];
      if (filenameMatch && filenameMatch[1]) {
        files.push({ fieldName, originalName: safeFileName(filenameMatch[1]), mimeType, content });
      } else {
        fields[fieldName] = content.toString('utf8');
      }
    }

    pos = bodyEnd + 2 + delimiter.length;
  }

  return { fields, files };
}

function validateUpload(file) {
  const ext = path.extname(file.originalName).toLowerCase();
  const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.avif', '.pdf']);
  const imageMime = file.mimeType.startsWith('image/');
  const pdf = file.mimeType === 'application/pdf' || ext === '.pdf';
  const genericBinary = file.mimeType === 'application/octet-stream' && allowedExts.has(ext);
  if (!allowedExts.has(ext) || (!imageMime && !pdf && !genericBinary)) {
    const err = new Error(`Unsupported file type: ${file.originalName}. Use JPG, PNG, WebP, GIF, HEIC/HEIF, AVIF, or PDF.`);
    err.statusCode = 400;
    throw err;
  }
  if (file.content.length > MAX_FILE_BYTES) {
    const err = new Error(`${file.originalName} is larger than 15 MB.`);
    err.statusCode = 413;
    throw err;
  }
}

function requireUser(req, res, db, roles = null) {
  const user = getUser(req, db);
  if (!user) {
    sendJson(res, 401, { error: 'Please sign in.' });
    return null;
  }
  if (roles) {
    const allowedRoles = Array.isArray(roles) ? roles : [roles];
    if (!allowedRoles.includes(user.role)) {
      sendJson(res, 403, { error: 'You do not have permission to do that.' });
      return null;
    }
  }
  return user;
}

function submissionView(s, db) {
  const affiliate = db.users.find(u => u.id === s.affiliateId);
  const reviewer = db.users.find(u => u.id === s.reviewedBy);
  return {
    ...s,
    customerName: s.customerName || '',
    pickrUsername: s.pickrUsername || s.externalUserId || '',
    attachments: (s.attachments || []).map(a => ({
      id: a.id,
      originalName: a.originalName,
      mimeType: a.mimeType,
      size: a.size
    })),
    affiliateName: affiliate?.name || 'Unknown affiliate',
    reviewerName: reviewer?.name || null
  };
}

async function api(req, res, url) {
  // CORS headers for cross-origin requests with credentials
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, {});
  }

  const db = await loadDb();

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req);
    const input = normalize(body.email).toLowerCase();
    // Allow login by email or username/name
    let user = db.users.find(u => u.email.toLowerCase() === input);
    if (!user) {
      user = db.users.find(u => u.name.toLowerCase() === input);
    }
    if (!user || !user.active || !verifyPassword(String(body.password || ''), user.passwordHash)) {
      return sendJson(res, 401, { error: 'Incorrect username or password.' });
    }
    const sid = crypto.randomBytes(32).toString('hex');
    db.sessions = (db.sessions || []).filter(session => session.expiresAt > Date.now());
    db.sessions.push({ sid, userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    audit(db, user.id, 'auth.login');
    await saveDb(db);
    return sendJson(res, 200, { user: safeUser(user), sessionToken: sid }, {
      'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const session = getSession(req, db);
    if (session) {
      db.sessions = db.sessions.filter(item => item.sid !== session.sid);
      await saveDb(db);
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = getUser(req, db);
    return user ? sendJson(res, 200, { user: safeUser(user) }) : sendJson(res, 401, { error: 'Not signed in.' });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const user = requireUser(req, res, db);
    if (!user) return;
    let scoped;
    if (user.role === 'admin') {
      scoped = db.submissions;
    } else if (user.role === 'account_manager') {
      const teamWorkers = db.users.filter(u => u.managedBy === user.id).map(u => u.id);
      scoped = db.submissions.filter(s => s.affiliateId === user.id || teamWorkers.includes(s.affiliateId));
    } else {
      scoped = db.submissions.filter(s => s.affiliateId === user.id);
    }
    const counts = {
      total: scoped.length,
      pending: scoped.filter(s => s.status === 'pending').length,
      approved: scoped.filter(s => s.status === 'approved').length,
      rejected: scoped.filter(s => s.status === 'rejected').length,
      needsReview: scoped.filter(s => s.status === 'needs_review').length
    };
    const recent = [...scoped].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8).map(s => submissionView(s, db));
    let byAffiliate = [];
    if (user.role === 'admin') {
      byAffiliate = db.users.filter(u => u.role === 'affiliate' || u.role === 'commission_worker').map(a => {
        const rows = db.submissions.filter(s => s.affiliateId === a.id);
        return {
          id: a.id, name: a.name, email: a.email, active: a.active,
          total: rows.length,
          approved: rows.filter(s => s.status === 'approved').length,
          pending: rows.filter(s => s.status === 'pending').length,
          rejected: rows.filter(s => s.status === 'rejected').length
        };
      }).sort((a,b) => b.approved - a.approved);
    } else if (user.role === 'account_manager') {
      const teamWorkers = db.users.filter(u => u.managedBy === user.id);
      byAffiliate = teamWorkers.map(a => {
        const rows = db.submissions.filter(s => s.affiliateId === a.id);
        return {
          id: a.id, name: a.name, email: a.email, active: a.active,
          total: rows.length,
          approved: rows.filter(s => s.status === 'approved').length,
          pending: rows.filter(s => s.status === 'pending').length,
          rejected: rows.filter(s => s.status === 'rejected').length
        };
      }).sort((a,b) => b.approved - a.approved);
    }
    return sendJson(res, 200, { counts, recent, byAffiliate });
  }

  if (req.method === 'GET' && url.pathname === '/api/submissions') {
    const user = requireUser(req, res, db);
    if (!user) return;
    let rows;
    if (user.role === 'admin') {
      rows = db.submissions;
    } else if (user.role === 'account_manager') {
      // Manager sees their own submissions and their team's submissions
      const teamWorkers = db.users.filter(u => u.managedBy === user.id).map(u => u.id);
      rows = db.submissions.filter(s => s.affiliateId === user.id || teamWorkers.includes(s.affiliateId));
    } else {
      // Workers and affiliates see their own submissions
      rows = db.submissions.filter(s => s.affiliateId === user.id);
    }
    const status = normalize(url.searchParams.get('status'));
    const q = normalize(url.searchParams.get('q')).toLowerCase();
    if (status && status !== 'all') rows = rows.filter(s => s.status === status);
    if (q) rows = rows.filter(s => [s.customerName, s.pickrUsername, s.externalUserId, s.operator, s.notes].join(' ').toLowerCase().includes(q));
    rows = [...rows].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(s => submissionView(s, db));
    return sendJson(res, 200, { submissions: rows });
  }

  if (req.method === 'GET' && url.pathname === '/api/operators') {
    const user = requireUser(req, res, db, ['affiliate', 'commission_worker', 'account_manager']);
    if (!user) return;
    const operators = Object.entries(availableOperatorRates(db, user)).map(([name, rates]) => ({
      name,
      workerEarnings: Number(rates.workerEarnings || 0)
    }));
    return sendJson(res, 200, { operators });
  }

  if (req.method === 'POST' && url.pathname === '/api/submissions') {
    const user = requireUser(req, res, db, ['affiliate', 'commission_worker', 'account_manager']);
    if (!user) return;

    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return sendJson(res, 400, { error: 'This submission must use the secure upload form.' });
    }

    const buffer = await readBuffer(req);
    const { fields, files } = parseMultipartBuffer(buffer, contentType);
    const customerName = normalize(fields.customerName).slice(0, 120);
    const pickrUsername = normalize(fields.pickrUsername).slice(0, 120);
    const operator = normalize(fields.operator).slice(0, 120);
    const signupDate = normalize(fields.signupDate).slice(0, 20);
    const notes = normalize(fields.notes).slice(0, 1200);

    if (!customerName || !pickrUsername || !operator || !signupDate) {
      return sendJson(res, 400, { error: 'User name, Pickr username, operator, and signup date are required.' });
    }
    const availableRates = availableOperatorRates(db, user);
    if (!Object.prototype.hasOwnProperty.call(availableRates, operator)) {
      return sendJson(res, 400, { error: 'Choose one of the available operators.' });
    }
    if (files.length > MAX_UPLOAD_FILES) {
      return sendJson(res, 400, { error: `You can upload a maximum of ${MAX_UPLOAD_FILES} files.` });
    }
    files.forEach(validateUpload);

    const key = `${normalizeRef(operator)}::${normalizeRef(pickrUsername)}`;
    const duplicate = db.submissions.find(s => {
      const existingKey = s.dedupeKey || `${normalizeRef(s.operator)}::${normalizeRef(s.pickrUsername || s.externalUserId)}`;
      return existingKey === key && s.status !== 'rejected';
    });
    if (duplicate) {
      return sendJson(res, 409, { error: 'That Pickr username has already been submitted for this operator.' });
    }

    const attachments = await Promise.all(files.map(async file => {
      const ext = path.extname(file.originalName).toLowerCase() || '.bin';
      const attachmentId = id('file_');
      const storedName = `${attachmentId}${ext}`;
      await store.putUpload(storedName, file.content, file.mimeType);
      return {
        id: attachmentId,
        originalName: file.originalName,
        storedName,
        mimeType: file.mimeType,
        size: file.content.length,
        uploadedAt: now()
      };
    }));

    const createdAt = now();
    const record = {
      id: id('sub_'),
      affiliateId: user.id,
      customerName,
      pickrUsername,
      operator,
      amount: parseFloat(fields.amount) || 0,
      reimbursement: { status: 'unpaid', amount: parseFloat(fields.amount) || 0, paidAt: null, paidBy: null },
      signupDate,
      notes,
      attachments,
      dedupeKey: key,
      status: 'pending',
      adminNote: '',
      createdAt,
      updatedAt: createdAt,
      reviewedAt: null,
      reviewedBy: null,
      history: [
        { status: 'pending', at: createdAt, by: user.id, note: 'Submitted by affiliate' }
      ]
    };
    db.submissions.unshift(record);
    audit(db, user.id, 'submission.created', { submissionId: record.id, operator, pickrUsername, files: attachments.length });
    await saveDb(db);
    return sendJson(res, 201, { submission: submissionView(record, db) });
  }

  const fileMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/files\/([^/]+)$/);
  if (req.method === 'GET' && fileMatch) {
    const user = requireUser(req, res, db);
    if (!user) return;
    const record = db.submissions.find(s => s.id === fileMatch[1]);
    if (!record) return sendJson(res, 404, { error: 'Submission not found.' });
    if (user.role !== 'admin' && record.affiliateId !== user.id) return sendJson(res, 403, { error: 'You do not have access to that file.' });
    const attachment = (record.attachments || []).find(a => a.id === fileMatch[2]);
    if (!attachment) return sendJson(res, 404, { error: 'File not found.' });
    if (!(await store.uploadExists(attachment.storedName))) return sendJson(res, 404, { error: 'File is missing.' });
    const encodedName = encodeURIComponent(attachment.originalName).replace(/'/g, '%27');
    res.writeHead(200, {
      'Content-Type': attachment.mimeType || 'application/octet-stream',
      'Content-Length': attachment.size,
      'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return store.getUploadStream(attachment.storedName).on('error', () => { if (!res.headersSent) sendJson(res, 404, { error: 'File is missing.' }); else res.end(); }).pipe(res);
  }

  const statusMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    const user = requireUser(req, res, db, 'admin');
    if (!user) return;
    const record = db.submissions.find(s => s.id === statusMatch[1]);
    if (!record) return sendJson(res, 404, { error: 'Submission not found.' });
    const body = await readBody(req);
    const status = normalize(body.status);
    const allowed = new Set(['pending', 'approved', 'rejected', 'needs_review']);
    if (!allowed.has(status)) return sendJson(res, 400, { error: 'Invalid status.' });
    const oldStatus = record.status;
    record.status = status;
    record.adminNote = normalize(body.adminNote).slice(0, 1000);
    record.updatedAt = now();
    record.reviewedAt = record.updatedAt;
    record.reviewedBy = user.id;
    record.history = record.history || [];
    record.history.unshift({ status, at: record.updatedAt, by: user.id, note: record.adminNote || 'Status updated' });
    
    // Create commissions when submission is approved
    if (status === 'approved' && oldStatus !== 'approved') {
      db.commissions = db.commissions || [];
      const operator = record.operator;
      const submittingUser = db.users.find(u => u.id === record.affiliateId);
      const rates = availableOperatorRates(db, submittingUser)[operator];
      
      if (rates) {
        const workerEarnings = rates.workerEarnings || 0;
        const managerEarnings = rates.managerEarnings || 0;

        // Direct commission: workers receive their configured amount, and managers
        // receive that same amount when they submit their own verified users.
        if (workerEarnings > 0) {
          db.commissions.push({
            id: id('com_'),
            submissionId: record.id,
            userId: record.affiliateId,
            userRole: submittingUser?.role || 'commission_worker',
            operator: operator,
            amount: workerEarnings,
            status: 'pending',
            createdAt: record.updatedAt,
            paidAt: null,
            notes: `Commission for approved submission from ${operator}`
          });
        }
        
        // Manager commission (flat amount per worker signup)
        const worker = submittingUser;
        if (managerEarnings > 0 && worker && worker.managedBy) {
          db.commissions.push({
            id: id('com_'),
            submissionId: record.id,
            userId: worker.managedBy,
            userRole: 'account_manager',
            operator: operator,
            amount: managerEarnings,
            status: 'pending',
            createdAt: record.updatedAt,
            paidAt: null,
            notes: `Manager commission for ${worker.name}'s ${operator} submission`
          });
        }
      }
    }
    
    audit(db, user.id, 'submission.status_changed', { submissionId: record.id, status });
    await saveDb(db);
    return sendJson(res, 200, { submission: submissionView(record, db) });
  }

  const reimbursementMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/reimbursement$/);
  if (req.method === 'PATCH' && reimbursementMatch) {
    const user = requireUser(req, res, db, 'admin');
    if (!user) return;
    const record = db.submissions.find(s => s.id === reimbursementMatch[1]);
    if (!record) return sendJson(res, 404, { error: 'Submission not found.' });
    const amount = Number(record.amount || 0);
    if (record.status !== 'approved') return sendJson(res, 400, { error: 'Approve this submission before reimbursing its deposit.' });
    if (amount <= 0) return sendJson(res, 400, { error: 'This submission does not have a reimbursable deposit amount.' });
    if (record.reimbursement?.status === 'paid') return sendJson(res, 409, { error: 'This deposit has already been reimbursed.' });
    record.reimbursement = { status: 'paid', amount, paidAt: now(), paidBy: user.id };
    record.updatedAt = record.reimbursement.paidAt;
    audit(db, user.id, 'submission.deposit_reimbursed', { submissionId: record.id, amount });
    await saveDb(db);
    return sendJson(res, 200, { submission: submissionView(record, db) });
  }

  if (req.method === 'GET' && url.pathname === '/api/affiliates') {
    const user = requireUser(req, res, db, 'admin');
    if (!user) return;
    const affiliates = db.users.filter(u => u.role === 'affiliate').map(a => {
      const rows = db.submissions.filter(s => s.affiliateId === a.id);
      return {
        ...safeUser(a),
        total: rows.length,
        approved: rows.filter(s => s.status === 'approved').length,
        pending: rows.filter(s => s.status === 'pending').length
      };
    }).sort((a,b) => a.name.localeCompare(b.name));
    return sendJson(res, 200, { affiliates });
  }

  if (req.method === 'POST' && url.pathname === '/api/affiliates') {
    const user = requireUser(req, res, db, 'admin');
    if (!user) return;
    const body = await readBody(req);
    const name = normalize(body.name);
    const email = normalize(body.email).toLowerCase();
    const password = String(body.password || '');
    if (!name || !email || password.length < 8) return sendJson(res, 400, { error: 'Name, email, and a password of at least 8 characters are required.' });
    if (db.users.some(u => u.email.toLowerCase() === email)) return sendJson(res, 409, { error: 'An account already exists with that email.' });
    const affiliate = {
      id: id('usr_'), name, email, passwordHash: hashPassword(password), role: 'affiliate', active: true, createdAt: now()
    };
    db.users.push(affiliate);
    audit(db, user.id, 'affiliate.created', { affiliateId: affiliate.id, email });
    await saveDb(db);
    return sendJson(res, 201, { affiliate: safeUser(affiliate) });
  }

  const toggleMatch = url.pathname.match(/^\/api\/affiliates\/([^/]+)\/toggle$/);
  if (req.method === 'PATCH' && toggleMatch) {
    const user = requireUser(req, res, db, 'admin');
    if (!user) return;
    const affiliate = db.users.find(u => u.id === toggleMatch[1] && u.role === 'affiliate');
    if (!affiliate) return sendJson(res, 404, { error: 'Affiliate not found.' });
    affiliate.active = !affiliate.active;
    audit(db, user.id, 'affiliate.toggled', { affiliateId: affiliate.id, active: affiliate.active });
    await saveDb(db);
    return sendJson(res, 200, { affiliate: safeUser(affiliate) });
  }

  // Commission endpoints
  if (req.method === 'GET' && url.pathname === '/api/commissions') {
    const user = getUser(req, db);
    if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
    
    db.commissions = db.commissions || [];
    let commissions = [];
    
    if (user.role === 'admin') {
      // Admin sees all commissions
      commissions = db.commissions.map(c => ({
        ...c,
        userName: db.users.find(u => u.id === c.userId)?.name || 'Unknown',
        submissionDetails: db.submissions.find(s => s.id === c.submissionId) || {}
      }));
    } else if (user.role === 'account_manager') {
      // Account manager sees their workers' commissions and their own
      const managedWorkers = db.users.filter(u => u.managedBy === user.id).map(u => u.id);
      commissions = db.commissions.filter(c => c.userId === user.id || managedWorkers.includes(c.userId)).map(c => ({
        ...c,
        userName: db.users.find(u => u.id === c.userId)?.name || 'Unknown',
        submissionDetails: db.submissions.find(s => s.id === c.submissionId) || {}
      }));
    } else if (user.role === 'commission_worker') {
      // Commission worker sees only their own commissions
      commissions = db.commissions.filter(c => c.userId === user.id).map(c => ({
        ...c,
        userName: user.name,
        submissionDetails: db.submissions.find(s => s.id === c.submissionId) || {}
      }));
    }
    
    return sendJson(res, 200, { commissions });
  }

  if (req.method === 'GET' && url.pathname === '/api/commissions/summary') {
    const user = getUser(req, db);
    if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
    
    db.commissions = db.commissions || [];
    let relevantCommissions = [];
    
    if (user.role === 'admin') {
      relevantCommissions = db.commissions;
    } else if (user.role === 'account_manager') {
      const managedWorkers = db.users.filter(u => u.managedBy === user.id).map(u => u.id);
      relevantCommissions = db.commissions.filter(c => c.userId === user.id || managedWorkers.includes(c.userId));
    } else if (user.role === 'commission_worker') {
      relevantCommissions = db.commissions.filter(c => c.userId === user.id);
    }
    
    const summary = {
      totalEarned: 0,
      totalPending: 0,
      totalPaid: 0,
      byOperator: {},
      recentCommissions: []
    };
    
    relevantCommissions.forEach(c => {
      summary.totalEarned += c.amount || 0;
      if (c.status === 'pending') summary.totalPending += c.amount || 0;
      if (c.status === 'paid') summary.totalPaid += c.amount || 0;
      
      if (!summary.byOperator[c.operator]) {
        summary.byOperator[c.operator] = { total: 0, pending: 0, paid: 0, count: 0 };
      }
      summary.byOperator[c.operator].total += c.amount || 0;
      summary.byOperator[c.operator].count += 1;
      if (c.status === 'pending') summary.byOperator[c.operator].pending += c.amount || 0;
      if (c.status === 'paid') summary.byOperator[c.operator].paid += c.amount || 0;
    });
    
    summary.recentCommissions = relevantCommissions.slice(0, 10).map(c => ({
      id: c.id,
      operator: c.operator,
      amount: c.amount,
      status: c.status,
      createdAt: c.createdAt,
      paidAt: c.paidAt
    }));
    
    return sendJson(res, 200, { summary });
  }

  if (req.method === 'POST' && url.pathname === '/api/commissions/pay-pending') {
    const user = requireUser(req, res, db, 'admin');
    if (!user) return;
    const payable = (db.commissions || []).filter(c => c.status === 'pending');
    if (!payable.length) return sendJson(res, 400, { error: 'There are no pending commissions to pay.' });
    const paidAt = now();
    const batchId = id('pay_');
    let total = 0;
    payable.forEach(commission => {
      commission.status = 'paid';
      commission.paidAt = paidAt;
      commission.paidBy = user.id;
      commission.payoutBatchId = batchId;
      total += Number(commission.amount || 0);
    });
    audit(db, user.id, 'commission.monthly_payout', { batchId, records: payable.length, total });
    await saveDb(db);
    return sendJson(res, 200, { batchId, records: payable.length, total, paidAt });
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    const user = requireUser(req, res, db, 'admin');
    if (!user) return;
    const rows = db.audit.slice(0, 100).map(a => ({
      ...a,
      actorName: db.users.find(u => u.id === a.actorId)?.name || a.actorId
    }));
    return sendJson(res, 200, { audit: rows });
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) return sendText(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const index = path.join(PUBLIC, 'index.html');
    return sendText(res, 200, fs.readFileSync(index), 'text/html; charset=utf-8');
  }
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function monthlyReportJob(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  const token = url.searchParams.get('token') || '';
  if (!REPORT_SCHEDULE_TOKEN || token !== REPORT_SCHEDULE_TOKEN) return sendJson(res, 401, { error: 'Unauthorized.' });
  if (!isLastDayOfMonth()) return sendJson(res, 200, { skipped: true, reason: 'Not the last day of the month.' });
  const db = await loadDb();
  const report = await sendMonthlyReport(db);
  if (!report.alreadySent) {
    audit(db, 'system', 'report.monthly_emailed', { period: report.period, total: report.total, recipient: REPORT_RECIPIENT });
    await saveDb(db);
  }
  return sendJson(res, 200, { period: report.period, total: report.total, alreadySent: Boolean(report.alreadySent) });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/internal/monthly-report') return await monthlyReportJob(req, res, url);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.statusCode || 500, { error: err.statusCode ? err.message : 'Server error.' });
    else res.end();
  }
});

ensureDb()
  .then(applyAdminConfig)
  .then(applyOperatorRates)
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Affiliate Portal running at http://${HOST}:${PORT}`);
      console.log(store.USE_CLOUD ? `Storage: Cloud bucket "${store.BUCKET_NAME}"` : 'Storage: local disk (./data, ./uploads)');
      if (!store.USE_CLOUD) {
        console.log('Demo admin: admin@demo.local / Admin123!');
        console.log('Demo affiliate: affiliate@demo.local / Affiliate123!');
      }
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
