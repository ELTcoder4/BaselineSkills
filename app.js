require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Basic HTTP security headers on every response. Not a substitute for a
// full policy (e.g. a tuned Content-Security-Policy for this app's actual
// script/style/image sources), but covers the standard low-effort,
// high-value defaults.
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // X-XSS-Protection is deprecated and ignored by modern browsers (which rely
  // on CSP instead), but it's harmless to set for the handful of older
  // browsers that still honor it, and it was explicitly asked for.
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// If this app runs behind a reverse proxy/load balancer (Netlify, Heroku,
// nginx, etc.), uncomment the line below so req.ip and req.secure reflect
// the real client rather than the proxy. Only enable this if you actually
// control/trust that proxy — otherwise a client can spoof X-Forwarded-For
// and bypass the IP-based rate limiting in lib/security.js.
//
// This also matters for the session cookie below: with NODE_ENV=production,
// the cookie's `secure` flag requires Express to see the connection as
// HTTPS. Behind a TLS-terminating proxy, Express only knows that from the
// X-Forwarded-Proto header, which it only reads when trust proxy is set.
// Skip this in production behind a proxy and logins will silently break —
// the browser won't send a `secure` cookie back over what looks like plain
// HTTP.
// app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "baseline-skills-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

// Make a few things available to every view without passing them explicitly each time.
app.use((req, res, next) => {
  res.locals.isAdmin = !!(req.session && req.session.isAdmin);
  res.locals.currentPath = req.path;
  next();
});

app.use("/", require("./routes/public"));
app.use("/", require("./routes/registration"));
app.use("/admin", require("./routes/admin"));

app.use((req, res) => {
  res.status(404).render("404", { title: "Page not found" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Baseline Skills running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin/login`);
});
