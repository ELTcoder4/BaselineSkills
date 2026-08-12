const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const store = require("../lib/store");
const { newId } = require("../lib/id");
const slugify = require("slugify");
const { createLoginAttemptTracker, requireSameOrigin } = require("../lib/security");

const loginAttempts = createLoginAttemptTracker({ windowMs: 15 * 60 * 1000, maxAttempts: 5 });

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/admin/login");
}

// ---- Auth ----
router.get("/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.render("admin/login", { title: "Admin login — Baseline Skills" });
});

router.post("/login", (req, res) => {
  const attemptStatus = loginAttempts.check(req);
  if (attemptStatus.blocked) {
    res.set("Retry-After", attemptStatus.retryAfterSeconds);
    return res.status(429).render("admin/login", {
      title: "Admin login — Baseline Skills",
      error: "Too many failed attempts. Please try again in a few minutes.",
    });
  }

  const { password } = req.body;
  const usingFallbackPassword = !process.env.ADMIN_PASSWORD;
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme123";

  if (usingFallbackPassword) {
    console.warn(
      "[admin] WARNING: ADMIN_PASSWORD is not set — falling back to the default " +
      "'changeme123' password. Set ADMIN_PASSWORD in your environment before " +
      "deploying anywhere reachable outside your own machine."
    );
  }

  // Constant-time comparison so a mismatched password can't be distinguished
  // from a matched one by how long the comparison took (timing side-channel).
  // Buffers must be equal length for timingSafeEqual, so hash both first —
  // that also sidesteps timingSafeEqual throwing on unequal-length inputs.
  const suppliedHash = crypto.createHash("sha256").update(String(password || "")).digest();
  const expectedHash = crypto.createHash("sha256").update(String(adminPassword)).digest();
  const passwordMatches = crypto.timingSafeEqual(suppliedHash, expectedHash);

  if (passwordMatches) {
    loginAttempts.recordSuccess(req);
    // Regenerate the session ID on every successful login. Without this, an
    // attacker who fixes a victim's session ID before login (session
    // fixation) could reuse that same ID to inherit the now-authenticated
    // session. Regenerating issues a fresh ID that the attacker never saw.
    return req.session.regenerate((err) => {
      if (err) {
        console.error("[admin] session regenerate failed:", err.message);
        return res.status(500).render("admin/login", {
          title: "Admin login — Baseline Skills",
          error: "Something went wrong. Please try again.",
        });
      }
      req.session.isAdmin = true;
      res.redirect("/admin");
    });
  }

  loginAttempts.recordFailure(req);
  res.render("admin/login", { title: "Admin login — Baseline Skills", error: "Incorrect password." });
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

router.use(requireAdmin); // everything below this line requires admin auth

// State-changing admin actions get an Origin/Referer same-site check, on
// top of the SameSite=Lax session cookie, as defense against CSRF.
router.post(["/courses/new", "/courses/:id/edit", "/courses/:id/delete", "/courses/:id/toggle-published"], requireSameOrigin);

// ---- Dashboard ----
router.get("/", (req, res) => {
  const courses = store.readAll("courses");
  const registrations = store.readAll("registrations").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const inquiries = store.readAll("inquiries").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const revenueCents = registrations
    .filter((r) => r.status === "confirmed" || r.status === "invoice_pending")
    .reduce((sum, r) => sum + (r.priceCentsCharged || 0), 0);

  res.render("admin/dashboard", {
    title: "Admin dashboard — Baseline Skills",
    courseCount: courses.length,
    publishedCount: courses.filter((c) => c.published).length,
    registrationCount: registrations.length,
    revenueDisplay: (revenueCents / 100).toFixed(2),
    recentRegistrations: registrations.slice(0, 8),
    recentInquiries: inquiries.slice(0, 5),
  });
});

// ---- Course list ----
router.get("/courses", (req, res) => {
  const courses = store.readAll("courses");
  res.render("admin/courses-list", { title: "Manage courses — Baseline Skills", courses });
});

function courseFromForm(body, existing) {
  const outcomes = (body.outcomes || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const audience = (body.audience || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const deliveryModes = Array.isArray(body.deliveryModes) ? body.deliveryModes : (body.deliveryModes ? [body.deliveryModes] : []);

  const sessionStarts = Array.isArray(body.sessionStartDate) ? body.sessionStartDate : [body.sessionStartDate].filter(Boolean);
  const sessionModes = Array.isArray(body.sessionMode) ? body.sessionMode : [body.sessionMode].filter(Boolean);
  const sessionSeats = Array.isArray(body.sessionSeats) ? body.sessionSeats : [body.sessionSeats].filter(Boolean);
  const sessions = sessionStarts
    .map((startDate, i) => ({
      startDate,
      mode: sessionModes[i] || deliveryModes[0] || "Live Online",
      seatsLeft: sessionSeats[i] ? Number(sessionSeats[i]) : null,
    }))
    .filter((s) => s.startDate);

  return {
    ...existing,
    title: body.title,
    slug: existing && existing.slug ? existing.slug : slugify(body.title, { lower: true, strict: true }),
    category: body.category,
    summary: body.summary,
    description: body.description,
    outcomes,
    curriculum: existing ? existing.curriculum : [],
    audience,
    durationDays: Number(body.durationDays) || 1,
    deliveryModes: deliveryModes.length ? deliveryModes : ["Live Online"],
    priceCents: Math.round(Number(body.price || 0) * 100),
    discountPercent: Number(body.discountPercent || 0),
    currency: body.currency || "USD",
    certification: !!body.certification,
    sessions,
    corporateOnly: !!body.corporateOnly,
    published: !!body.published,
  };
}

// ---- New course ----
router.get("/courses/new", (req, res) => {
  res.render("admin/course-form", { title: "New course — Baseline Skills", course: null, mode: "new" });
});

router.post("/courses/new", (req, res) => {
  const course = courseFromForm(req.body, { id: newId("course") });
  store.insert("courses", course);
  res.redirect("/admin/courses");
});

// ---- Edit course ----
router.get("/courses/:id/edit", (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (!course) return res.status(404).send("Course not found");
  res.render("admin/course-form", { title: `Edit ${course.title} — Baseline Skills`, course, mode: "edit" });
});

router.post("/courses/:id/edit", (req, res) => {
  const existing = store.findOne("courses", (c) => c.id === req.params.id);
  if (!existing) return res.status(404).send("Course not found");
  const updated = courseFromForm(req.body, existing);
  store.update("courses", req.params.id, updated);
  res.redirect("/admin/courses");
});

router.post("/courses/:id/delete", (req, res) => {
  store.remove("courses", req.params.id);
  res.redirect("/admin/courses");
});

router.post("/courses/:id/toggle-published", (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (course) store.update("courses", req.params.id, { published: !course.published });
  res.redirect("/admin/courses");
});

// ---- Registrations ----
router.get("/registrations", (req, res) => {
  const registrations = store.readAll("registrations").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/registrations", { title: "Registrations — Baseline Skills", registrations });
});

// ---- Inquiries (contact + corporate) ----
router.get("/inquiries", (req, res) => {
  const inquiries = store.readAll("inquiries").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/inquiries", { title: "Inquiries — Baseline Skills", inquiries });
});

module.exports = router;
