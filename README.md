# FinGuard — KYC-gated advisor on TrueForge

**TrueForge + FinGuard MCP (TypeScript) + SQLite + Yahoo Finance + React (Vite) SDK UI**

FinGuard is a KYC-aware financial advisor built on the [TrueForge](https://trueforge.dev/quickstart) **Agent Harness**. One supervisor agent (`finguard-kyc-advisor`) calls **FinGuard MCP** tools for KYC, desk ops, live markets, recommendations, client notify, and audit — with **human Allow/Deny** on write actions.

> Tagline: *From KYC verification to investment recommendation — every agent action is authorized, observable, and governed.*

| | |
|---|---|
| **Repo** | https://github.com/cottonandcolor/stocktrading |
| **PR** | [#1](https://github.com/cottonandcolor/stocktrading/pull/1) |
| **Hackathon notes** | [`HACKATHON.md`](HACKATHON.md) |
| **Demo slides** | [`finguard-ui/public/demo-slides.html`](finguard-ui/public/demo-slides.html) → `/demo-slides.html` when UI is running |

---

## How TrueForge (agent harness) and MCP work together

```
┌─────────────────────┐     sessions / turns / SSE      ┌──────────────────────┐
│  FinGuard UI :5173  │◄────────────────────────────────►│  TrueForge :8790      │
│  TrueForge SDK      │     Allow / Deny approvals       │  finguard-kyc-advisor │
└─────────┬───────────┘                                  └──────────┬───────────┘
          │ bind session → customer                     MCP connector│
          ▼                                                          ▼
┌─────────────────────┐     Streamable HTTP MCP          ┌──────────────────────┐
│  Desk REST proxy    │◄────────────────────────────────►│  FinGuard MCP :8765   │
│  /finguard/*        │                                  │  tools + policy       │
└─────────────────────┘                                  └──────────┬───────────┘
                                                                    │
                         ┌──────────────────────────────────────────┼──────────┐
                         ▼                                          ▼          ▼
                   SQLite SoR                              Yahoo Finance    Audit log
              (KYC, desk, notify,                      (quotes, history,   (JSONL / DB)
               session bindings)                            technicals)
```

| Layer | Role |
|--------|------|
| **TrueForge** | Agent harness: sessions, streaming turns, tool-call **approvals**, agent instructions, MCP connector wiring |
| **FinGuard MCP** | System of record + tools: KYC policy, advisor desk, notifications, Slack queue, Yahoo live data, audit |
| **FinGuard UI** | Advisor **day path** (Brief → Compliance → Research → Advise → Act), live desk, sticky Allow/Deny |

**Rule of thumb:** TrueForge **orchestrates**; FinGuard MCP **executes** and holds ground truth. The agent must not invent KYC status or prices — it calls tools.

---

## Architecture pieces

| Path | What it is |
|------|------------|
| [`finguard/`](finguard/) | MCP server (`npm run start` → `http://127.0.0.1:8765/mcp`) |
| [`finguard/agent-instructions.md`](finguard/agent-instructions.md) | Supervisor prompt pasted into TrueForge |
| [`finguard/src/server.ts`](finguard/src/server.ts) | MCP tool registration + Express (`/dashboard`, `/market/*`, `/sessions/bind`) |
| [`finguard/src/policy.ts`](finguard/src/policy.ts) | KYC → capability matrix (ALLOW / LIMIT / BLOCK) |
| [`finguard/src/db.ts`](finguard/src/db.ts) | SQLite SoR + TrueForge `session_id → customer_id` bindings |
| [`finguard/src/market.ts`](finguard/src/market.ts) / [`technical.ts`](finguard/src/technical.ts) | Yahoo quotes + SMA/RSI/MACD/Bollinger |
| [`finguard-ui/`](finguard-ui/) | React + `@truefoundry/trueforge-sdk` branded workspace |

---

## Agent coordination (roles)

TrueForge runs **one** agent. “Sub-agents” are **roles** stamped on MCP tool calls and the audit log. The supervisor sequences them:

| Role | Responsibility | Example MCP tools |
|------|----------------|-------------------|
| **KycAgent** | Identity & suitability gate | `check_kyc_status`, `simulate_kyc_expiration`, `simulate_kyc_verified` |
| **DeskAgent** | News, tasks, appointments, Slack queue | `get_advisor_dashboard`, `create_advisor_task`, `schedule_appointment`, `queue_slack_update` |
| **MarketData** | Live Yahoo Finance | `yahoo_quote`, `yahoo_quotes`, `yahoo_history`, `yahoo_technical_analysis`, `get_market_snapshot` |
| **AdvisorAgent** | Portfolio analysis & recommendations | `analyze_portfolio`, `generate_recommendation` |
| **ComplianceAgent** | Policy + paper actions | `run_compliance_check`, `propose_paper_action` |
| **NotificationAgent** | Client email + KYC renewal form | `notify_kyc_expired`, `list_client_notifications` |

**Hard rules (enforced in tools + instructions):**

- Always `check_kyc_status` before `generate_recommendation` or `propose_paper_action`
- Expired / incomplete KYC → **ACTION BLOCKED** (no invented verification)
- Write tools pause in TrueForge for **human Allow/Deny**
- Cite Yahoo `as_of` timestamps; never invent prices
- Paper / educational only — no live brokerage

### KYC → capability

| KYC status | Portfolio analysis | Recommendation | Paper trade |
|---|---|---|---|
| NOT_STARTED / FAILED | Block | Block | Block |
| IN_PROGRESS / EXPIRED | Limited | Block | Block |
| VERIFIED | Allow | Allow | Approval required |
| MANUAL_REVIEW | Block | Block | Block |

---

## MCP tool catalog

**KYC:** `list_customers`, `check_kyc_status`, `check_customer_profile`, `simulate_kyc_expiration`, `simulate_kyc_verified`, `simulate_incomplete_income`  

**Advice:** `analyze_portfolio`, `get_market_snapshot`, `generate_recommendation`, `propose_paper_action`  

**Compliance:** `run_compliance_check`  

**Desk:** `get_advisor_dashboard`, `list_market_news`, `create_advisor_task`, `schedule_appointment`, `queue_slack_update`, `list_slack_queue`  

**Notify:** `notify_kyc_expired`, `list_client_notifications`  

**Data / integration:** `get_data_backend`, `bind_trueforge_session`, `get_trueforge_session_binding`, `list_trueforge_session_bindings`, `get_audit_log`  

**Yahoo live:** `yahoo_quote`, `yahoo_quotes`, `yahoo_history`, `yahoo_technical_analysis`

---

## Advisor day path (UI narrative)

The branded UI walks a 2-minute advisor journey:

1. **Brief** — Open Jane’s book (`get_advisor_dashboard`, `check_kyc_status`)
2. **Compliance** — Expire KYC → block advice → email form + Slack + high-priority task
3. **Research** — Live quotes / technicals (Yahoo MCP)
4. **Advise** — Portfolio plan + Slack summary (**Allow** gated tools)
5. **Act** — Restore KYC → paper VTI → Zoom appointment (**Allow**)

Demo customer: `cust_jane_001` (Jane Smith).

**What’s live vs demo side-effect**

| Live / persistent | Demo side effects |
|-------------------|-------------------|
| Yahoo quotes & technical analysis | Email: queued / `approved_sent_demo` (no live SMTP) |
| FinGuard SQLite (KYC, desk, audit, bindings) | Slack: `queued_for_slack_mcp` until Slack MCP is attached |
| TrueForge sessions & approvals | Paper trade: simulated fill, no broker |
| Real MCP tool invocations | Market news: curated demo wire |

---

## Quick start

**Prerequisites:** Node.js **22.14+**, an LLM API key for TrueForge.

### 1. TrueForge harness

```bash
npx @truefoundry/trueforge@latest
```

Open [http://localhost:8790](http://localhost:8790) → **Settings → Models** (API key) → **Connectors → Add MCP Server**:

| Field | Value |
|--------|--------|
| Name | `finguard` |
| URL | `http://127.0.0.1:8765/mcp` |
| Auth | none |

Agent `finguard-kyc-advisor`: attach the `finguard` MCP; paste [`finguard/agent-instructions.md`](finguard/agent-instructions.md); keep write tools approval-gated.

### 2. FinGuard MCP

```bash
cd finguard
npm install
npm run start
```

- MCP: `http://127.0.0.1:8765/mcp`
- Health: http://127.0.0.1:8765/health  
- Dashboard: http://127.0.0.1:8765/dashboard  
- Data backend: http://127.0.0.1:8765/data-backend  
- Markets: `GET /market/quote/AAPL`, `/market/snapshot`, `/market/technical/SPY`

SQLite file: `finguard/data/finguard.sqlite` (gitignored). UI binds each new TrueForge session to Jane via `POST /sessions/bind`.

### 3. FinGuard UI

```bash
cd finguard-ui
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` → TrueForge `:8790` and `/finguard` → MCP `:8765`.

Demo slides: [http://127.0.0.1:5173/demo-slides.html](http://127.0.0.1:5173/demo-slides.html) (←/→ to navigate).

### Optional: Slack MCP

In TrueForge **Settings → Connectors**, add Slack MCP and attach it to `finguard-kyc-advisor` alongside `finguard`. Without OAuth, drafts still show on the desk **Slack queue**.

---

## Data ownership

| Store | Owns |
|--------|------|
| **TrueForge** (local SQLite/Postgres) | Sessions, turns, streaming events, approvals |
| **FinGuard SQLite** | Customers / KYC, desk (news, tasks, appointments), notifications, Slack drafts, audit, `session_id → customer_id` |
| **Yahoo Finance** | Live quotes, history, technical indicators |

---

## Pre-existing research tools (same repo)

This repository also contains earlier local paper-trading / backtest utilities (not the hackathon harness layer):

- `beat_spy.py` — systematic strategies vs SPY  
- `paper_platform.py` — Streamlit paper desk  
- `day_trader.py` — approval-based local day-trade sim  
- `options_friday.py` — weekly options views  

See script docstrings / prior README sections in git history for details. **FinGuard is the Agent Harness submission.**

---

## Disclaimer

Synthetic customer data for a hackathon / educational demo. Not licensed financial, tax, or legal advice. No live brokerage connectivity. Past or simulated performance does not predict future results.
