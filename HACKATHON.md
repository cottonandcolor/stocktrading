# FinGuard — Agent Harness Hackathon

**Tagline:** From KYC verification to investment recommendation — every agent action is authorized, observable, evaluated, and governed.

Built for the TrueFoundry / HackerSquad **Agent Harness Hackathon** on [TrueForge](https://trueforge.dev/quickstart).

## What it demonstrates

| Challenge theme | FinGuard |
|---|---|
| Coordination | Supervisor + KYC / Advisor / Compliance tool roles |
| Runtime controls | KYC-aware policy engine gates tools by verification state |
| Approvals | Write tools (`propose_paper_action`, KYC simulators) pause in TrueForge |
| Visibility | JSONL audit trail via `get_audit_log` |
| Reliability | Same customer request → different outcomes when KYC flips |

## Prerequisites

- Node.js **22.14+** ([TrueForge quickstart](https://trueforge.dev/quickstart))
- An LLM API key (OpenAI or any provider TrueForge supports)

## 1. Start TrueForge (official quickstart)

```bash
npx @truefoundry/trueforge@latest
```

Open [http://localhost:8790](http://localhost:8790).

1. **Settings → Models** — configure a provider and API key  
2. Leave sandbox optional for this demo (skills need Daytona; FinGuard uses agent instructions + MCP instead)

## 2. Start FinGuard MCP

```bash
cd finguard
npm install
npm run start
```

MCP URL for TrueForge: **`http://127.0.0.1:8765/mcp`**  
Health: [http://127.0.0.1:8765/health](http://127.0.0.1:8765/health)

## 3. Connect the MCP in TrueForge

1. **Settings → Connectors → Add MCP Server**
2. Name: `finguard`
3. URL: `http://127.0.0.1:8765/mcp`
4. Auth: none
5. Save

## 4. Build the agent

1. Sidebar → **Build Agent**
2. Pick your model
3. Paste instructions from [`finguard/agent-instructions.md`](finguard/agent-instructions.md)
4. **Select MCP Tools** → enable `finguard` (all tools)
5. Confirm write/destructive tools show **approval required** (`propose_paper_action`, `simulate_*`)
6. Runtime: keep **Dynamic sub-agents** on
7. **Save Agent** as `finguard-kyc-advisor`

## 5. Three-minute demo script

### Scenario A — Verified

> Jane wants a retirement plan. Check KYC, analyze her portfolio, run compliance, then recommend.

Expect: `check_kyc_status` → VERIFIED → `analyze_portfolio` → `generate_recommendation` → audit entries.

### Scenario B — Incomplete income

> Call `simulate_incomplete_income`, then ask for a recommendation again.

Expect: **ACTION BLOCKED** — missing `income_verification`.

### Scenario C — KYC expired + approval

> Call `simulate_kyc_expiration`, retry recommendation (BLOCK).  
> Call `simulate_kyc_verified`, then `propose_paper_action` for a paper VTI buy — **Approve** in TrueForge UI.  
> Show `get_audit_log`.

## Policy engine (KYC → capability)

| KYC status | Portfolio analysis | Recommendation | Paper trade |
|---|---|---|---|
| NOT_STARTED / FAILED | Block | Block | Block |
| IN_PROGRESS / EXPIRED | Limited | Block | Block |
| VERIFIED | Allow | Allow | Approval required |
| MANUAL_REVIEW | Block (queue) | Block | Block |

## Tools

**Read:** `list_customers`, `check_kyc_status`, `check_customer_profile`, `analyze_portfolio`, `get_market_snapshot`, `generate_recommendation`, `run_compliance_check`, `get_audit_log`

**Write (TrueForge approval):** `propose_paper_action`, `simulate_kyc_expiration`, `simulate_kyc_verified`, `simulate_incomplete_income`

## Disclaimer

Synthetic customer data for a hackathon demo. Educational analysis only — not licensed financial, tax, or legal advice. No live brokerage connectivity.
