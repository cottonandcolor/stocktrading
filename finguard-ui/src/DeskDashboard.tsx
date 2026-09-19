import { useEffect, useRef, useState } from "react";

type Dashboard = {
  as_of: string;
  client?: {
    customer_id: string;
    name: string;
    kyc_status: string;
    kyc_expires_at: string | null;
  } | null;
  news: Array<{
    id: string;
    headline: string;
    source: string;
    as_of: string;
    sentiment: string;
    symbols: string[];
    summary: string;
  }>;
  tasks_open: Array<{
    id: string;
    title: string;
    due: string;
    priority: string;
  }>;
  appointments_upcoming: Array<{
    id: string;
    title: string;
    with_whom: string;
    start: string;
    end: string;
    channel: string;
  }>;
  slack_queue: Array<{
    id: string;
    channel: string;
    text: string;
    status: string;
    created_at: string;
  }>;
  client_notifications: Array<{
    id: string;
    to: string;
    subject: string;
    form_url: string;
    reason: string;
    status: string;
    customer_name: string;
    created_at: string;
  }>;
};

function fmtWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function isKycExpired(data: Dashboard) {
  if (data.client?.kyc_status) {
    return data.client.kyc_status === "EXPIRED";
  }
  return data.tasks_open.some((t) =>
    /kyc.*(expir|renew)|expir.*kyc/i.test(t.title)
  );
}

export default function DeskDashboard({
  journeyCue,
  currentStageLabel,
  onKycChange,
}: {
  journeyCue?: string;
  currentStageLabel?: string;
  onKycChange?: (expired: boolean) => void;
}) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const prevAsOf = useRef<string | null>(null);
  const onKycChangeRef = useRef(onKycChange);
  onKycChangeRef.current = onKycChange;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/finguard/dashboard");
        if (!res.ok) throw new Error(`dashboard ${res.status}`);
        const json = await res.json();
        if (!alive) return;
        const next = json.data as Dashboard;
        if (prevAsOf.current && prevAsOf.current !== next.as_of) {
          setFlash(true);
          window.setTimeout(() => {
            if (alive) setFlash(false);
          }, 550);
        }
        prevAsOf.current = next.as_of;
        setData(next);
        onKycChangeRef.current?.(isKycExpired(next));
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "dashboard error");
      }
    };
    void load();
    const id = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (err) {
    return (
      <aside className="desk">
        <p className="desk-error">
          Desk offline — start FinGuard MCP on :8765 ({err})
        </p>
      </aside>
    );
  }

  if (!data) {
    return (
      <aside className="desk">
        <p className="desk-loading">Loading advisor desk…</p>
      </aside>
    );
  }

  const expired = isKycExpired(data);
  const clientName = data.client?.name ?? "Jane Smith";
  const clientId = data.client?.customer_id ?? "cust_jane_001";

  return (
    <aside
      className={`desk${flash ? " updated" : ""}`}
      aria-label="Financial advisor dashboard"
    >
      <div className="desk-client">
        <div className="desk-client-name">
          <strong>{clientName}</strong>
          <span>{clientId}</span>
          <p className="desk-journey-cue">
            Day path: <em>{currentStageLabel ?? "Brief"}</em>
            {journeyCue ? ` · ${journeyCue}` : ""}
          </p>
        </div>
        <span className={`kyc${expired ? " expired" : ""}`}>
          {expired ? "KYC expired" : "KYC verified"}
        </span>
      </div>

      <div className="desk-head">
        <h2>Advisor desk</h2>
        <span>{fmtWhen(data.as_of)}</span>
      </div>

      <section className="desk-panel">
        <h3>Tasks</h3>
        <ul>
          {data.tasks_open.length === 0 && (
            <li className="muted">No open tasks</li>
          )}
          {data.tasks_open.map((t) => (
            <li key={t.id}>
              <strong data-priority={t.priority}>{t.title}</strong>
              <div className="desk-meta">
                <span>due {fmtWhen(t.due)}</span>
                <span className={`tag priority-${t.priority}`}>{t.priority}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="desk-panel">
        <h3>Appointments</h3>
        <ul>
          {data.appointments_upcoming.length === 0 && (
            <li className="muted">No upcoming appointments</li>
          )}
          {data.appointments_upcoming.map((a) => (
            <li key={a.id}>
              <strong>{a.title}</strong>
              <div className="desk-meta">
                <span>{fmtWhen(a.start)}</span>
                <span>· {a.with_whom}</span>
                <span className="tag">{a.channel}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="desk-panel">
        <h3>Market news</h3>
        <ul>
          {data.news.map((n) => (
            <li key={n.id}>
              <strong data-sentiment={n.sentiment}>{n.headline}</strong>
              <div className="desk-meta">
                <span>{n.source}</span>
                <span>·</span>
                <span>{n.as_of}</span>
                {n.symbols.map((s) => (
                  <span className="tag" key={s}>
                    {s}
                  </span>
                ))}
              </div>
              <p>{n.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="desk-panel">
        <h3>Client notify</h3>
        <ul>
          {(data.client_notifications ?? []).length === 0 && (
            <li className="muted">
              No client emails — expire KYC to trigger renewal form
            </li>
          )}
          {(data.client_notifications ?? []).map((n) => (
            <li key={n.id}>
              <strong>{n.subject}</strong>
              <div className="desk-meta">
                <span>{n.to}</span>
                <span className="tag">{n.reason}</span>
                <span className="tag">{n.status}</span>
              </div>
              <p>
                <a href={n.form_url} target="_blank" rel="noreferrer">
                  Open KYC renewal form
                </a>
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="desk-panel">
        <h3>Slack queue</h3>
        <ul>
          {data.slack_queue.length === 0 && (
            <li className="muted">No drafts — connect Slack MCP to post alerts</li>
          )}
          {data.slack_queue.map((s) => (
            <li key={s.id}>
              <strong>{s.channel}</strong>
              <div className="desk-meta">
                <span className="tag">{s.status}</span>
              </div>
              <p>{s.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
