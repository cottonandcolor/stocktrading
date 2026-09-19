import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/customers.json"
);

export type KycStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "VERIFIED"
  | "EXPIRED"
  | "FAILED"
  | "MANUAL_REVIEW";

export type Customer = {
  customer_id: string;
  name: string;
  dob: string;
  age: number;
  address: { line1: string; city: string; state: string; postal: string; verified: boolean };
  identity: {
    document_type: string;
    document_id: string;
    verified: boolean;
    verified_at: string;
  };
  residency: { country: string; state: string; verified: boolean };
  employment: string;
  tax_bracket: string;
  income: { annual: number; verified: boolean; source: string };
  net_worth: { estimated: number; verified: boolean };
  investment_objective: string | null;
  horizon_years: number;
  risk_questionnaire: {
    completed: boolean;
    score: string | null;
    past_behavior: string;
  };
  emergency_fund_months: number;
  kyc_status: KycStatus;
  kyc_expires_at: string | null;
  restricted_products: string[];
  portfolio: {
    account_type: string;
    as_of: string;
    total: number;
    cash: number;
    holdings: Array<{
      symbol: string;
      name?: string;
      value: number;
      shares: number | null;
    }>;
    notes: string[];
  };
};

type Db = Record<string, Customer>;

function load(): Db {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as Db;
}

function save(db: Db): void {
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");
}

export function getCustomer(customerId: string): Customer | null {
  const db = load();
  return db[customerId] ?? null;
}

export function listCustomers(): Array<{ customer_id: string; name: string; kyc_status: KycStatus }> {
  return Object.values(load()).map((c) => ({
    customer_id: c.customer_id,
    name: c.name,
    kyc_status: effectiveKycStatus(c),
  }));
}

export function effectiveKycStatus(c: Customer, now = new Date()): KycStatus {
  if (c.kyc_status === "VERIFIED" && c.kyc_expires_at) {
    if (new Date(c.kyc_expires_at).getTime() < now.getTime()) return "EXPIRED";
  }
  return c.kyc_status;
}

export function missingKycFields(c: Customer): string[] {
  const missing: string[] = [];
  if (!c.identity.verified) missing.push("identity_verification");
  if (!c.address.verified) missing.push("address_verification");
  if (!c.residency.verified) missing.push("residency_verification");
  if (!c.income.verified) missing.push("income_verification");
  if (!c.net_worth.verified) missing.push("net_worth_verification");
  if (!c.risk_questionnaire.completed || !c.risk_questionnaire.score) {
    missing.push("risk_questionnaire");
  }
  if (!c.investment_objective) missing.push("investment_objective");
  if (effectiveKycStatus(c) === "EXPIRED") missing.push("kyc_reverification");
  return missing;
}

export function updateCustomer(customerId: string, patch: Partial<Customer>): Customer {
  const db = load();
  const current = db[customerId];
  if (!current) throw new Error(`Unknown customer ${customerId}`);
  const next = { ...current, ...patch, customer_id: customerId };
  db[customerId] = next;
  save(db);
  return next;
}

export function setKycStatus(
  customerId: string,
  status: KycStatus,
  expiresAt?: string | null
): Customer {
  return updateCustomer(customerId, {
    kyc_status: status,
    kyc_expires_at: expiresAt === undefined ? getCustomer(customerId)?.kyc_expires_at ?? null : expiresAt,
  });
}

export function defaultCustomerId(): string {
  return "cust_jane_001";
}
