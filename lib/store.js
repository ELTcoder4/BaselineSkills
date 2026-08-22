// Simple, dependency-free JSON-file data store.
// Each "table" is a JSON array in its own file under /data.
// Writes are serialized per-file with a naive in-process queue so two
// near-simultaneous requests can't corrupt the file (adequate for this
// scale; swap for a real database if traffic grows beyond a single
// small server).

const fs = require("fs");
const path = require("path");

// Configurable via DATA_DIR so this can point at a mounted persistent disk
// in production (e.g., Render's persistent disks aren't at the app's own
// code path) — defaults to the existing local ./data folder for development,
// so nothing changes if you don't set it.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");

// Ensure the directory exists rather than failing on first write — matters
// especially for a freshly-mounted empty persistent disk in production.
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// First-boot seeding: if this is a fresh/empty data directory (e.g., a
// newly-mounted persistent disk on Render with nothing on it yet), seed
// courses.json from the bundled seed data, and initialize the other files
// as empty arrays — so a first deploy shows the real course catalog
// instead of an empty site. Only ever runs when the file doesn't exist yet;
// never overwrites real data on subsequent boots.
function seedIfMissing(name, seedData) {
  const fp = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, JSON.stringify(seedData, null, 2), "utf8");
    console.log(`[store] seeded ${name}.json (first boot on this data directory)`);
  }
}
seedIfMissing("courses", require("../seed/courses.seed.json"));
seedIfMissing("registrations", []);
seedIfMissing("inquiries", []);
seedIfMissing("email-log", []);
seedIfMissing("admins", []);
seedIfMissing("trainers", []);
seedIfMissing("blogs", []);
seedIfMissing("resources", require("../seed/resources.seed.json"));

const writeQueues = {};

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readAll(name) {
  const fp = filePath(name);
  if (!fs.existsSync(fp)) return [];
  const raw = fs.readFileSync(fp, "utf8").trim();
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[store] failed to parse ${name}.json, treating as empty`, e);
    return [];
  }
}

function writeAll(name, rows) {
  const fp = filePath(name);
  const tmp = fp + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
  fs.renameSync(tmp, fp); // atomic on the same filesystem
}

// Queue writes per-file so concurrent requests don't race on read-modify-write.
function withWriteLock(name, fn) {
  const prior = writeQueues[name] || Promise.resolve();
  const next = prior.then(fn, fn);
  writeQueues[name] = next.catch(() => {}); // don't let one failure jam the queue
  return next;
}

function insert(name, row) {
  return withWriteLock(name, () => {
    const rows = readAll(name);
    rows.push(row);
    writeAll(name, rows);
    return row;
  });
}

function update(name, id, patch) {
  return withWriteLock(name, () => {
    const rows = readAll(name);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch };
    writeAll(name, rows);
    return rows[idx];
  });
}

function remove(name, id) {
  return withWriteLock(name, () => {
    const rows = readAll(name);
    const next = rows.filter((r) => r.id !== id);
    writeAll(name, next);
    return next.length !== rows.length;
  });
}

function findOne(name, predicate) {
  return readAll(name).find(predicate) || null;
}

module.exports = { readAll, writeAll, insert, update, remove, findOne };
