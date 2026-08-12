const express = require("express");
const router = express.Router();
const store = require("../lib/store");
const { sendMail, escapeHtml, sanitizeHeaderValue } = require("../lib/mailer");
const { newId } = require("../lib/id");
const { createIpRateLimiter } = require("../lib/security");

const publicFormLimiter = createIpRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many submissions from this address. Please wait a minute and try again.",
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
  res.render("course-detail", { title: `${course.title} — Baseline Skills`, course, related });
});

router.get("/corporate-training", (req, res) => {
  res.render("corporate-training", { title: "Corporate Training — Baseline Skills" });
});

router.post("/corporate-training/inquiry", publicFormLimiter, (req, res) => {
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
    subject: `New corporate training inquiry — ${sanitizeHeaderValue(company)}`,
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
  const articles = [
    { slug: "verifiable-requirements", title: "How to Write Verifiable Requirements", category: "Templates & Checklists", excerpt: "Most \"unverifiable\" requirements share the same three root causes. Here's how to catch them before review." },
    { slug: "requirements-review-checklist", title: "Requirements Review Checklist", category: "Templates & Checklists", excerpt: "A practical, print-ready checklist covering the six IREB CPRE quality criteria." },
    { slug: "aspice-traceability-essentials", title: "ASPICE Traceability Essentials", category: "ASPICE & Automotive", excerpt: "What SWE.1 traceability evidence actually needs to show — and the gaps assessors flag most often." },
    { slug: "mbse-starter-guide", title: "MBSE Starter Guide", category: "MBSE", excerpt: "Moving from document-based to model-based systems engineering, one diagram at a time." },
    { slug: "ai-prompt-templates-re", title: "AI Prompt Templates for Requirements Engineers", category: "AI for Engineering", excerpt: "Five prompt patterns that hold up to IREB CPRE quality criteria, not just \"sound good.\"" },
    { slug: "cpre-vs-systems-engineering", title: "CPRE vs Systems Engineering: What Should You Learn First?", category: "Requirements Engineering", excerpt: "They're complementary, not competing — but the order you learn them in matters." },
  ];
  res.render("resources", { title: "RE Pulse — Baseline Skills", articles });
});

router.get("/contact", (req, res) => {
  res.render("contact", { title: "Contact — Baseline Skills" });
});

router.post("/contact", publicFormLimiter, (req, res) => {
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
    subject: `New contact form message — ${sanitizeHeaderValue(name)}`,
    html: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) sent a message.</p>
           <p>Company: ${escapeHtml(company) || "n/a"} · Role: ${escapeHtml(role) || "n/a"} · Course interest: ${escapeHtml(courseInterest) || "n/a"} · Team size: ${escapeHtml(teamSize) || "n/a"} · Preferred mode: ${escapeHtml(deliveryMode) || "n/a"}</p>
           <p>${escapeHtml(message)}</p>`,
  });

  res.render("contact", { title: "Contact — Baseline Skills", success: true });
});

module.exports = router;
