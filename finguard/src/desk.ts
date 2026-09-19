import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const DATA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/desk.json"
);

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

type Desk = {
  news: NewsItem[];
  tasks: TaskItem[];
  appointments: AppointmentItem[];
  slack_drafts: SlackDraft[];
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
  };
}

function load(): Desk {
  if (!fs.existsSync(DATA_PATH)) {
    const desk = defaultDesk();
    save(desk);
    return desk;
  }
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as Desk;
}

function save(desk: Desk): void {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(desk, null, 2) + "\n");
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

export function dashboardSnapshot() {
  const desk = load();
  return {
    as_of: new Date().toISOString(),
    kyc_gate: "Recommendations require VERIFIED KYC",
    news: desk.news,
    tasks_open: desk.tasks.filter((t) => t.status === "open"),
    appointments_upcoming: desk.appointments
      .filter((a) => new Date(a.start).getTime() >= Date.now() - 3600_000)
      .sort((a, b) => a.start.localeCompare(b.start)),
    slack_queue: desk.slack_drafts.slice(0, 10),
    slack_mcp_hint:
      "Attach Slack MCP in TrueForge (Settings → Connectors). Agent should post queued drafts with Slack tools after human approval.",
  };
}
