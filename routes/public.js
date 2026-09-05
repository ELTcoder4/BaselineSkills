const express = require("express");
const router = express.Router();
const path = require("path");
const store = require("../lib/store");
const { sendMail, escapeHtml } = require("../lib/mailer");
const { newId } = require("../lib/id");
const createRateLimiter = require("../lib/rate-limiter");
const { BROCHURE_DIR } = require("../lib/brochures");

const formRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyPrefix: "public_form",
  message: "Too many submissions. Please wait a few minutes before trying again.",
});

const brochureRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyPrefix: "brochure_request",
  message: "Too many brochure requests. Please wait a few minutes before trying again.",
});

function publishedCourses() {
  return store.readAll("courses").filter((c) => c.published);
}

router.get("/", (req, res) => {
  const courses = publishedCourses();
  const upcoming = courses
    .flatMap((c) => (c.sessions || []).map((s) => ({ ...s, course: c })))
    .filter((s) => s.startDate !== "On Demand")
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
    .slice(0, 4);

  const categories = ["Requirements Engineering", "Systems Engineering", "Business Analysis", "Automotive"];
  const byCategory = {};
  categories.forEach((cat) => {
    byCategory[cat] = courses.filter((c) => c.category === cat).slice(0, 5);
  });

  res.render("home", { title: "Baseline Skills — Build Skills. Establish Excellence.", byCategory, upcoming });
});

router.get("/courses", (req, res) => {
  const courses = publishedCourses();
  const category = req.query.category || "All";
  const filtered = category === "All" ? courses : courses.filter((c) => c.category === category);
  const categories = ["All", ...new Set(courses.map((c) => c.category))];
  res.render("courses", { title: "Courses — Baseline Skills", courses: filtered, categories, activeCategory: category });
});

router.get("/courses/:slug", (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: "Course not found" });
  const related = publishedCourses()
    .filter((c) => c.category === course.category && c.id !== course.id)
    .slice(0, 3);
  const trainer = course.trainerId ? store.findOne("trainers", (t) => t.id === course.trainerId) : null;
  res.render("course-detail", { title: `${course.title} — Baseline Skills`, course, related, trainer });
});

// Emails a link to the brochure rather than downloading it directly, so we
// capture the requester's email as a lead — the file itself lives at an
// unguessable URL (see lib/brochures.js), not behind real access control.
router.post("/courses/:slug/brochure", brochureRateLimiter, async (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).json({ error: "Course not found" });
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  if (!course.brochureFilename) {
    return res.status(404).json({ error: "No brochure is available for this course yet." });
  }

  const downloadUrl = `${req.protocol}://${req.get("host")}/brochure/${course.brochureFilename}`;

  await sendMail({
    to: email,
    subject: `Your brochure: ${course.title.replace(/[\r\n]/g, "")}`,
    html: `<p>Thanks for your interest in <strong>${escapeHtml(course.title)}</strong>.</p>
           <p>Download your brochure here: <a href="${downloadUrl}">${downloadUrl}</a></p>
           <p>Questions? Just reply to this email or visit <a href="https://baselineskills.com/contact">our contact page</a>.</p>`,
  });

  // Log it alongside other inquiries so it shows up in the existing admin
  // Inquiries view — no new admin page needed just to see who asked.
  store.insert("inquiries", {
    id: newId("inq"),
    type: "brochure-request",
    name: email.split("@")[0],
    email,
    company: "", teamSize: "", role: "", courseInterest: course.title, deliveryMode: "",
    message: `Requested the brochure for "${course.title}".`,
    createdAt: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// Serves the brochure PDF itself. Deliberately unauthenticated (the whole
// point is a prospect clicking an emailed link, with no account) — the
// filename is a long random ID, which is the only thing standing between
// "public" and "gated" here. See lib/brochures.js for that tradeoff.
router.get("/brochure/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path traversal attempt
  if (!/^[a-z0-9_.-]+\.pdf$/i.test(filename)) return res.status(400).send("Invalid file name");
  const filePath = path.join(BROCHURE_DIR, filename);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).send("Brochure not found");
  });
});

router.get("/corporate-training", (req, res) => {
  res.render("corporate-training", { title: "Corporate Training — Baseline Skills" });
});

router.post("/corporate-training/inquiry", formRateLimiter, (req, res) => {
  const { name, company, email, phone, teamSize, message } = req.body;
  if (!name || !company || !email) {
    return res.status(400).render("corporate-training", {
      title: "Corporate Training — Baseline Skills",
      error: "Name, company, and email are required.",
      form: req.body,
    });
  }

  const inquiry = {
    id: newId("inq"),
    type: "corporate-training",
    name, company, email, phone: phone || "", teamSize: teamSize || "",
    message: message || "",
    createdAt: new Date().toISOString(),
  };
  store.insert("inquiries", inquiry);

  sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New corporate training inquiry — ${company.replace(/[\r\n]/g, "")}`,
    html: `<p><strong>${escapeHtml(name)}</strong> at <strong>${escapeHtml(company)}</strong> (${escapeHtml(email)}, ${escapeHtml(phone) || "no phone given"}) requested corporate training info.</p>
           <p>Team size: ${escapeHtml(teamSize) || "not specified"}</p>
           <p>Message: ${escapeHtml(message) || "(none)"}</p>`,
  });

  res.render("corporate-training", { title: "Corporate Training — Baseline Skills", success: true });
});

router.get("/about", (req, res) => {
  res.render("about", { title: "About Us — Baseline Skills" });
});

router.get("/resources", (req, res) => {
  const articles = store.readAll("resources").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("resources", { title: "RE Pulse — Baseline Skills", articles });
});

router.get("/blog", (req, res) => {
  const posts = store.readAll("blogs")
    .filter((b) => b.published)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("blog-list", { title: "Blog — Baseline Skills", posts });
});

router.get("/blog/:slug", (req, res) => {
  const post = store.findOne("blogs", (b) => b.slug === req.params.slug && b.published);
  if (!post) return res.status(404).render("404", { title: "Post not found" });
  const related = store.readAll("blogs")
    .filter((b) => b.published && b.category === post.category && b.id !== post.id)
    .slice(0, 3);
  res.render("blog-detail", { title: `${post.title} — Baseline Skills`, post, related });
});

router.get("/contact", (req, res) => {
  res.render("contact", { title: "Contact — Baseline Skills" });
});

router.post("/contact", formRateLimiter, (req, res) => {
  const { name, email, company, role, courseInterest, teamSize, deliveryMode, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).render("contact", { title: "Contact — Baseline Skills", error: "Name, email, and message are required.", form: req.body });
  }

  const contactEntry = {
    id: newId("contact"),
    type: "contact",
    name, email, company: company || "", role: role || "",
    courseInterest: courseInterest || "", teamSize: teamSize || "",
    deliveryMode: deliveryMode || "", message,
    createdAt: new Date().toISOString(),
  };
  store.insert("inquiries", contactEntry);

  sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New contact form message — ${name.replace(/[\r\n]/g, "")}`,
    html: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) sent a message.</p>
           <p>Company: ${escapeHtml(company) || "n/a"} · Role: ${escapeHtml(role) || "n/a"} · Course interest: ${escapeHtml(courseInterest) || "n/a"} · Team size: ${escapeHtml(teamSize) || "n/a"} · Preferred mode: ${escapeHtml(deliveryMode) || "n/a"}</p>
           <p>${escapeHtml(message)}</p>`,
  });

  res.render("contact", { title: "Contact — Baseline Skills", success: true });
});

module.exports = router;

