// Sends email via SMTP if configured (SMTP_HOST/PORT/USER/PASS in .env).
// If not configured, logs the full email content to console and to
// data/email-log.json instead of failing — so registration flow always
// completes end-to-end in development, and switching to real delivery
// later is just a matter of setting the env vars, no code changes needed.

const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "data", "email-log.json");

// Escapes the five HTML-significant characters so user-supplied strings
// (name, company, message, etc.) can never inject markup, script tags,
// phishing links, or tracking pixels into emails built from HTML templates.
// Always pass user input through this before interpolating into an HTML
// email body or subject line.
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strips CR/LF from values interpolated into email Subject lines. HTML
// escaping doesn't help here — the risk on a header line is injecting
// extra headers (e.g. a fake Bcc) via newline characters, not markup.
function sanitizeHeaderValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

function logToFile(entry) {
  let log = [];
  if (fs.existsSync(LOG_PATH)) {
    try {
      log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8") || "[]");
    } catch (e) {
      log = [];
    }
  }
  log.push({ ...entry, loggedAt: new Date().toISOString() });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

async function sendMail({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM || "Baseline Skills <no-reply@baselineskills.example>";

  if (!isConfigured()) {
    console.log(`\n[mailer] SMTP not configured — logging email instead of sending.`);
    console.log(`[mailer] To: ${to}\n[mailer] Subject: ${subject}`);
    logToFile({ to, from, subject, html, text, delivered: false, reason: "SMTP not configured" });
    return { delivered: false, reason: "SMTP not configured" };
  }

  try {
    await getTransporter().sendMail({ from, to, subject, html, text });
    logToFile({ to, from, subject, delivered: true });
    return { delivered: true };
  } catch (err) {
    console.error("[mailer] send failed:", err.message);
    logToFile({ to, from, subject, delivered: false, reason: err.message });
    return { delivered: false, reason: err.message };
  }
}

module.exports = { sendMail, isConfigured, escapeHtml, sanitizeHeaderValue };
