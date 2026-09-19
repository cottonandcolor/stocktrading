/**
 * FinGuard system of record for TrueForge integration.
 * TrueForge stores sessions/turns; this SQLite DB stores business data the MCP exposes.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB = path.join(ROOT, "data", "finguard.sqlite");
const CUSTOMERS_SEED = path.join(ROOT, "data", "customers.json");
const DESK_SEED = path.join(ROOT, "data", "desk.json");

export const DB_PATH = process.env.FINGUARD_DB_PATH || DEFAULT_DB;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS customers (
      customer_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trueforge_sessions (
      session_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desk_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  seedIfEmpty(db);
  return db;
}

function seedIfEmpty(database: DatabaseSync) {
  const count = database
    .prepare("SELECT COUNT(*) AS n FROM customers")
    .get() as { n: number };
  if (count.n === 0 && fs.existsSync(CUSTOMERS_SEED)) {
    const raw = JSON.parse(fs.readFileSync(CUSTOMERS_SEED, "utf8")) as Record<
      string,
      unknown
    >;
    const upsert = database.prepare(
      "INSERT OR REPLACE INTO customers (customer_id, data, updated_at) VALUES (?, ?, ?)"
    );
    const now = new Date().toISOString();
    for (const [id, customer] of Object.entries(raw)) {
      upsert.run(id, JSON.stringify(customer), now);
    }
  }

  const desk = database.prepare("SELECT data FROM desk_state WHERE id = 1").get();
  if (!desk && fs.existsSync(DESK_SEED)) {
    const raw = fs.readFileSync(DESK_SEED, "utf8");
    database
      .prepare(
        "INSERT INTO desk_state (id, data, updated_at) VALUES (1, ?, ?)"
      )
      .run(raw, new Date().toISOString());
  }
}

export function dataBackendInfo() {
  getDb();
  return {
    backend: "sqlite",
    path: DB_PATH,
    role: "FinGuard system of record (TrueForge MCP)",
    trueforge_stores: ["agent specs", "sessions", "turns", "events", "approvals"],
    finguard_stores: [
      "customers / KYC",
      "desk (news, tasks, appointments, slack, notifications)",
      "trueforge session → customer bindings",
      "audit events",
    ],
    how_to_swap:
      "Replace getDb() readers/writers with CRM/KYC/broker APIs; keep MCP tool names stable for TrueForge.",
  };
}

export function bindTrueForgeSession(input: {
  session_id: string;
  customer_id: string;
  title?: string;
}) {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO trueforge_sessions (session_id, customer_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         customer_id = excluded.customer_id,
         title = COALESCE(excluded.title, trueforge_sessions.title),
         updated_at = excluded.updated_at`
    )
    .run(
      input.session_id,
      input.customer_id,
      input.title ?? null,
      now,
      now
    );
  return {
    session_id: input.session_id,
    customer_id: input.customer_id,
    title: input.title ?? null,
    updated_at: now,
  };
}

export function getTrueForgeSessionBinding(sessionId: string) {
  const row = getDb()
    .prepare(
      "SELECT session_id, customer_id, title, created_at, updated_at FROM trueforge_sessions WHERE session_id = ?"
    )
    .get(sessionId) as
    | {
        session_id: string;
        customer_id: string;
        title: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row ?? null;
}

export function listTrueForgeSessionBindings(limit = 20) {
  return getDb()
    .prepare(
      "SELECT session_id, customer_id, title, created_at, updated_at FROM trueforge_sessions ORDER BY updated_at DESC LIMIT ?"
    )
    .all(limit) as Array<{
    session_id: string;
    customer_id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
  }>;
}
