import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import {
  defaultCustomerId,
  effectiveKycStatus,
  getCustomer,
} from "./store.js";

export type NewsItem = {
  id: string;
  headline: string;
  source: string;
  as_of: string;
  sentiment: "bullish" | "bearish" | "neutral";
  symbols: string[];
  summary: string;
};

export type TaskItem = {
  id: string;
  title: string;
  due: string;
  status: "open" | "done";
  priority: "high" | "medium" | "low";
  related_customer_id?: string;
  created_at: string;
};

export type AppointmentItem = {
  id: string;
  title: string;
  with_whom: string;
  start: string;
  end: string;
  channel: "zoom" | "phone" | "in_person" | "slack";
  notes?: string;
};

export type SlackDraft = {
  id: string;
  channel: string;
  text: string;
  status: "draft" | "queued_for_slack_mcp" | "sent_webhook" | "failed";
  created_at: string;
  related?: string;
};

export type ClientNotification = {
  id: string;
  channel: "email";
  to: string;
  subject: string;
  body: string;
  form_url: string;
  form_token: string;
  reason: "kyc_expired" | "kyc_incomplete" | "general";
  customer_id: string;
  customer_name: string;
  status: "queued_demo" | "approved_sent_demo" | "failed";
  created_at: string;
};

type Desk = {
  news: NewsItem[];
  tasks: TaskItem[];
  appointments: AppointmentItem[];
  slack_drafts: SlackDraft[];
  client_notifications: ClientNotification[];
};

function defaultDesk(): Desk {
  const now = new Date();
  const iso = (hoursFromNow: number) =>
    new Date(now.getTime() + hoursFromNow * 3600_000).toISOString();
  return {
    news: [
      {
        id: "news_fed",
        headline: "Treasury yields steady as cash alternatives remain attractive",
        source: "FinGuard Wire (demo)",
        as_of: "2026-09-19",
        sentiment: "neutral",
        symbols: ["SHY", "BIL", "SGOV"],
        summary:
          "Short-duration yields near 4% keep opportunity-cost of idle cash in focus for retirement deployment plans.",
      },
      {
        id: "news_tech",
        headline: "Mega-cap software mixed into Friday close; IGV watchlist active",
        source: "FinGuard Wire (demo)",
        as_of: "2026-09-19",
        sentiment: "neutral",
        symbols: ["IGV", "GOOGL", "META"],
        summary:
          "Software sleeve volatility elevates concentration risk for clients already heavy in tech single names.",
      },
      {
        id: "news_vol",
        headline: "VIX calm; leveraged ETF suitability reminders in force",
        source: "FinGuard Wire (demo)",
        as_of: "2026-09-19",
        sentiment: "bearish",
        symbols: ["BITX", "SSO", "TQQQ"],
        summary:
          "Low realized vol can hide path-risk in leveraged products — FinGuard restricts them as long-term core holdings.",
      },
    ],
    tasks: [
      {
        id: "task_kyc_review",
        title: "Confirm Jane Smith KYC packet before quarterly review",
        due: iso(4),
        status: "open",
        priority: "high",
        related_customer_id: "cust_jane_001",
        created_at: now.toISOString(),
      },
      {
        id: "task_tlh",
        title: "Prep tax-loss harvest candidates (TSLA, BILL)",
        due: iso(28),
        status: "open",
        priority: "medium",
        related_customer_id: "cust_jane_001",
        created_at: now.toISOString(),
      },
      {
        id: "task_cash",
        title: "Draft DCA schedule for $158k cash sleeve",
        due: iso(8),
        status: "open",
        priority: "high",
        related_customer_id: "cust_jane_001",
        created_at: now.toISOString(),
      },
    ],
    appointments: [
      {
        id: "appt_quarterly",
        title: "Quarterly portfolio review — Jane Smith",
        with_whom: "Jane Smith",
        start: iso(26),
        end: iso(27),
        channel: "zoom",
        notes: "Cover KYC refresh, cash deployment, and restricted products.",
      },
      {
        id: "appt_compliance",
        title: "Internal suitability sync",
        with_whom: "Compliance desk",
        start: iso(50),
        end: iso(51),
        channel: "slack",
        notes: "Review leveraged-ETF policy edge cases.",
      },
    ],
    slack_drafts: [],
    client_notifications: [],
  };
}

function load(): Desk {
  getDb(); // ensure seed
  const row = getDb()
    .prepare("SELECT data FROM desk_state WHERE id = 1")
    .get() as { data: string } | undefined;
  if (!row) {
    const desk = defaultDesk();
    save(desk);
    return desk;
  }
  const raw = JSON.parse(row.data) as Partial<Desk>;
  return {
    news: raw.news ?? [],
    tasks: raw.tasks ?? [],
    appointments: raw.appointments ?? [],
    slack_drafts: raw.slack_drafts ?? [],
    client_notifications: raw.client_notifications ?? [],
  };
}

function save(desk: Desk): void {
  getDb()
    .prepare(
      `INSERT INTO desk_state (id, data, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    )
    .run(JSON.stringify(desk, null, 2), new Date().toISOString());
}

export function getDesk() {
  return load();
}

export function listNews() {
  return load().news;
}

export function listTasks(status?: "open" | "done") {
  const tasks = load().tasks;
  return status ? tasks.filter((t) => t.status === status) : tasks;
}

export function createTask(input: {
  title: string;
  due: string;
  priority?: TaskItem["priority"];
  related_customer_id?: string;
}): TaskItem {
  const desk = load();
  const task: TaskItem = {
    id: `task_${randomUUID().slice(0, 8)}`,
    title: input.title,
    due: input.due,
    status: "open",
    priority: input.priority || "medium",
    related_customer_id: input.related_customer_id,
    created_at: new Date().toISOString(),
  };
  desk.tasks.unshift(task);
  save(desk);
  return task;
}

export function completeTask(taskId: string): TaskItem | null {
  const desk = load();
  const task = desk.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  task.status = "done";
  save(desk);
  return task;
}

/** Close open remediation tasks after KYC is restored (advisor journey). */
export function completeKycRemediationTasks(customerId?: string): number {
  const desk = load();
  let n = 0;
  for (const task of desk.tasks) {
    if (task.status !== "open") continue;
    if (customerId && task.related_customer_id && task.related_customer_id !== customerId) {
      continue;
    }
    if (/kyc.*(expir|renew|reverify|verif)|expir.*kyc/i.test(task.title)) {
      task.status = "done";
      n += 1;
    }
  }
  if (n) save(desk);
  return n;
}

export function listAppointments() {
  return load().appointments.sort((a, b) => a.start.localeCompare(b.start));
}

export function scheduleAppointment(input: {
  title: string;
  with_whom: string;
  start: string;
  end: string;
  channel?: AppointmentItem["channel"];
  notes?: string;
}): AppointmentItem {
  const desk = load();
  const appt: AppointmentItem = {
    id: `appt_${randomUUID().slice(0, 8)}`,
    title: input.title,
    with_whom: input.with_whom,
    start: input.start,
    end: input.end,
    channel: input.channel || "zoom",
    notes: input.notes,
  };
  desk.appointments.push(appt);
  save(desk);
  return appt;
}

export function draftSlackMessage(input: {
  channel: string;
  text: string;
  related?: string;
}): SlackDraft {
  const desk = load();
  const draft: SlackDraft = {
    id: `slack_${randomUUID().slice(0, 8)}`,
    channel: input.channel,
    text: input.text,
    status: "queued_for_slack_mcp",
    created_at: new Date().toISOString(),
    related: input.related,
  };
  desk.slack_drafts.unshift(draft);
  save(desk);
  return draft;
}

export function listSlackDrafts(limit = 20) {
  return load().slack_drafts.slice(0, limit);
}

export function queueKycExpiredNotification(input: {
  customer_id: string;
  customer_name: string;
  email: string;
  kyc_expires_at: string | null;
  missing_fields?: string[];
  public_base_url?: string;
}): ClientNotification {
  const desk = load();
  const token = `kyc_${randomUUID().slice(0, 10)}`;
  const base = (input.public_base_url || "http://127.0.0.1:8765").replace(/\/$/, "");
  const form_url = `${base}/kyc-form/${token}`;
  const expiresLabel = input.kyc_expires_at
    ? new Date(input.kyc_expires_at).toLocaleDateString()
    : "unknown";
  const missing =
    input.missing_fields && input.missing_fields.length
      ? `Please update: ${input.missing_fields.join(", ")}.`
      : "Please complete identity, address, income, and risk questionnaire sections.";

  const notification: ClientNotification = {
    id: `notif_${randomUUID().slice(0, 8)}`,
    channel: "email",
    to: input.email,
    subject: `Action required: KYC expired for ${input.customer_name}`,
    body: [
      `Hi ${input.customer_name},`,
      "",
      `Your FinGuard KYC verification expired on ${expiresLabel}.`,
      "Advisory recommendations and paper trades are paused until you re-verify.",
      "",
      missing,
      "",
      `Complete the secure renewal form: ${form_url}`,
      "",
      "This is a demo notification from FinGuard (educational only).",
    ].join("\n"),
    form_url,
    form_token: token,
    reason: "kyc_expired",
    customer_id: input.customer_id,
    customer_name: input.customer_name,
    status: "queued_demo",
    created_at: new Date().toISOString(),
  };
  desk.client_notifications.unshift(notification);
  save(desk);
  return notification;
}

export function listClientNotifications(limit = 20) {
  return load().client_notifications.slice(0, limit);
}

export function getNotificationByToken(token: string): ClientNotification | null {
  return load().client_notifications.find((n) => n.form_token === token) ?? null;
}

export function markNotificationSent(id: string): ClientNotification | null {
  const desk = load();
  const n = desk.client_notifications.find((x) => x.id === id);
  if (!n) return null;
  n.status = "approved_sent_demo";
  save(desk);
  return n;
}

export function dashboardSnapshot() {
  const desk = load();
  const customer = getCustomer(defaultCustomerId());
  const kyc_status = customer ? effectiveKycStatus(customer) : "NOT_STARTED";
  return {
    as_of: new Date().toISOString(),
    kyc_gate: "Recommendations require VERIFIED KYC",
    client: customer
      ? {
          customer_id: customer.customer_id,
          name: customer.name,
          kyc_status,
          kyc_expires_at: customer.kyc_expires_at,
        }
      : null,
    news: desk.news,
    tasks_open: desk.tasks.filter((t) => t.status === "open"),
    appointments_upcoming: desk.appointments
      .filter((a) => new Date(a.start).getTime() >= Date.now() - 3600_000)
      .sort((a, b) => a.start.localeCompare(b.start)),
    slack_queue: desk.slack_drafts.slice(0, 10),
    client_notifications: desk.client_notifications.slice(0, 10),
    slack_mcp_hint:
      "Attach Slack MCP in TrueForge (Settings → Connectors). Agent should post queued drafts with Slack tools after human approval.",
  };
}
