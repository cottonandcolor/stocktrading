# Finguard Financial Advisor Agent

**Tagline:** From KYC verification to investment recommendation — every agent action is authorized, observable, evaluated, and governed.

Built for the TrueFoundry × HackerSquad **Agent Harness Hackathon** (Santa Clara, Sep 19, 2026) on [TrueForge](https://trueforge.dev/quickstart).

Official welcome / logistics: [hackathon welcome deck](https://truefoundry-hackathon-welcome-sep19-2026.itsajchan.chatgpt.site/?utm_source=luma)

## Submission checklist (HackerSquad)

**Deadline: 4:00 PM PDT today.** Save early — video processing takes time.

1. Open the event in [HackerSquad](https://hackersquad.io) → builder workspace (Luma RSVP alone is not enough).
2. **Team tab** — Create Team / Invite / Accept (if teammates).
3. **Save** the project draft (title, description, GitHub link).
4. **Record demo** inside the saved project (screen share; keep API keys off screen).
5. Wait until the video is ready and playback works.
6. Press **Submit** and confirm status shows **Submitted** with a timestamp.  
   *Saved ≠ Submitted.* Only Submitted is in the judging queue.

### Suggested HackerSquad project copy

- **Name:** Finguard Financial Advisor Agent  
- **Repo:** https://github.com/cottonandcolor/stocktrading  
- **One-liner:** KYC gates every advisor tool call; incomplete/expired KYC blocks recommendations; paper actions pause for human approval; full audit trail.  
- **Built today:** TrueForge agent + Finguard MCP (policy engine) + branded UI on TrueForge session API + demo scenarios.  
- **Pre-existing (disclose):** local paper-trading / advisor research code in this repo; Finguard harness layer is the hackathon build.

### Demo script to record (~3 min)

1. FinGuard UI (`localhost:5173`) — Verified recommendation for Jane.  
2. Expire KYC → same ask → **ACTION BLOCKED**.  
3. Restore KYC → paper trade → **Allow** approval.  
4. Show audit log / tool calls. Optionally flash stock TrueForge UI at `:8790`.

## What it demonstrates

| Challenge theme | FinGuard |
|---|---|
| Observe | Tool calls in UI + JSONL audit (`get_audit_log`) |
| Control | KYC policy engine + TrueForge approval on write tools |
| Test | Same request → different outcomes (verified / incomplete / expired) |
| Coordination | Supervisor agent + KYC / Advisor / Compliance tools |
| Runtime | MCP allowlist; paper-only execution |

## Prerequisites

- Node.js **22.14+** ([TrueForge quickstart](https://trueforge.dev/quickstart))
- An LLM API key (OpenAI or any provider TrueForge supports)

## 1. Start TrueForge (official quickstart)

```bash
npx @truefoundry/trueforge@latest
```

Open [http://localhost:8790](http://localhost:8790) for the stock TrueForge UI, **or** use the branded FinGuard shell below.

1. **Settings → Models** — configure a provider and API key  
2. Leave sandbox optional for this demo (skills need Daytona; FinGuard uses agent instructions + MCP instead)

## 1b. FinGuard branded UI (TrueForge session API)

```bash
cd finguard-ui
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Custom FinGuard chat on `@truefoundry/trueforge-sdk` (Vite proxies `/api` → `:8790`). Locks to `finguard-kyc-advisor`, shows tool calls, Allow/Deny for gated writes.

Stock UI remains at [http://localhost:8790](http://localhost:8790).

## Slack MCP (TrueForge connector)

In TrueForge **Settings → Connectors**:

1. Add MCP server (catalog Slack if present, or remote URL `https://mcp.slack.com/mcp`)
2. Complete OAuth for your Slack workspace
3. Attach the Slack connector to `finguard-kyc-advisor` alongside `finguard`
4. After `queue_slack_update` is approved, the agent should post via Slack MCP tools

Without Slack OAuth, drafts still appear on the **Advisor desk → Slack queue** panel for the demo.

## 2. Start FinGuard MCP

```bash
cd finguard
npm install
npm run start
```

MCP URL: **`http://127.0.0.1:8765/mcp`**  
Health: [http://127.0.0.1:8765/health](http://127.0.0.1:8765/health)

## 3. Connect the MCP in TrueForge

1. **Settings → Connectors → Add MCP Server**
2. Name: `finguard`
3. URL: `http://127.0.0.1:8765/mcp`
4. Auth: none
5. Save

## 4. Build / use the agent

Agent `finguard-kyc-advisor` should already be registered if you followed setup earlier. Otherwise:

1. **Build Agent** → model + paste [`finguard/agent-instructions.md`](finguard/agent-instructions.md)
2. Attach `finguard` MCP tools; keep write tools approval-gated
3. Dynamic sub-agents on → Save as `finguard-kyc-advisor`

## Demo scenarios

### A — Verified
Check KYC → analyze portfolio → recommend. Expect ALLOW.

### B — Incomplete / expired
`simulate_incomplete_income` or `simulate_kyc_expiration` → recommend → **ACTION BLOCKED**.

### C — Approval
`simulate_kyc_verified` → `propose_paper_action` → Allow/Deny → `get_audit_log`.

## Policy engine (KYC → capability)

| KYC status | Portfolio analysis | Recommendation | Paper trade |
|---|---|---|---|
| NOT_STARTED / FAILED | Block | Block | Block |
| IN_PROGRESS / EXPIRED | Limited | Block | Block |
| VERIFIED | Allow | Allow | Approval required |
| MANUAL_REVIEW | Block (queue) | Block | Block |

## Disclaimer

Synthetic customer data for a hackathon demo. Educational analysis only — not licensed financial, tax, or legal advice. No live brokerage connectivity.
