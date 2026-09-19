import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT_PATH = path.join(ROOT, "logs", "finguard_audit.jsonl");

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
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.appendFileSync(AUDIT_PATH, JSON.stringify(full) + "\n");
  return full;
}

export function readAudit(limit = 40): AuditEvent[] {
  if (!fs.existsSync(AUDIT_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line) as AuditEvent);
}

export function auditPath(): string {
  return AUDIT_PATH;
}
