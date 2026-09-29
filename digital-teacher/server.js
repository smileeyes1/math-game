const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!TEACHER_PASSWORD) throw new Error("TEACHER_PASSWORD is required");
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", "data:", "blob:", "https://resource2.heygen.ai"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: "same-origin" }
}));
app.use(express.json({ limit: "700kb" }));
app.use(cookieParser());

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: "draft-7", legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
app.use("/api", apiLimiter);

function safeAlias(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
}
function safeText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));
}
function sha256(v) {
  return crypto.createHash("sha256").update(String(v)).digest();
}
function timingEqualText(a, b) {
  const aa = sha256(a);
  const bb = sha256(b);
  return crypto.timingSafeEqual(aa, bb);
}
function makeTeacherToken() {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const body = String(exp);
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("hex");
  return body + "." + sig;
}
function verifyTeacherToken(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    const exp = Number(body);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("hex");
    const a = Buffer.from(sig || "", "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
function teacherAuth(req, res, next) {
  if (!verifyTeacherToken(req.cookies.teacher_session)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const data = Buffer.from(m[2], "base64");
  if (!data.length || data.length > 350 * 1024) return null;
  return { mime: m[1], data };
}

const teacherStreams = new Set();
function notifyTeacher(event, data = {}) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const res of teacherStreams) {
    try { res.write(payload); } catch {}
  }
}

async function initDb() {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learner_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alias varchar(40) NOT NULL,
      lesson_id varchar(80) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'active',
      current_stage varchar(80),
      progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
      mastery jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learner_events (
      id bigserial PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
      lesson_id varchar(80) NOT NULL,
      stage varchar(80),
      event_type varchar(50) NOT NULL,
      correct boolean,
      attempts integer,
      response_ms integer,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learner_evidence (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
      lesson_id varchar(80) NOT NULL,
      stage varchar(80),
      mime_type varchar(30) NOT NULL,
      image_data bytea NOT NULL,
      size_bytes integer NOT NULL,
      caption varchar(160),
      review_status varchar(20) NOT NULL DEFAULT 'pending',
      review_note varchar(240),
      created_at timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_events_session_created ON learner_events(session_id, created_at)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_sessions_updated ON learner_sessions(updated_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_evidence_session ON learner_evidence(session_id, created_at)");
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "digital-teacher", privacy: "minimal-data" });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post("/api/sessions", async (req, res) => {
  const alias = safeAlias(req.body.alias);
  const lessonId = safeText(req.body.lessonId || "number-4", 80);
  if (!alias || alias.length < 2) return res.status(400).json({ ok: false, error: "alias_required" });
  const q = await pool.query(
    "INSERT INTO learner_sessions(alias, lesson_id, current_stage) VALUES ($1,$2,$3) RETURNING id, alias, lesson_id, created_at",
    [alias, lessonId, "start"]
  );
  notifyTeacher("session", { id: q.rows[0].id, alias, lessonId });
  res.status(201).json({ ok: true, session: q.rows[0] });
});

app.post("/api/events", async (req, res) => {
  const sessionId = req.body.sessionId;
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: "bad_session" });
  const lessonId = safeText(req.body.lessonId || "number-4", 80);
  const stage = safeText(req.body.stage, 80) || null;
  const eventType = safeText(req.body.eventType, 50);
  if (!eventType) return res.status(400).json({ ok: false, error: "event_type_required" });
  const correct = typeof req.body.correct === "boolean" ? req.body.correct : null;
  const attempts = Number.isInteger(req.body.attempts) ? Math.max(0, Math.min(50, req.body.attempts)) : null;
  const responseMs = Number.isFinite(Number(req.body.responseMs)) ? Math.max(0, Math.min(30 * 60 * 1000, Number(req.body.responseMs))) : null;
  const payload = req.body.payload && typeof req.body.payload === "object" ? req.body.payload : {};
  const progress = Number.isFinite(Number(req.body.progress)) ? Math.max(0, Math.min(100, Math.round(Number(req.body.progress)))) : null;
  const mastery = req.body.mastery && typeof req.body.mastery === "object" ? req.body.mastery : null;
  const status = ["active", "completed"].includes(req.body.status) ? req.body.status : "active";

  const exists = await pool.query("SELECT id FROM learner_sessions WHERE id=$1", [sessionId]);
  if (!exists.rowCount) return res.status(404).json({ ok: false, error: "session_not_found" });

  await pool.query(
    "INSERT INTO learner_events(session_id,lesson_id,stage,event_type,correct,attempts,response_ms,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [sessionId, lessonId, stage, eventType, correct, attempts, responseMs, JSON.stringify(payload)]
  );
  await pool.query(
    `UPDATE learner_sessions SET
      current_stage=COALESCE($2,current_stage),
      progress=COALESCE($3,progress),
      mastery=COALESCE($4::jsonb,mastery),
      status=$5,
      completed_at=CASE WHEN $6 THEN COALESCE(completed_at,now()) ELSE completed_at END,
      updated_at=now()
     WHERE id=$1`,
    [sessionId, stage, progress, mastery ? JSON.stringify(mastery) : null, status, status === "completed"]
  );
  notifyTeacher("event", { sessionId, stage, eventType, correct, progress });
  res.json({ ok: true });
});

app.post("/api/evidence", async (req, res) => {
  const sessionId = req.body.sessionId;
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: "bad_session" });
  const parsed = parseDataUrl(req.body.dataUrl);
  if (!parsed) return res.status(400).json({ ok: false, error: "invalid_image" });
  const lessonId = safeText(req.body.lessonId || "number-4", 80);
  const stage = safeText(req.body.stage, 80) || null;
  const caption = safeText(req.body.caption, 160) || null;

  const exists = await pool.query("SELECT id FROM learner_sessions WHERE id=$1", [sessionId]);
  if (!exists.rowCount) return res.status(404).json({ ok: false, error: "session_not_found" });

  const q = await pool.query(
    "INSERT INTO learner_evidence(session_id,lesson_id,stage,mime_type,image_data,size_bytes,caption) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,review_status,created_at",
    [sessionId, lessonId, stage, parsed.mime, parsed.data, parsed.data.length, caption]
  );
  await pool.query(
    "INSERT INTO learner_events(session_id,lesson_id,stage,event_type,payload) VALUES ($1,$2,$3,'evidence_uploaded',$4::jsonb)",
    [sessionId, lessonId, stage, JSON.stringify({ evidenceId: q.rows[0].id, size: parsed.data.length })]
  );
  notifyTeacher("evidence", { sessionId, evidenceId: q.rows[0].id, stage });
  res.status(201).json({ ok: true, evidence: q.rows[0] });
});

app.post("/api/teacher/login", loginLimiter, (req, res) => {
  if (!timingEqualText(req.body.password || "", TEACHER_PASSWORD)) {
    return res.status(401).json({ ok: false, error: "wrong_password" });
  }
  const token = makeTeacherToken();
  res.cookie("teacher_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/"
  });
  res.json({ ok: true });
});

app.post("/api/teacher/logout", teacherAuth, (req, res) => {
  res.clearCookie("teacher_session", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/teacher/me", teacherAuth, (req, res) => {
  res.json({ ok: true, teacher: { name: "محمد غنام" } });
});

app.get("/api/teacher/sessions", teacherAuth, async (req, res) => {
  const q = await pool.query(`
    SELECT s.id,s.alias,s.lesson_id,s.status,s.current_stage,s.progress,s.mastery,s.created_at,s.updated_at,s.completed_at,
      COUNT(DISTINCT e.id)::int AS event_count,
      COUNT(DISTINCT e.id) FILTER (WHERE e.correct=false)::int AS error_count,
      COUNT(DISTINCT ev.id)::int AS evidence_count,
      COUNT(DISTINCT ev.id) FILTER (WHERE ev.review_status='pending')::int AS pending_evidence
    FROM learner_sessions s
    LEFT JOIN learner_events e ON e.session_id=s.id
    LEFT JOIN learner_evidence ev ON ev.session_id=s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT 250
  `);
  res.json({ ok: true, sessions: q.rows });
});

app.get("/api/teacher/sessions/:id", teacherAuth, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(400).json({ ok: false });
  const s = await pool.query("SELECT * FROM learner_sessions WHERE id=$1", [id]);
  if (!s.rowCount) return res.status(404).json({ ok: false });
  const events = await pool.query(
    "SELECT id,lesson_id,stage,event_type,correct,attempts,response_ms,payload,created_at FROM learner_events WHERE session_id=$1 ORDER BY created_at",
    [id]
  );
  const evidence = await pool.query(
    "SELECT id,lesson_id,stage,mime_type,size_bytes,caption,review_status,review_note,created_at,reviewed_at FROM learner_evidence WHERE session_id=$1 ORDER BY created_at",
    [id]
  );
  res.json({ ok: true, session: s.rows[0], events: events.rows, evidence: evidence.rows });
});

app.get("/api/teacher/evidence/:id", teacherAuth, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(400).end();
  const q = await pool.query("SELECT mime_type,image_data FROM learner_evidence WHERE id=$1", [id]);
  if (!q.rowCount) return res.status(404).end();
  res.setHeader("Content-Type", q.rows[0].mime_type);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.send(q.rows[0].image_data);
});

app.post("/api/teacher/evidence/:id/review", teacherAuth, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(400).json({ ok: false });
  const status = ["accepted", "rejected", "pending"].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ ok: false, error: "bad_status" });
  const note = safeText(req.body.note, 240) || null;
  const q = await pool.query(
    "UPDATE learner_evidence SET review_status=$2,review_note=$3,reviewed_at=CASE WHEN $2='pending' THEN NULL ELSE now() END WHERE id=$1 RETURNING id,review_status,review_note,reviewed_at",
    [id, status, note]
  );
  if (!q.rowCount) return res.status(404).json({ ok: false });
  notifyTeacher("evidence_review", q.rows[0]);
  res.json({ ok: true, evidence: q.rows[0] });
});

app.delete("/api/teacher/evidence/:id", teacherAuth, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(400).json({ ok: false });
  await pool.query("DELETE FROM learner_evidence WHERE id=$1", [id]);
  notifyTeacher("evidence_deleted", { id });
  res.json({ ok: true });
});

app.delete("/api/teacher/sessions/:id", teacherAuth, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(400).json({ ok: false });
  await pool.query("DELETE FROM learner_sessions WHERE id=$1", [id]);
  notifyTeacher("session_deleted", { id });
  res.json({ ok: true });
});

app.get("/api/teacher/stream", teacherAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("event: ready\ndata: {}\n\n");
  teacherStreams.add(res);
  const timer = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch {}
  }, 25000);
  req.on("close", () => {
    clearInterval(timer);
    teacherStreams.delete(res);
  });
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "10m" : 0
}));

app.get("/teacher", (req, res) => res.sendFile(path.join(__dirname, "public", "teacher.html")));
app.get("/lesson/:lessonId", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/", (req, res) => res.redirect("/lesson/number-4"));

initDb()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log("digital-teacher listening on " + PORT)))
  .catch(err => {
    console.error("database init failed", err);
    process.exit(1);
  });
