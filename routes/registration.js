const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const store = require("../lib/store");
const { sendMail, escapeHtml } = require("../lib/mailer");
const { newId } = require("../lib/id");
const payments = require("../lib/payments");
const createRateLimiter = require("../lib/rate-limiter");

const regRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyPrefix: "course_reg",
  message: "Too many registration requests. Please wait a few minutes before trying again.",
});

// ---- Registration form ----
router.get("/courses/:slug/register", (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: "Course not found" });
  res.render("register", { title: `Register — ${course.title}`, course, finalPrice: payments.finalPriceCents(course) });
});

// ---- Submit registration ----
router.post("/courses/:slug/register", regRateLimiter, async (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: "Course not found" });

  const { name, email, company, role, sessionStartDate, deliveryMode, notes } = req.body;
  if (!name || !email) {
    return res.status(400).render("register", {
      title: `Register — ${course.title}`, course, finalPrice: payments.finalPriceCents(course),
      error: "Name and email are required.", form: req.body,
    });
  }

  const registration = {
    id: newId("reg"),
    courseId: course.id,
    courseTitle: course.title,
    name, email, company: company || "", role: role || "",
    sessionStartDate: sessionStartDate || (course.sessions[0] && course.sessions[0].startDate) || "",
    deliveryMode: deliveryMode || (course.sessions[0] && course.sessions[0].mode) || "",
    notes: notes || "",
    priceCentsCharged: payments.finalPriceCents(course),
    currency: course.currency,
    status: "pending_payment",
    createdAt: new Date().toISOString(),
  };
  await store.insert("registrations", registration);

  if (!payments.isConfigured()) {
    // No live Paddle credentials configured — fall back to an "invoice
    // pending" path so the rest of the pipeline (file storage + emails)
    // still runs fully end to end.
    await finalizeRegistration(registration.id, { viaFallback: true });
    return res.redirect(`/register/success?reg=${registration.id}`);
  }

  try {
    const txn = await payments.createTransaction({ course, registration });
    await store.update("registrations", registration.id, { paddleTransactionId: txn.transactionId });
    return res.redirect(`/register/checkout?reg=${registration.id}`);
  } catch (err) {
    console.error("[registration] Paddle transaction creation failed:", err.message);
    // Don't leave the visitor stuck — fall back to invoice-pending rather
    // than showing a dead end if Paddle's API itself is unreachable/erroring.
    await finalizeRegistration(registration.id, { viaFallback: true });
    return res.redirect(`/register/success?reg=${registration.id}`);
  }
});

// ---- Checkout page: loads Paddle.js and opens the overlay for this registration's transaction ----
router.get("/register/checkout", (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  if (!reg || !reg.paddleTransactionId) return res.status(404).render("404", { title: "Registration not found" });
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  const clientConfig = payments.getClientConfig();
  res.render("checkout", { title: "Complete payment — Baseline Skills", registration: reg, course, clientConfig });
});

// ---- Shared finalize step: used by both the Paddle webhook and the no-Paddle fallback ----
async function finalizeRegistration(registrationId, opts = {}) {
  const reg = store.findOne("registrations", (r) => r.id === registrationId);
  if (!reg) return null;
  if (reg.status === "confirmed") return reg; // already finalized — don't double-send emails

  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  const updated = await store.update("registrations", registrationId, {
    status: opts.viaFallback ? "invoice_pending" : "confirmed",
    confirmedAt: new Date().toISOString(),
  });

  const priceDisplay = ((updated.priceCentsCharged || 0) / 100).toFixed(2);
  const paymentNote = opts.viaFallback
    ? `<p><em>Payment processing isn't fully configured on this instance yet — this registration has been recorded as invoice-pending. Set PADDLE_API_KEY and PADDLE_CLIENT_TOKEN to enable live card payments via Paddle.</em></p>`
    : "";

  const courseTitle = escapeHtml(course ? course.title : reg.courseTitle);

  await sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New registration — ${courseTitle.replace(/[\r\n]/g, "")} (${escapeHtml(reg.name).replace(/[\r\n]/g, "")})`,
    html: `<h2>New course registration</h2>
      <p><strong>${escapeHtml(reg.name)}</strong> (${escapeHtml(reg.email)}) registered for <strong>${courseTitle}</strong>.</p>
      <ul>
        <li>Company: ${escapeHtml(reg.company) || "n/a"}</li>
        <li>Role: ${escapeHtml(reg.role) || "n/a"}</li>
        <li>Session: ${escapeHtml(reg.sessionStartDate)} (${escapeHtml(reg.deliveryMode)})</li>
        <li>Amount: ${escapeHtml(reg.currency)} ${priceDisplay}</li>
        <li>Status: ${escapeHtml(updated.status)}</li>
      </ul>
      ${paymentNote}`,
  });

  await sendMail({
    to: reg.email,
    subject: `You're registered — ${courseTitle.replace(/[\r\n]/g, "")}`,
    html: `<h2>Thanks for registering, ${escapeHtml(reg.name)}!</h2>
      <p>You're booked on <strong>${courseTitle}</strong>.</p>
      <ul>
        <li>Session: ${escapeHtml(reg.sessionStartDate)}</li>
        <li>Delivery mode: ${escapeHtml(reg.deliveryMode)}</li>
        <li>Amount: ${escapeHtml(reg.currency)} ${priceDisplay}</li>
      </ul>
      ${paymentNote}
      <p>We'll be in touch with joining instructions closer to the session date.</p>
      <p>— The Baseline Skills team</p>`,
  });

  return updated;
}


// ---- Landing page after the Paddle overlay closes (belt-and-suspenders alongside the webhook) ----
router.get("/register/success", async (req, res) => {
  const regId = req.query.reg;
  const reg = store.findOne("registrations", (r) => r.id === regId);
  if (!reg) return res.status(404).render("404", { title: "Registration not found" });

  // The webhook is the authoritative confirmation path (see below) — this
  // redirect-based check exists only as a fallback in case the webhook is
  // delayed, since Paddle's overlay closing doesn't itself guarantee the
  // webhook has already been delivered and processed.
  const finalReg = store.findOne("registrations", (r) => r.id === regId);
  const course = store.findOne("courses", (c) => c.id === finalReg.courseId);
  res.render("register-success", { title: "Registration confirmed — Baseline Skills", registration: finalReg, course });
});

router.get("/register/cancel", (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  res.render("register-cancel", { title: "Registration not completed — Baseline Skills", registration: reg });
});

// ---- Paddle webhook — the authoritative payment-confirmation path ----
// Signature verification follows Paddle's documented HMAC-SHA256(ts:rawBody)
// scheme, same as ReqDrive's own webhook handlers.
function verifyPaddleSignature(rawBody, secret, signatureHeader) {
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const parts = Object.fromEntries(
    signatureHeader.split(";").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    })
  );
  const ts = Number(parts.ts);
  const h1 = parts.h1;
  if (!Number.isFinite(ts) || !h1) return { ok: false, reason: "malformed_signature" };

  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > 5 * 60) return { ok: false, reason: "timestamp_outside_tolerance" };

  const computed = crypto.createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(h1, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

router.post("/webhooks/paddle", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  // Fail closed, not open — an unconfigured secret must never be treated as
  // "skip verification." See the ReqCompass/ReqM webhook history for why
  // this specific mistake matters: it's a real, exploitable gap otherwise.
  if (!secret) {
    console.error("[paddle webhook] PADDLE_WEBHOOK_SECRET not configured — refusing to process");
    return res.status(500).send("Paddle webhook not configured");
  }

  const rawBody = req.body.toString("utf8");
  const verification = verifyPaddleSignature(rawBody, secret, req.headers["paddle-signature"]);
  if (!verification.ok) {
    console.error("[paddle webhook] signature verification failed:", verification.reason);
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send("Invalid payload");
  }

  if (event.event_type === "transaction.completed" || event.event_type === "transaction.paid") {
    const registrationId = event.data && event.data.custom_data && event.data.custom_data.registrationId;
    if (registrationId) {
      await finalizeRegistration(registrationId, { viaFallback: false });
    } else {
      console.warn("[paddle webhook] transaction.completed with no registrationId in custom_data");
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;
module.exports.finalizeRegistration = finalizeRegistration;
