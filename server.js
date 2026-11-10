// CineWave server — configured for Replit Deployments and local development.
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { promisify } = require("util");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
const SITE_DIR = __dirname;
const INDEX_FILE = path.join(SITE_DIR, "index.html");

if (!fs.existsSync(INDEX_FILE)) {
  console.error("Frontend not found. Expected file:", INDEX_FILE);
  console.error("Make sure Railway's Root Directory contains server.js and index.html.");
  process.exit(1);
}

app.use(express.static(SITE_DIR, { index: false }));

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";
const COOKIE_NAME = "cinewave_session";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-before-production";
const scrypt = promisify(crypto.scrypt);
const DATA_DIR = path.join(__dirname, ".data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

let pool = null;
let localUsers = [];

async function initStorage() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cinewave_users (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        email VARCHAR(254) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        vip BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("CineWave storage: PostgreSQL");
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      localUsers = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
      if (!Array.isArray(localUsers)) localUsers = [];
    } catch {
      localUsers = [];
      fs.writeFileSync(USERS_FILE, "[]");
    }
    console.warn("CineWave storage: local JSON file. For persistent deployed accounts, add a Replit PostgreSQL database and set DATABASE_URL.");
  }
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, vip: Boolean(user.vip) };
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}
function makeSession(email) {
  const payload = Buffer.from(JSON.stringify({
    email, exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  const raw = req.headers.cookie || "";
  const entry = raw.split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE_NAME + "="));
  if (!entry) return null;
  const token = decodeURIComponent(entry.slice(COOKIE_NAME.length + 1));
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !crypto.timingSafeEqual(
    Buffer.from(signature), Buffer.from(sign(payload))
  )) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > Date.now() ? data.email : null;
  } catch { return null; }
}
function setSession(res, email) {
  res.cookie(COOKIE_NAME, makeSession(email), {
    httpOnly: true, secure: isProduction, sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, path: "/"
  });
}
function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/" });
}
async function findUser(email) {
  if (pool) {
    const result = await pool.query(
      "SELECT id, name, email, password_hash, vip FROM cinewave_users WHERE email = $1",
      [email]
    );
    return result.rows[0] || null;
  }
  return localUsers.find(u => u.email === email) || null;
}
async function saveUser(user) {
  if (pool) {
    const result = await pool.query(
      "INSERT INTO cinewave_users (name, email, password_hash, vip) VALUES ($1, $2, $3, FALSE) RETURNING id, name, email, vip",
      [user.name, user.email, user.password_hash]
    );
    return result.rows[0];
  }
  const saved = { ...user, id: crypto.randomUUID(), vip: false };
  localUsers.push(saved);
  fs.writeFileSync(USERS_FILE, JSON.stringify(localUsers, null, 2), { mode: 0o600 });
  return saved;
}
async function verifyPassword(password, stored) {
  const [salt, key] = String(stored).split(":");
  if (!salt || !key) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(key, "hex");
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "CineWave" }));

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (name.length < 1 || name.length > 50)
      return res.status(400).json({ error: "Please enter a name between 1 and 50 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters long." });
    if (await findUser(email))
      return res.status(409).json({ error: "An account with this email already exists. Please sign in." });

    const user = await saveUser({ name, email, password_hash: await hashPassword(password) });
    setSession(res, email);
    return res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    console.error("Registration error:", err);
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const user = await findUser(email);
    if (!user || !(await verifyPassword(password, user.password_hash)))
      return res.status(401).json({ error: "Email or password is incorrect." });
    setSession(res, email);
    return res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Sign in failed. Please try again." });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const email = readSession(req);
    if (!email) return res.status(401).json({ error: "Not signed in." });
    const user = await findUser(email);
    if (!user) return res.status(401).json({ error: "Account not found." });
    return res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("Session lookup error:", err);
    return res.status(500).json({ error: "Could not load your account." });
  }
});

app.post("/api/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get("*", (_req, res) => res.sendFile(INDEX_FILE));

initStorage().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`CineWave listening on 0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error("Could not initialize CineWave storage:", err);
  process.exit(1);
});
