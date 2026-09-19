import { useEffect, useState } from "react";

type Dashboard = {
  as_of: string;
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

export default function DeskDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/finguard/dashboard");
        if (!res.ok) throw new Error(`dashboard ${res.status}`);
        const json = await res.json();
        if (alive) {
          setData(json.data);
          setErr(null);
        }
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
        <p className="desk-error">Desk offline — is FinGuard MCP on :8765? ({err})</p>
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

  return (
    <aside className="desk" aria-label="Financial advisor dashboard">
      <div className="desk-head">
        <h2>Advisor desk</h2>
        <span>as of {fmtWhen(data.as_of)}</span>
      </div>

      <section className="desk-panel">
        <h3>Market news</h3>
        <ul>
          {data.news.map((n) => (
            <li key={n.id}>
              <strong data-sentiment={n.sentiment}>{n.headline}</strong>
              <span>
                {n.source} · {n.as_of} · {n.symbols.join(", ")}
              </span>
              <p>{n.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="desk-panel">
        <h3>Tasks</h3>
        <ul>
          {data.tasks_open.length === 0 && <li className="muted">No open tasks</li>}
          {data.tasks_open.map((t) => (
            <li key={t.id}>
              <strong data-priority={t.priority}>{t.title}</strong>
              <span>
                due {fmtWhen(t.due)} · {t.priority}
              </span>
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
              <span>
                {fmtWhen(a.start)} · {a.with_whom} · {a.channel}
              </span>
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
              <span>{s.status}</span>
              <p>{s.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
