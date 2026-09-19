import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  TrueForge,
  isEventDelta,
  mergeEventDelta,
  type TrueForgeApi,
} from "@truefoundry/trueforge-sdk";
import DeskDashboard from "./DeskDashboard";
import "./App.css";

const client = new TrueForge({
  // Vite proxies /api → TrueForge :8790
  baseUrl: "http://127.0.0.1:5173",
  timeoutInSeconds: 600,
});

const DEMO_PROMPTS = [
  {
    label: "1. Desk + verified plan",
    text: "Show my advisor dashboard (news, tasks, appointments). Check Jane Smith's KYC, analyze her portfolio, recommend a retirement plan, then queue a Slack summary to #finguard-alerts.",
  },
  {
    label: "2. Expire KYC → block + Slack",
    text: "Simulate KYC expiration for Jane, try to generate a recommendation, queue a Slack alert about the block, and create a high-priority follow-up task.",
  },
  {
    label: "3. Paper trade + appointment",
    text: "Restore Jane to VERIFIED KYC, propose a paper VTI buy of $10,000, and schedule a Zoom quarterly review appointment with her.",
  },
];

type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "tool"; name: string; args: string; status: string }
  | {
      id: string;
      kind: "approval";
      toolCallId: string;
      threadId: string;
      name: string;
      args: string;
      resolved?: "allow" | "deny";
    }
  | { id: string; kind: "status"; text: string };

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [items, busy]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await client.sessions.create({
          agent: { name: "finguard-kyc-advisor" },
        });
        if (!cancelled) setSessionId(data.id);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : "Could not open a TrueForge session. Is TrueForge on :8790?"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runTurn = useCallback(
    async (turnInput: TrueForgeApi.TurnInputItem[]) => {
      if (!sessionId) return;
      setBusy(true);
      setError(null);

      const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
      const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
      let assistantId: string | null = null;

      try {
        const stream = await client.sessions.createTurnStream(sessionId, {
          input: turnInput,
        });

        for await (const { data: event } of stream.withMetadata()) {
          if (isEventDelta(event)) {
            const base = events.get(event.id);
            if (base) mergeEventDelta(base, event);
            const merged = events.get(event.id);
            if (merged?.type === "model.message" && typeof merged.content === "string") {
              const text = merged.content;
              setItems((prev) => {
                if (!assistantId) {
                  assistantId = uid();
                  return [...prev, { id: assistantId, kind: "assistant", text }];
                }
                return prev.map((it) =>
                  it.id === assistantId && it.kind === "assistant"
                    ? { ...it, text }
                    : it
                );
              });
            }
            continue;
          }

          events.set(event.id, event);

          if (event.type === "model.message" && event.tool_calls?.length) {
            for (const call of event.tool_calls) {
              const name =
                call.tool_info?.name ||
                call.function?.name ||
                "tool";
              const args = call.function?.arguments || "{}";
              setItems((prev) => [
                ...prev,
                {
                  id: uid(),
                  kind: "tool",
                  name,
                  args,
                  status: "called",
                },
              ]);
            }
          }

          if (event.type === "model.message" && event.content && !event.tool_calls?.length) {
            const text =
              typeof event.content === "string"
                ? event.content
                : JSON.stringify(event.content);
            setItems((prev) => [...prev, { id: uid(), kind: "assistant", text }]);
          }

          if (event.type === "tool.approval_required") {
            pendingApprovals.push(event);
            for (const ref of event.tool_calls || []) {
              const msg = events.get(ref.source_event_id || ref.sourceEventId);
              let name = "gated tool";
              let args = "{}";
              if (msg && msg.type === "model.message") {
                const call = (msg.tool_calls || msg.toolCalls || []).find(
                  (tc: { id: string }) => tc.id === ref.id
                );
                if (call) {
                  name = call.tool_info?.name || call.function?.name || name;
                  args = call.function?.arguments || args;
                }
              }
              setItems((prev) => [
                ...prev,
                {
                  id: uid(),
                  kind: "approval",
                  toolCallId: ref.id,
                  threadId: event.thread_id || event.threadId || "main",
                  name,
                  args,
                },
              ]);
            }
          }

          if (event.type === "turn.done") {
            setItems((prev) => [
              ...prev,
              {
                id: uid(),
                kind: "status",
                text: `Turn ${event.state?.status || "done"}`,
              },
            ]);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Turn failed");
      } finally {
        setBusy(false);
      }

      return pendingApprovals;
    },
    [sessionId]
  );

  const sendText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !sessionId || busy) return;
    setItems((prev) => [...prev, { id: uid(), kind: "user", text: trimmed }]);
    setInput("");
    await runTurn([{ type: "user.message", content: trimmed }]);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendText(input);
  };

  const resolveApproval = async (
    item: Extract<ChatItem, { kind: "approval" }>,
    status: "allow" | "deny"
  ) => {
    if (busy || item.resolved) return;
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id && it.kind === "approval" ? { ...it, resolved: status } : it
      )
    );
    await runTurn([
      {
        type: "user.tool_approval",
        thread_id: item.threadId,
        tool_call_id: item.toolCallId,
        approval:
          status === "allow"
            ? { status: "allow" }
            : { status: "deny", reason: "Denied in FinGuard UI" },
      } as TrueForgeApi.TurnInputItem,
    ]);
  };

  return (
    <div className="finguard-shell">
      <header className="finguard-banner">
        <div className="finguard-banner-inner">
          <p className="finguard-eyebrow">TrueForge agent harness</p>
          <h1 className="finguard-title">Finguard Financial Advisor Agent</h1>
          <p className="finguard-sub">
            KYC-gated advice on TrueForge — desk news, tasks, appointments, Slack
            queue, approvals, and audit trails.
          </p>
        </div>
        <div className="finguard-actions">
          <a
            className="finguard-link"
            href="http://localhost:8790"
            target="_blank"
            rel="noreferrer"
          >
            Open stock TrueForge UI
          </a>
          <p className="finguard-session">
            {sessionId ? `session ${sessionId.slice(0, 12)}…` : "connecting…"}
          </p>
        </div>
      </header>

      <div className="finguard-body">
        <DeskDashboard />
        <div className="finguard-main">
          <div className="finguard-demos">
            {DEMO_PROMPTS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="finguard-demo"
                disabled={!sessionId || busy}
                onClick={() => void sendText(p.text)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <main className="finguard-chat" ref={scroller}>
            {items.length === 0 && (
              <div className="finguard-empty">
                Pick a demo above or ask FinGuard to open the advisor desk.
              </div>
            )}
            {items.map((item) => {
              if (item.kind === "user") {
                return (
                  <div key={item.id} className="bubble user">
                    {item.text}
                  </div>
                );
              }
              if (item.kind === "assistant") {
                return (
                  <div key={item.id} className="bubble assistant">
                    {item.text}
                  </div>
                );
              }
              if (item.kind === "tool") {
                return (
                  <div key={item.id} className="bubble tool">
                    <strong>Tool · {item.name}</strong>
                    <pre>{item.args}</pre>
                  </div>
                );
              }
              if (item.kind === "approval") {
                return (
                  <div key={item.id} className="bubble approval">
                    <strong>Approval required · {item.name}</strong>
                    <pre>{item.args}</pre>
                    <div className="approval-actions">
                      <button
                        type="button"
                        disabled={busy || !!item.resolved}
                        onClick={() => void resolveApproval(item, "allow")}
                      >
                        Allow
                      </button>
                      <button
                        type="button"
                        className="deny"
                        disabled={busy || !!item.resolved}
                        onClick={() => void resolveApproval(item, "deny")}
                      >
                        Deny
                      </button>
                      {item.resolved && (
                        <span className="resolved">Resolved: {item.resolved}</span>
                      )}
                    </div>
                  </div>
                );
              }
              return (
                <div key={item.id} className="bubble status">
                  {item.text}
                </div>
              );
            })}
            {busy && <div className="bubble status">TrueForge is working…</div>}
            {error && <div className="bubble error">{error}</div>}
          </main>

          <form className="finguard-composer" onSubmit={onSubmit}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask FinGuard…"
              disabled={!sessionId || busy}
            />
            <button type="submit" disabled={!sessionId || busy || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
