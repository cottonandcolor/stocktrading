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

const JOURNEY_ACTIONS = {
  brief: {
    id: "brief" as const,
    text: "Open Jane Smith's book: show the advisor dashboard (news, tasks, appointments), check her KYC, and summarize what needs attention today.",
  },
  compliance: {
    id: "compliance" as const,
    text: "Simulate KYC expiration for Jane, try to generate a recommendation, notify her by email with a KYC renewal form, queue a Slack alert about the block, and create a high-priority follow-up task.",
  },
  quotes: {
    id: "quotes" as const,
    text: "Using FinGuard MCP Yahoo tools only: call yahoo_quote for AAPL, yahoo_quotes for Jane's holdings symbols if useful (or SPY QQQ VTI), and get_market_snapshot. Report live prices with as_of timestamps. Do not invent prices.",
  },
  technicals: {
    id: "technicals" as const,
    text: "Run yahoo_technical_analysis on SPY and AAPL (and VTI if useful). Summarize trend, SMA 50/200, RSI(14), MACD bias, and Bollinger context from the tool output only. Educational — not trading advice.",
  },
  advise: {
    id: "advise" as const,
    text: "Check Jane Smith's KYC, pull a live get_market_snapshot for SPY/QQQ, analyze her portfolio, recommend a retirement plan, then queue a Slack summary to #finguard-alerts.",
  },
  act: {
    id: "act" as const,
    text: "Restore Jane to VERIFIED KYC, propose a paper VTI buy of $10,000, and schedule a Zoom quarterly review appointment with her.",
  },
};

type JourneyStageId = "brief" | "compliance" | "research" | "advise" | "act";
type JourneyActionId = keyof typeof JOURNEY_ACTIONS;

const JOURNEY_STAGES: Array<{
  id: JourneyStageId;
  num: string;
  label: string;
  hint: string;
  actions: Array<{ actionId: JourneyActionId; label: string }>;
}> = [
  {
    id: "brief",
    num: "1",
    label: "Brief",
    hint: "Open the book",
    actions: [{ actionId: "brief", label: "Open Jane’s book" }],
  },
  {
    id: "compliance",
    num: "2",
    label: "Compliance",
    hint: "Clear KYC",
    actions: [{ actionId: "compliance", label: "KYC expired path" }],
  },
  {
    id: "research",
    num: "3",
    label: "Research",
    hint: "Market context",
    actions: [
      { actionId: "quotes", label: "Live quotes" },
      { actionId: "technicals", label: "Technicals" },
    ],
  },
  {
    id: "advise",
    num: "4",
    label: "Advise",
    hint: "Recommend & notify",
    actions: [{ actionId: "advise", label: "Plan & Slack" }],
  },
  {
    id: "act",
    num: "5",
    label: "Act",
    hint: "Trade & follow up",
    actions: [{ actionId: "act", label: "Trade & book review" }],
  },
];

function stageForAction(actionId: JourneyActionId): JourneyStageId {
  if (actionId === "quotes" || actionId === "technicals") return "research";
  return actionId;
}

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
  const [kycExpired, setKycExpired] = useState(false);
  const [lastStage, setLastStage] = useState<JourneyStageId | null>(null);
  const [doneStages, setDoneStages] = useState<Set<JourneyStageId>>(
    () => new Set()
  );
  const scroller = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<ChatItem[]>([]);
  const busyRef = useRef(false);

  itemsRef.current = items;
  busyRef.current = busy;

  const pendingApprovals = items.filter(
    (it) => it.kind === "approval" && !it.resolved
  );
  const hasPendingApprovals = pendingApprovals.length > 0;

  const currentStage: JourneyStageId = (() => {
    if (hasPendingApprovals) return lastStage ?? "advise";
    if (kycExpired) return "compliance";
    if (!lastStage) return "brief";
    if (lastStage === "brief" || lastStage === "research") return "advise";
    if (lastStage === "compliance") return "act";
    if (lastStage === "advise") return "act";
    return "brief";
  })();

  const journeyCue = hasPendingApprovals
    ? "Approval gate — Allow to continue the day"
    : kycExpired
      ? "Remediate KYC before Advise / Act"
      : lastStage === "act"
        ? "Day path complete — Brief again or New session"
        : "Open client → KYC → research → advise → act";

  const friendlyError = (raw: string) => {
    if (/approvals or questions are pending/i.test(raw)) {
      return "Finish Allow/Deny on the pending approval first (or click New session), then continue the journey.";
    }
    if (/Missing: call_/i.test(raw)) {
      return "TrueForge needs every pending tool approved together — use Allow all.";
    }
    return raw;
  };

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [items, busy]);

  const bindSession = async (id: string) => {
    await fetch("/finguard/sessions/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: id,
        customer_id: "cust_jane_001",
        title: "FinGuard UI session",
      }),
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await client.sessions.create({
          agent: { name: "finguard-kyc-advisor" },
        });
        if (cancelled) return;
        setSessionId(data.id);
        await bindSession(data.id);
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

  const startNewSession = async () => {
    if (busy) return;
    setError(null);
    setItems([]);
    setLastStage(null);
    setDoneStages(new Set());
    setBusy(true);
    try {
      const { data } = await client.sessions.create({
        agent: { name: "finguard-kyc-advisor" },
      });
      setSessionId(data.id);
      await bindSession(data.id);
    } catch (e) {
      setError(
        e instanceof Error ? friendlyError(e.message) : "Could not start session"
      );
    } finally {
      setBusy(false);
    }
  };

  const runTurn = useCallback(
    async (turnInput: TrueForgeApi.TurnInputItem[]) => {
      if (!sessionId) return;
      setBusy(true);
      setError(null);

      const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
      const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
      const seenToolCalls = new Set<string>();
      let assistantId: string | null = null;

      const upsertAssistant = (text: string) => {
        if (!text) return;
        setItems((prev) => {
          if (!assistantId) {
            assistantId = uid();
            return [...prev, { id: assistantId, kind: "assistant", text }];
          }
          return prev.map((it) =>
            it.id === assistantId && it.kind === "assistant" ? { ...it, text } : it
          );
        });
      };

      const recordToolCalls = (
        calls: TrueForgeApi.ToolCall[] | undefined
      ) => {
        if (!calls?.length) return;
        for (const call of calls) {
          if (!call?.id || seenToolCalls.has(call.id)) continue;
          seenToolCalls.add(call.id);
          const name =
            call.toolInfo?.name || call.function?.name || "tool";
          const args = call.function?.arguments || "{}";
          setItems((prev) => [
            ...prev,
            { id: uid(), kind: "tool", name, args, status: "called" },
          ]);
        }
      };

      try {
        const stream = await client.sessions.createTurnStream(sessionId, {
          input: turnInput,
        });

        for await (const { data: event } of stream.withMetadata()) {
          if (isEventDelta(event)) {
            const base = events.get(event.id);
            if (base) mergeEventDelta(base, event);
            const merged = events.get(event.id);
            if (merged && merged.type === "model.message") {
              if (typeof merged.content === "string") {
                upsertAssistant(merged.content);
              }
              recordToolCalls(merged.toolCalls);
            }
            continue;
          }

          events.set(event.id, event);

          if (event.type === "model.message") {
            recordToolCalls(event.toolCalls);
            if (event.content && !event.toolCalls?.length) {
              const text =
                typeof event.content === "string"
                  ? event.content
                  : JSON.stringify(event.content);
              upsertAssistant(text);
            }
          }

          if (event.type === "tool.response") {
            const preview =
              typeof event.content === "string"
                ? event.content.slice(0, 240)
                : JSON.stringify(event.content).slice(0, 240);
            setItems((prev) => [
              ...prev,
              {
                id: uid(),
                kind: "status",
                text: `Tool result · ${event.toolCallId || "tool"}: ${preview}`,
              },
            ]);
          }

          if (event.type === "tool.approval_required") {
            pendingApprovals.push(event);
            for (const ref of event.toolCalls || []) {
              const msg = events.get(ref.sourceEventId);
              let name = "gated tool";
              let args = "{}";
              if (msg && msg.type === "model.message") {
                const call = (msg.toolCalls || []).find((tc) => tc.id === ref.id);
                if (call) {
                  name = call.toolInfo?.name || call.function?.name || name;
                  args = call.function?.arguments || args;
                }
              }
              setItems((prev) => [
                ...prev,
                {
                  id: uid(),
                  kind: "approval",
                  toolCallId: ref.id,
                  threadId: event.threadId || "main",
                  name,
                  args,
                },
              ]);
            }
          }

          if (event.type === "turn.done") {
            const done = event.state;
            if (
              done &&
              "output" in done &&
              done.output &&
              typeof done.output.content === "string" &&
              !assistantId
            ) {
              upsertAssistant(done.output.content);
            }
            if (done && "requiredActions" in done) {
              for (const action of done.requiredActions || []) {
                if (
                  action.type === "tool.approval_required" &&
                  !pendingApprovals.some((a) => a.id === action.id)
                ) {
                  pendingApprovals.push(action);
                  for (const ref of action.toolCalls || []) {
                    const msg = events.get(ref.sourceEventId);
                    let name = "gated tool";
                    let args = "{}";
                    if (msg && msg.type === "model.message") {
                      const call = (msg.toolCalls || []).find(
                        (tc) => tc.id === ref.id
                      );
                      if (call) {
                        name =
                          call.toolInfo?.name || call.function?.name || name;
                        args = call.function?.arguments || args;
                      }
                    }
                    setItems((prev) => {
                      if (
                        prev.some(
                          (it) =>
                            it.kind === "approval" &&
                            it.toolCallId === ref.id &&
                            !it.resolved
                        )
                      ) {
                        return prev;
                      }
                      return [
                        ...prev,
                        {
                          id: uid(),
                          kind: "approval",
                          toolCallId: ref.id,
                          threadId: action.threadId || "main",
                          name,
                          args,
                        },
                      ];
                    });
                  }
                }
              }
            }
            const label =
              done && "status" in done
                ? done.status
                : "done";
            const waiting = pendingApprovals.length
              ? " — waiting for Allow/Deny"
              : "";
            setItems((prev) => [
              ...prev,
              {
                id: uid(),
                kind: "status",
                text: `Turn ${label}${waiting}`,
              },
            ]);
          }
        }
      } catch (e) {
        setError(
          friendlyError(e instanceof Error ? e.message : "Turn failed")
        );
      } finally {
        setBusy(false);
      }

      return pendingApprovals;
    },
    [sessionId]
  );

  const sendText = async (text: string, actionId?: JourneyActionId) => {
    const trimmed = text.trim();
    if (!trimmed || !sessionId || busy) return;
    if (hasPendingApprovals) {
      setError(
        "Finish Allow/Deny on the pending approval first (or click New session), then continue the journey."
      );
      return;
    }
    if (actionId) {
      const stage = stageForAction(actionId);
      setLastStage(stage);
      setDoneStages((prev) => {
        const next = new Set(prev);
        next.add(stage);
        return next;
      });
    }
    setItems((prev) => [...prev, { id: uid(), kind: "user", text: trimmed }]);
    setInput("");
    await runTurn([{ type: "user.message", content: trimmed }]);
  };

  const runJourneyAction = (actionId: JourneyActionId) => {
    void sendText(JOURNEY_ACTIONS[actionId].text, actionId);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendText(input);
  };

  const resolveApproval = async (
    item: Extract<ChatItem, { kind: "approval" }>,
    status: "allow" | "deny"
  ) => {
    if (busyRef.current || item.resolved) return;

    // Read from ref — setState updaters are not reliable for sync reads in
    // async handlers, and an empty approval batch makes Allow look like a no-op.
    const batch = itemsRef.current.filter(
      (it): it is Extract<ChatItem, { kind: "approval" }> =>
        it.kind === "approval" && !it.resolved
    );
    if (!batch.length) {
      setError("No pending approvals to resolve. Refresh and run the demo again.");
      return;
    }

    const ids = new Set(batch.map((b) => b.id));
    setItems((prev) =>
      prev.map((it) =>
        it.kind === "approval" && ids.has(it.id)
          ? { ...it, resolved: status }
          : it
      )
    );

    try {
      await runTurn(
        batch.map((approvalItem) => ({
          type: "user.tool_approval" as const,
          threadId: approvalItem.threadId,
          toolCallId: approvalItem.toolCallId,
          approval:
            status === "allow"
              ? { status: "allow" as const }
              : {
                  status: "deny" as const,
                  reason: "Denied in FinGuard UI",
                },
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
    }
  };

  const firstPending = pendingApprovals[0];
  const stageBlocked = (id: JourneyStageId) =>
    kycExpired && (id === "advise" || id === "act");

  return (
    <div className="finguard-shell">
      <header className="finguard-topbar">
        <div className="topbar-brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M32 12c8.5 4.2 14 5.4 14 12.8v12.4c0 9.2-6.2 15.6-14 18.8-7.8-3.2-14-9.6-14-18.8V24.8C18 17.4 23.5 16.2 32 12z"
                stroke="currentColor"
                strokeWidth="3.2"
                strokeLinejoin="round"
              />
              <path
                d="M24.5 32.5l5.2 5.2 10.3-11"
                stroke="currentColor"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="topbar-wordmark">
            <strong>FinGuard</strong>
            <span>Advisor day · TrueForge</span>
          </div>
        </div>
        <div className="topbar-meta">
          <div className="client-chip" title="Bound session customer">
            Jane Smith
            <span className={`kyc${kycExpired ? " expired" : ""}`}>
              {kycExpired ? "KYC expired" : "KYC verified"}
            </span>
          </div>
          <span className="live-pill">Live desk</span>
          <div className="topbar-actions">
            <button
              type="button"
              className="finguard-link finguard-new-session"
              disabled={busy}
              onClick={() => void startNewSession()}
              title={sessionId ? `session ${sessionId}` : "connecting"}
            >
              New session
            </button>
            <a
              className="finguard-link"
              href="/demo-slides.html"
              target="_blank"
              rel="noreferrer"
            >
              Demo slides
            </a>
            <a
              className="finguard-link"
              href="http://localhost:8790"
              target="_blank"
              rel="noreferrer"
            >
              TrueForge UI
            </a>
          </div>
          <p className="finguard-session">
            {sessionId ? `${sessionId.slice(0, 12)}…` : "connecting…"}
          </p>
        </div>
      </header>

      <div className="finguard-body">
        <DeskDashboard
          journeyCue={journeyCue}
          currentStageLabel={
            JOURNEY_STAGES.find((s) => s.id === currentStage)?.label ?? "Brief"
          }
          onKycChange={setKycExpired}
        />
        <div className="finguard-main">
          <div className="journey-path" role="navigation" aria-label="Advisor day path">
            <div className="journey-path-label">
              <span>Advisor day</span>
              <span className="journey-path-cue">{journeyCue}</span>
            </div>
            <ol className="journey-steps">
              {JOURNEY_STAGES.map((stage, i) => {
                const isCurrent = currentStage === stage.id;
                const isDone = doneStages.has(stage.id) && !isCurrent;
                const blocked = stageBlocked(stage.id);
                const waiting =
                  hasPendingApprovals && lastStage === stage.id;
                return (
                  <li
                    key={stage.id}
                    className={[
                      "journey-step",
                      isCurrent ? "is-current" : "",
                      isDone ? "is-done" : "",
                      blocked ? "is-blocked" : "",
                      waiting ? "is-waiting" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {i > 0 && <span className="journey-connector" aria-hidden="true" />}
                    <div className="journey-step-head">
                      <span className="journey-num">{stage.num}</span>
                      <div className="journey-step-copy">
                        <strong>{stage.label}</strong>
                        <span>{stage.hint}</span>
                        {isCurrent && !waiting && (
                          <em className="journey-now">Now</em>
                        )}
                        {waiting && (
                          <em className="journey-now waiting">Awaiting allow</em>
                        )}
                      </div>
                    </div>
                    <div className="journey-actions">
                      {stage.actions.map((a) => (
                        <button
                          key={a.actionId}
                          type="button"
                          className="journey-action"
                          disabled={!sessionId || busy || hasPendingApprovals}
                          title={
                            hasPendingApprovals
                              ? "Resolve Allow/Deny first"
                              : blocked
                                ? "KYC expired — clear Compliance first (still runnable for demo)"
                                : JOURNEY_ACTIONS[a.actionId].text
                          }
                          onClick={() => runJourneyAction(a.actionId)}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          {hasPendingApprovals && (
            <p className="finguard-pending-hint">
              Approval gate — Allow to continue the journey, or New session to reset.
            </p>
          )}

          <main className="finguard-chat" ref={scroller}>
            {items.length === 0 && !busy && (
              <div className="finguard-empty">
                <ol className="empty-path" aria-hidden="true">
                  {JOURNEY_STAGES.map((s) => (
                    <li key={s.id}>
                      <span>{s.num}</span>
                      {s.label}
                    </li>
                  ))}
                </ol>
                <p>
                  Start Jane’s day: <strong>Brief</strong> → clear{" "}
                  <strong>KYC</strong> → <strong>Advise</strong> →{" "}
                  <strong>Act</strong>. Research is optional.
                </p>
              </div>
            )}
            {items.map((item) => {
              if (item.kind === "user") {
                return (
                  <div key={item.id} className="memo user">
                    {item.text}
                  </div>
                );
              }
              if (item.kind === "assistant") {
                return (
                  <div key={item.id} className="memo assistant">
                    {item.text}
                  </div>
                );
              }
              if (item.kind === "tool") {
                return (
                  <div key={item.id} className="timeline">
                    <strong>Tool · {item.name}</strong>
                    <pre>{item.args}</pre>
                  </div>
                );
              }
              if (item.kind === "approval") {
                const pendingCount = items.filter(
                  (it) => it.kind === "approval" && !it.resolved
                ).length;
                return (
                  <div key={item.id} className="memo approval">
                    <strong>Approval · {item.name}</strong>
                    <pre>{item.args}</pre>
                    <div className="approval-actions">
                      <button
                        type="button"
                        disabled={busy || !!item.resolved}
                        onClick={() => void resolveApproval(item, "allow")}
                      >
                        {pendingCount > 1
                          ? `Allow all (${pendingCount})`
                          : "Allow"}
                      </button>
                      <button
                        type="button"
                        className="deny"
                        disabled={busy || !!item.resolved}
                        onClick={() => void resolveApproval(item, "deny")}
                      >
                        {pendingCount > 1
                          ? `Deny all (${pendingCount})`
                          : "Deny"}
                      </button>
                      {item.resolved && (
                        <span className="resolved">Resolved: {item.resolved}</span>
                      )}
                    </div>
                  </div>
                );
              }
              return (
                <div key={item.id} className="memo status">
                  {item.text}
                </div>
              );
            })}
            {busy && <div className="memo status busy">Working…</div>}
            {error && <div className="memo error">{error}</div>}
          </main>

          {hasPendingApprovals && firstPending && (
            <div className="approval-bar" role="region" aria-label="Pending approvals">
              <div className="approval-bar-copy">
                <strong>Advisor approval · continue journey</strong>
                <span>{pendingApprovals.map((a) => a.name).join(" · ")}</span>
              </div>
              <div className="approval-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolveApproval(firstPending, "allow")}
                >
                  {pendingApprovals.length > 1
                    ? `Allow all (${pendingApprovals.length})`
                    : "Allow"}
                </button>
                <button
                  type="button"
                  className="deny"
                  disabled={busy}
                  onClick={() => void resolveApproval(firstPending, "deny")}
                >
                  {pendingApprovals.length > 1
                    ? `Deny all (${pendingApprovals.length})`
                    : "Deny"}
                </button>
              </div>
            </div>
          )}

          <form className="finguard-composer" onSubmit={onSubmit}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                hasPendingApprovals
                  ? "Allow/Deny to continue…"
                  : "Ask FinGuard…"
              }
              disabled={!sessionId || busy || hasPendingApprovals}
            />
            <button
              type="submit"
              disabled={
                !sessionId || busy || !input.trim() || hasPendingApprovals
              }
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
