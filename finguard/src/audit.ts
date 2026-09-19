import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";

const LEGACY_AUDIT = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  "logs",
  "finguard_audit.jsonl"
);

export type AuditEvent = {
  ts: string;
  agent: string;
  action: string;
  customer_id?: string;
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED" | "INFO";
  reason?: string;
  detail?: Record<string, unknown>;
};

export function audit(event: Omit<AuditEvent, "ts">): AuditEvent {
  const full: AuditEvent = {
    ts: new Date().toISOString(),
    ...event,
  };
  getDb()
    .prepare("INSERT INTO audit_events (ts, payload) VALUES (?, ?)")
    .run(full.ts, JSON.stringify(full));
  return full;
}

export function readAudit(limit = 40): AuditEvent[] {
  const rows = getDb()
    .prepare(
      "SELECT payload FROM audit_events ORDER BY id DESC LIMIT ?"
    )
    .all(limit) as Array<{ payload: string }>;
  if (rows.length) {
    return rows.map((r) => JSON.parse(r.payload) as AuditEvent).reverse();
  }
  // One-time fallback for older JSONL demos
  if (!fs.existsSync(LEGACY_AUDIT)) return [];
  const lines = fs
    .readFileSync(LEGACY_AUDIT, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line) as AuditEvent);
}

export function auditPath(): string {
  return `sqlite:${process.env.FINGUARD_DB_PATH || "finguard/data/finguard.sqlite"}#audit_events`;
}
