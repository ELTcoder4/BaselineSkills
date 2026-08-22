const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const store = require("../lib/store");
const { newId } = require("../lib/id");
const slugify = require("slugify");
const createRateLimiter = require("../lib/rate-limiter");
const multer = require("multer");
const { BROCHURE_DIR } = require("../lib/brochures");

const brochureUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BROCHURE_DIR),
    // Random, unguessable filename — the "gate" on this PDF is that it's
    // only ever handed out via the emailed link (see routes/public.js),
    // not real access control. Fine for a lead-magnet brochure; don't
    // reuse this pattern for anything actually sensitive.
    filename: (req, file, cb) => cb(null, `${newId("brochure")}.pdf`),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Brochure must be a PDF file"));
    }
    cb(null, true);
  },
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});


const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: "admin_login",
  message: "Too many admin login attempts. Please wait 15 minutes.",
});

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/admin/login");
}

function verifyOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.headers["origin"] || req.headers["referer"];
  if (!origin) return res.status(403).send("Missing origin header");
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers.host;
    if (originHost !== reqHost) {
      return res.status(403).send("Cross-site request forgery blocked");
    }
  } catch (e) {
    return res.status(403).send("Invalid origin header");
  }
  next();
}

// ---- Auth ----
router.get("/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.render("admin/login", { title: "Admin login — Baseline Skills" });
});

router.post("/login", loginRateLimiter, (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme123";

  if (safeCompare(password, adminPassword)) {
    return req.session.regenerate((err) => {
      if (err) {
        return res.status(500).render("admin/login", { title: "Admin login — Baseline Skills", error: "Session creation error." });
      }
      req.session.isAdmin = true;
      return res.redirect("/admin");
    });
  }
  res.render("admin/login", { title: "Admin login — Baseline Skills", error: "Incorrect password." });
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

router.use(requireAdmin); // everything below this line requires admin auth
router.use(verifyOrigin); // enforce CSRF origin protection for admin POST requests


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

function courseFromForm(body, existing, uploadedFile) {
  const outcomes = (body.outcomes || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const audience = (body.audience || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const prerequisites = (body.prerequisites || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const whatYoullReceive = (body.whatYoullReceive || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const deliveryModes = Array.isArray(body.deliveryModes) ? body.deliveryModes : (body.deliveryModes ? [body.deliveryModes] : []);

  // "Module name: topic 1, topic 2" per line -> [{module, topics: [...]}].
  // Blank input keeps whatever curriculum already existed, rather than
  // wiping it out — most edits to a course aren't touching the curriculum.
  const curriculumRaw = (body.curriculumRaw || "").trim();
  const curriculum = curriculumRaw
    ? curriculumRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [modulePart, topicsPart] = line.split(":");
          return {
            module: (modulePart || "").trim(),
            topics: (topicsPart || "").split(",").map((t) => t.trim()).filter(Boolean),
          };
        })
        .filter((m) => m.module)
    : (existing ? existing.curriculum || [] : []);


  const sessionStarts = Array.isArray(body.sessionStartDate) ? body.sessionStartDate : [body.sessionStartDate].filter(Boolean);
  const sessionEnds = Array.isArray(body.sessionEndDate) ? body.sessionEndDate : [body.sessionEndDate].filter(Boolean);
  const sessionTimeFroms = Array.isArray(body.sessionTimeFrom) ? body.sessionTimeFrom : [body.sessionTimeFrom].filter(Boolean);
  const sessionTimeTos = Array.isArray(body.sessionTimeTo) ? body.sessionTimeTo : [body.sessionTimeTo].filter(Boolean);
  const sessionModes = Array.isArray(body.sessionMode) ? body.sessionMode : [body.sessionMode].filter(Boolean);
  const sessionSeats = Array.isArray(body.sessionSeats) ? body.sessionSeats : [body.sessionSeats].filter(Boolean);
  const sessions = sessionStarts
    .map((startDate, i) => ({
      startDate,
      endDate: sessionEnds[i] || "",
      timeFrom: sessionTimeFroms[i] || "",
      timeTo: sessionTimeTos[i] || "",
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
    curriculum: curriculum,
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
    // --- New fields ---
    courseOutlineUrl: body.courseOutlineUrl || "",
    trainerId: body.trainerId || "",
    whyTakeThisCourse: body.whyTakeThisCourse || "",
    prerequisites,
    formatAndMaterial: body.formatAndMaterial || "",
    whatYoullReceive,
    // Keep the existing brochure unless a new file was actually uploaded
    // this submission — an admin editing other fields shouldn't have to
    // re-upload the PDF every time.
    brochureFilename: uploadedFile ? uploadedFile.filename : (existing ? existing.brochureFilename : ""),
  };
}

// Wraps multer's upload so a bad file (wrong type, too large) re-renders
// the course form with a clear message instead of an unhandled error.
function handleBrochureUpload(req, res, next) {
  brochureUpload.single("brochure")(req, res, (err) => {
    if (!err) return next();
    const isEdit = req.params.id != null;
    const course = isEdit ? store.findOne("courses", (c) => c.id === req.params.id) : null;
    res.status(400).render("admin/course-form", {
      title: isEdit ? `Edit ${course ? course.title : ""} — Baseline Skills` : "New course — Baseline Skills",
      course,
      mode: isEdit ? "edit" : "new",
      trainers: store.readAll("trainers"),
      error: err.message === "Brochure must be a PDF file" ? err.message : "Brochure upload failed — please try a PDF under 15MB.",
    });
  });
}
router.get("/courses/new", (req, res) => {
  res.render("admin/course-form", { title: "New course — Baseline Skills", course: null, mode: "new", trainers: store.readAll("trainers") });
});

router.post("/courses/new", handleBrochureUpload, (req, res) => {
  const course = courseFromForm(req.body, { id: newId("course") }, req.file);
  store.insert("courses", course);
  res.redirect("/admin/courses");
});

// ---- Edit course ----
router.get("/courses/:id/edit", (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (!course) return res.status(404).send("Course not found");
  res.render("admin/course-form", { title: `Edit ${course.title} — Baseline Skills`, course, mode: "edit", trainers: store.readAll("trainers") });
});

router.post("/courses/:id/edit", handleBrochureUpload, (req, res) => {
  const existing = store.findOne("courses", (c) => c.id === req.params.id);
  if (!existing) return res.status(404).send("Course not found");
  const updated = courseFromForm(req.body, existing, req.file);
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

// ==================== Trainers ====================
router.get("/trainers", (req, res) => {
  const trainers = store.readAll("trainers");
  res.render("admin/trainers-list", { title: "Manage trainers — Baseline Skills", trainers });
});

router.get("/trainers/new", (req, res) => {
  res.render("admin/trainer-form", { title: "New trainer — Baseline Skills", trainer: null, mode: "new" });
});

router.post("/trainers/new", (req, res) => {
  const { name, title, bio, profileUrl } = req.body;
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: "New trainer — Baseline Skills", trainer: req.body, mode: "new",
      error: "Name and profile link are required.",
    });
  }
  store.insert("trainers", {
    id: newId("trainer"), name, title: title || "", bio: bio || "", profileUrl,
    createdAt: new Date().toISOString(),
  });
  res.redirect("/admin/trainers");
});

router.get("/trainers/:id/edit", (req, res) => {
  const trainer = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!trainer) return res.status(404).send("Trainer not found");
  res.render("admin/trainer-form", { title: `Edit ${trainer.name} — Baseline Skills`, trainer, mode: "edit" });
});

router.post("/trainers/:id/edit", (req, res) => {
  const existing = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!existing) return res.status(404).send("Trainer not found");
  const { name, title, bio, profileUrl } = req.body;
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: `Edit ${existing.name} — Baseline Skills`, trainer: { ...existing, ...req.body }, mode: "edit",
      error: "Name and profile link are required.",
    });
  }
  store.update("trainers", req.params.id, { name, title: title || "", bio: bio || "", profileUrl });
  res.redirect("/admin/trainers");
});

router.post("/trainers/:id/delete", (req, res) => {
  // A trainer referenced by a course isn't deleted out from under it — the
  // course would just show an unresolvable trainerId. Warn instead of
  // silently orphaning the reference.
  const referencingCourses = store.readAll("courses").filter((c) => c.trainerId === req.params.id);
  if (referencingCourses.length) {
    const trainers = store.readAll("trainers");
    return res.status(400).render("admin/trainers-list", {
      title: "Manage trainers — Baseline Skills",
      trainers,
      error: `Can't delete — this trainer is assigned to ${referencingCourses.length} course(s): ${referencingCourses.map((c) => c.title).join(", ")}. Reassign those courses first.`,
    });
  }
  store.remove("trainers", req.params.id);
  res.redirect("/admin/trainers");
});

// ==================== Blogs ====================
router.get("/blogs", (req, res) => {
  const blogs = store.readAll("blogs").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/blogs-list", { title: "Manage blog posts — Baseline Skills", blogs });
});

function blogFromForm(body, existing) {
  return {
    ...existing,
    title: body.title,
    slug: existing && existing.slug ? existing.slug : slugify(body.title, { lower: true, strict: true }),
    excerpt: body.excerpt,
    body: body.body,
    author: body.author || "Baseline Skills Team",
    category: body.category || "Requirements Engineering",
    published: !!body.published,
    updatedAt: new Date().toISOString(),
  };
}

router.get("/blogs/new", (req, res) => {
  res.render("admin/blog-form", { title: "New blog post — Baseline Skills", blog: null, mode: "new" });
});

router.post("/blogs/new", (req, res) => {
  if (!req.body.title || !req.body.body) {
    return res.status(400).render("admin/blog-form", { title: "New blog post — Baseline Skills", blog: req.body, mode: "new", error: "Title and body are required." });
  }
  const blog = blogFromForm(req.body, { id: newId("blog"), createdAt: new Date().toISOString() });
  store.insert("blogs", blog);
  res.redirect("/admin/blogs");
});

router.get("/blogs/:id/edit", (req, res) => {
  const blog = store.findOne("blogs", (b) => b.id === req.params.id);
  if (!blog) return res.status(404).send("Blog post not found");
  res.render("admin/blog-form", { title: `Edit ${blog.title} — Baseline Skills`, blog, mode: "edit" });
});

router.post("/blogs/:id/edit", (req, res) => {
  const existing = store.findOne("blogs", (b) => b.id === req.params.id);
  if (!existing) return res.status(404).send("Blog post not found");
  if (!req.body.title || !req.body.body) {
    return res.status(400).render("admin/blog-form", { title: `Edit ${existing.title} — Baseline Skills`, blog: { ...existing, ...req.body }, mode: "edit", error: "Title and body are required." });
  }
  const updated = blogFromForm(req.body, existing);
  store.update("blogs", req.params.id, updated);
  res.redirect("/admin/blogs");
});

router.post("/blogs/:id/delete", (req, res) => {
  store.remove("blogs", req.params.id);
  res.redirect("/admin/blogs");
});

router.post("/blogs/:id/toggle-published", (req, res) => {
  const blog = store.findOne("blogs", (b) => b.id === req.params.id);
  if (blog) store.update("blogs", req.params.id, { published: !blog.published });
  res.redirect("/admin/blogs");
});

// ==================== Resources ====================
router.get("/resources", (req, res) => {
  const resources = store.readAll("resources").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/resources-list", { title: "Manage resources — Baseline Skills", resources });
});

router.get("/resources/new", (req, res) => {
  res.render("admin/resource-form", { title: "New resource — Baseline Skills", resource: null, mode: "new" });
});

router.post("/resources/new", (req, res) => {
  const { title, category, excerpt, url } = req.body;
  if (!title || !excerpt || !url) {
    return res.status(400).render("admin/resource-form", { title: "New resource — Baseline Skills", resource: req.body, mode: "new", error: "Title, excerpt, and link are required." });
  }
  store.insert("resources", {
    id: newId("res"),
    slug: slugify(title, { lower: true, strict: true }),
    title, category: category || "Requirements Engineering", excerpt, url,
    createdAt: new Date().toISOString(),
  });
  res.redirect("/admin/resources");
});

router.get("/resources/:id/edit", (req, res) => {
  const resource = store.findOne("resources", (r) => r.id === req.params.id);
  if (!resource) return res.status(404).send("Resource not found");
  res.render("admin/resource-form", { title: `Edit ${resource.title} — Baseline Skills`, resource, mode: "edit" });
});

router.post("/resources/:id/edit", (req, res) => {
  const existing = store.findOne("resources", (r) => r.id === req.params.id);
  if (!existing) return res.status(404).send("Resource not found");
  const { title, category, excerpt, url } = req.body;
  if (!title || !excerpt || !url) {
    return res.status(400).render("admin/resource-form", { title: `Edit ${existing.title} — Baseline Skills`, resource: { ...existing, ...req.body }, mode: "edit", error: "Title, excerpt, and link are required." });
  }
  store.update("resources", req.params.id, { title, category: category || existing.category, excerpt, url });
  res.redirect("/admin/resources");
});

router.post("/resources/:id/delete", (req, res) => {
  store.remove("resources", req.params.id);
  res.redirect("/admin/resources");
});

module.exports = router;
