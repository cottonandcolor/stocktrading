import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import * as z from "zod/v4";
import { audit, auditPath, readAudit } from "./audit.js";
import {
  bindTrueForgeSession,
  dataBackendInfo,
  getTrueForgeSessionBinding,
  listTrueForgeSessionBindings,
} from "./db.js";
import {
  completeKycRemediationTasks,
  completeTask,
  createTask,
  dashboardSnapshot,
  draftSlackMessage,
  getNotificationByToken,
  listAppointments,
  listClientNotifications,
  listNews,
  listSlackDrafts,
  listTasks,
  markNotificationSent,
  queueKycExpiredNotification,
  scheduleAppointment,
} from "./desk.js";
import { evaluatePolicy, formatBlockBanner } from "./policy.js";
import {
  fetchHistory,
  fetchQuote,
  fetchQuotes,
  liveMarketSnapshot,
} from "./market.js";
import { technicalAnalysis } from "./technical.js";
import {
  defaultCustomerId,
  effectiveKycStatus,
  getCustomer,
  listCustomers,
  missingKycFields,
  setKycStatus,
  updateCustomer,
} from "./store.js";

const PORT = Number(process.env.FINGUARD_PORT || 8765);

function text(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function blocked(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function resolveCustomerId(customer_id?: string, session_id?: string) {
  if (customer_id) return customer_id;
  if (session_id) {
    const binding = getTrueForgeSessionBinding(session_id);
    if (binding) return binding.customer_id;
  }
  return defaultCustomerId();
}

function buildServer() {
  const server = new McpServer({ name: "finguard", version: "0.1.0" });

  server.registerTool(
    "get_data_backend",
    {
      description:
        "Describe how FinGuard data integrates with TrueForge: SQLite system of record vs TrueForge session storage.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(dataBackendInfo())
  );

  server.registerTool(
    "bind_trueforge_session",
    {
      description:
        "Bind a TrueForge session_id to a FinGuard customer_id so later tools can resolve the customer from the session.",
      inputSchema: {
        session_id: z.string(),
        customer_id: z.string().optional(),
        title: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, customer_id, title }) => {
      const id = customer_id || defaultCustomerId();
      if (!getCustomer(id)) return blocked({ error: `Unknown customer ${id}` });
      const binding = bindTrueForgeSession({
        session_id,
        customer_id: id,
        title,
      });
      audit({
        agent: "KycAgent",
        action: "bind_trueforge_session",
        customer_id: id,
        decision: "ALLOW",
        detail: binding,
      });
      return text({ binding, backend: dataBackendInfo() });
    }
  );

  server.registerTool(
    "get_trueforge_session_binding",
    {
      description:
        "Look up which FinGuard customer is bound to a TrueForge session_id.",
      inputSchema: { session_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session_id }) => {
      const binding = getTrueForgeSessionBinding(session_id);
      return text({
        binding,
        message: binding
          ? `Session bound to ${binding.customer_id}`
          : "No binding — call bind_trueforge_session or default to Jane.",
      });
    }
  );

  server.registerTool(
    "list_trueforge_session_bindings",
    {
      description: "List recent TrueForge session → FinGuard customer bindings.",
      inputSchema: {
        limit: z.number().int().positive().max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      text({ bindings: listTrueForgeSessionBindings(limit || 20) })
  );

  server.registerTool(
    "list_customers",
    {
      description: "List synthetic demo customers and effective KYC status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const customers = listCustomers();
      audit({
        agent: "KycAgent",
        action: "list_customers",
        decision: "INFO",
        detail: { count: customers.length },
      });
      return text({ customers });
    }
  );

  server.registerTool(
    "check_kyc_status",
    {
      description:
        "KYC entry point. Returns verification checklist, expiration, missing fields, and allowed capabilities.",
      inputSchema: {
        customer_id: z
          .string()
          .optional()
          .describe("Defaults to Jane Smith demo customer"),
        session_id: z
          .string()
          .optional()
          .describe("TrueForge session id — uses bound customer if set"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customer_id, session_id }) => {
      const id = resolveCustomerId(customer_id, session_id);
      const customer = getCustomer(id);
      if (!customer) return blocked({ error: `Unknown customer ${id}` });
      const status = effectiveKycStatus(customer);
      const missing = missingKycFields(customer);
      const policy = evaluatePolicy(customer, "basic_info");
      const checklist = {
        identity_verified: customer.identity.verified,
        age_verified: Boolean(customer.dob && customer.age),
        residency_verified: customer.residency.verified,
        address_verified: customer.address.verified,
        risk_profile: customer.risk_questionnaire.completed,
        investment_objective: Boolean(customer.investment_objective),
        income_verified: customer.income.verified,
        net_worth_verified: customer.net_worth.verified,
        kyc_expiration_ok: status === "VERIFIED",
      };
      audit({
        agent: "KycAgent",
        action: "check_kyc_status",
        customer_id: id,
        decision: "INFO",
        detail: { status, missing },
      });
      return text({
        customer_id: id,
        name: customer.name,
        kyc_status: status,
        kyc_expires_at: customer.kyc_expires_at,
        checklist,
        missing,
        capabilities: policy.capabilities,
      });
    }
  );

  server.registerTool(
    "check_customer_profile",
    {
      description: "Return the structured KYC / suitability profile (synthetic demo data).",
      inputSchema: {
        customer_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customer_id }) => {
      const id = resolveCustomerId(customer_id);
      const customer = getCustomer(id);
      if (!customer) return blocked({ error: `Unknown customer ${id}` });
      audit({
        agent: "KycAgent",
        action: "check_customer_profile",
        customer_id: id,
        decision: "INFO",
        reason: "suitability assessment",
      });
      return text({
        ...customer,
        effective_kyc_status: effectiveKycStatus(customer),
        missing: missingKycFields(customer),
      });
    }
  );

  server.registerTool(
    "analyze_portfolio",
    {
      description:
        "Analyze the customer's paper/demo portfolio. Policy may ALLOW, LIMIT, or BLOCK based on KYC.",
      inputSchema: {
        customer_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customer_id }) => {
      const id = resolveCustomerId(customer_id);
      const customer = getCustomer(id);
      if (!customer) return blocked({ error: `Unknown customer ${id}` });
      const decision = evaluatePolicy(customer, "portfolio_analysis");
      if (decision.decision === "BLOCK") {
        audit({
          agent: "AdvisorAgent",
          action: "analyze_portfolio",
          customer_id: id,
          decision: "BLOCK",
          reason: decision.reasons.join(" "),
        });
        return blocked({
          banner: formatBlockBanner(decision),
          policy: decision,
        });
      }
      const p = customer.portfolio;
      const cash_pct = (p.cash / p.total) * 100;
      const summary = {
        as_of: p.as_of,
        total: p.total,
        cash: p.cash,
        cash_pct: Number(cash_pct.toFixed(1)),
        holdings_count: p.holdings.length,
        notes: p.notes,
        mode: decision.decision === "LIMITED" ? "limited" : "full",
        holdings:
          decision.decision === "LIMITED"
            ? p.holdings.map((h) => ({ symbol: h.symbol, value: h.value }))
            : p.holdings,
      };
      audit({
        agent: "AdvisorAgent",
        action: "analyze_portfolio",
        customer_id: id,
        decision: decision.decision === "LIMITED" ? "ALLOW" : "ALLOW",
        reason: decision.reasons.join(" "),
        detail: { mode: summary.mode },
      });
      return text({ policy: decision, analysis: summary });
    }
  );

  server.registerTool(
    "get_market_snapshot",
    {
      description:
        "Live market snapshot from Yahoo Finance (default: SPY, QQQ, IWM, TLT, GLD, BIL). Labels as-of timestamps.",
      inputSchema: {
        symbols: z
          .array(z.string())
          .optional()
          .describe("Optional ticker list; defaults to major ETFs"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbols }) => {
      const snapshot = await liveMarketSnapshot(symbols);
      audit({
        agent: "AdvisorAgent",
        action: "get_market_snapshot",
        decision: "ALLOW",
        detail: { source: "yahoo_finance", count: snapshot.quotes.length },
      });
      return text(snapshot);
    }
  );

  server.registerTool(
    "yahoo_quote",
    {
      description:
        "Get a live Yahoo Finance quote for one symbol (price, change, volume, 52w range).",
      inputSchema: {
        symbol: z.string().describe("Ticker e.g. AAPL, SPY, VTI"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const quote = await fetchQuote(symbol);
        audit({
          agent: "AdvisorAgent",
          action: "yahoo_quote",
          decision: "ALLOW",
          detail: { symbol: quote.symbol, price: quote.price },
        });
        return text({ quote });
      } catch (e) {
        return blocked({
          error: e instanceof Error ? e.message : "yahoo_quote failed",
          symbol,
        });
      }
    }
  );

  server.registerTool(
    "yahoo_quotes",
    {
      description: "Batch live Yahoo Finance quotes (max 20 symbols).",
      inputSchema: {
        symbols: z.array(z.string()).min(1).max(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbols }) => {
      const quotes = await fetchQuotes(symbols);
      audit({
        agent: "AdvisorAgent",
        action: "yahoo_quotes",
        decision: "ALLOW",
        detail: { count: quotes.length },
      });
      return text({ quotes, as_of: new Date().toISOString() });
    }
  );

  server.registerTool(
    "yahoo_history",
    {
      description:
        "Daily Yahoo Finance history for a symbol (default last 30 calendar days).",
      inputSchema: {
        symbol: z.string(),
        days: z.number().int().positive().max(365).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, days }) => {
      try {
        const history = await fetchHistory(symbol, days || 30);
        audit({
          agent: "AdvisorAgent",
          action: "yahoo_history",
          decision: "ALLOW",
          detail: { symbol: history.symbol, bars: history.bars.length },
        });
        return text(history);
      } catch (e) {
        return blocked({
          error: e instanceof Error ? e.message : "yahoo_history failed",
          symbol,
        });
      }
    }
  );

  server.registerTool(
    "yahoo_technical_analysis",
    {
      description:
        "Technical analysis from Yahoo Finance daily OHLC: SMA 20/50/200, EMA 12/26, RSI(14), MACD, Bollinger(20,2), ATR(14), trend + signal summary. Educational only.",
      inputSchema: {
        symbol: z.string().describe("Ticker e.g. AAPL, SPY, VTI"),
        lookback_days: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Calendar days of history to pull (default 260 for SMA200)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, lookback_days }) => {
      try {
        const analysis = await technicalAnalysis(symbol, lookback_days || 260);
        audit({
          agent: "AdvisorAgent",
          action: "yahoo_technical_analysis",
          decision: "ALLOW",
          detail: {
            symbol: analysis.symbol,
            trend: analysis.trend,
            rsi: analysis.indicators.rsi_14,
          },
        });
        return text(analysis);
      } catch (e) {
        return blocked({
          error:
            e instanceof Error ? e.message : "yahoo_technical_analysis failed",
          symbol,
        });
      }
    }
  );

  server.registerTool(
    "generate_recommendation",
    {
      description:
        "Generate an educational allocation / deployment recommendation. BLOCKED unless KYC is VERIFIED and suitability complete.",
      inputSchema: {
        customer_id: z.string().optional(),
        request: z
          .string()
          .describe("Customer ask, e.g. invest 100000 for retirement"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customer_id, request }) => {
      const id = resolveCustomerId(customer_id);
      const customer = getCustomer(id);
      if (!customer) return blocked({ error: `Unknown customer ${id}` });
      const decision = evaluatePolicy(customer, "recommendation");
      if (decision.decision === "BLOCK") {
        audit({
          agent: "AdvisorAgent",
          action: "generate_recommendation",
          customer_id: id,
          decision: "BLOCK",
          reason: decision.reasons.join(" "),
          detail: { request },
        });
        return blocked({
          banner: formatBlockBanner(decision),
          policy: decision,
          next_action: "Request missing KYC information or re-verify, then retry.",
        });
      }

      const cash = customer.portfolio.cash;
      const recommendation = {
        request,
        executive_summary: [
          `${customer.name} is KYC ${decision.kyc_status} with objective ${customer.investment_objective}.`,
          `Portfolio is ~${((cash / customer.portfolio.total) * 100).toFixed(0)}% cash ($${cash.toLocaleString()}).`,
          "Propose gradual deployment into a diversified target allocation; avoid leveraged single-theme ETFs as core holdings.",
          "Tax-loss harvest underwater single names where wash-sale rules allow.",
          "Educational output only — not a substitute for a licensed CFP/CPA.",
        ],
        target_allocation_moderate: [
          { sleeve: "US total market", pct: 50 },
          { sleeve: "International", pct: 20 },
          { sleeve: "Bonds / Treasuries", pct: 15 },
          { sleeve: "Cash / emergency", pct: 10 },
          { sleeve: "Satellite (capped)", pct: 5 },
        ],
        deployment_plan: {
          keep_liquid_months: customer.emergency_fund_months,
          immediate_invest_usd: Math.min(25000, Math.round(cash * 0.15)),
          monthly_dca_usd: 10000,
          months: 12,
          rationale:
            "Balances cash-yield opportunity cost vs behavioral risk of lump-sum regret.",
        },
        avoid: customer.restricted_products,
      };

      audit({
        agent: "AdvisorAgent",
        action: "generate_recommendation",
        customer_id: id,
        decision: "ALLOW",
        reason: "KYC verified; suitability complete",
        detail: { request },
      });
      return text({ policy: decision, recommendation });
    }
  );

  server.registerTool(
    "run_compliance_check",
    {
      description:
        "Compliance agent: suitability, restricted products, and whether a proposed product/action may proceed.",
      inputSchema: {
        customer_id: z.string().optional(),
        proposed_product: z
          .string()
          .describe("e.g. VTI, JEPI, BITX, SSO leveraged ETF"),
        proposed_action: z
          .enum(["recommend", "paper_trade", "real_trade"])
          .default("recommend"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customer_id, proposed_product, proposed_action }) => {
      const id = resolveCustomerId(customer_id);
      const customer = getCustomer(id);
      if (!customer) return blocked({ error: `Unknown customer ${id}` });
      const kyc = effectiveKycStatus(customer);
      const missing = missingKycFields(customer);
      const product = proposed_product.toUpperCase();
      const restrictedHit = customer.restricted_products.find((r) =>
        product.includes("BITX") || product.includes("SSO") || product.includes("TQQQ")
          ? r.includes("leveraged")
          : false
      );
      const issues: string[] = [];
      if (kyc !== "VERIFIED") issues.push(`KYC is ${kyc}`);
      if (missing.length) issues.push(`Missing suitability: ${missing.join(", ")}`);
      if (restrictedHit) {
        issues.push(`Product conflicts with restriction: ${restrictedHit}`);
      }
      if (proposed_action === "real_trade") {
        issues.push("Real brokerage trading is out of scope for this paper demo.");
      }
      const outcome =
        issues.length === 0
          ? proposed_action === "paper_trade"
            ? "APPROVAL_REQUIRED"
            : "PASS"
          : "BLOCK";

      audit({
        agent: "ComplianceAgent",
        action: "run_compliance_check",
        customer_id: id,
        decision: outcome === "BLOCK" ? "BLOCK" : outcome === "APPROVAL_REQUIRED" ? "APPROVAL_REQUIRED" : "ALLOW",
        reason: issues.join("; ") || "PASS",
        detail: { proposed_product, proposed_action },
      });
      return text({
        outcome,
        kyc_status: kyc,
        issues,
        proposed_product,
        proposed_action,
      });
    }
  );

  server.registerTool(
    "propose_paper_action",
    {
      description:
        "Propose a paper (simulated) portfolio action. Marked write/destructive so TrueForge pauses for human approval. Still blocked by KYC policy if not verified.",
      inputSchema: {
        customer_id: z.string().optional(),
        action: z.string().describe("e.g. Buy 50 VTI at market (paper)"),
        symbol: z.string(),
        side: z.enum(["buy", "sell"]),
        notional_usd: z.number().positive(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ customer_id, action, symbol, side, notional_usd }) => {
      const id = resolveCustomerId(customer_id);
      const customer = getCustomer(id);
      if (!customer) return blocked({ error: `Unknown customer ${id}` });
      const decision = evaluatePolicy(customer, "trade_execution");
      if (decision.decision === "BLOCK") {
        audit({
          agent: "ComplianceAgent",
          action: "propose_paper_action",
          customer_id: id,
          decision: "BLOCK",
          reason: decision.reasons.join(" "),
        });
        return blocked({ banner: formatBlockBanner(decision), policy: decision });
      }
      const ticket = {
        ticket_id: `paper_${randomUUID().slice(0, 8)}`,
        status: "ACCEPTED_PAPER_ONLY",
        customer_id: id,
        action,
        symbol: symbol.toUpperCase(),
        side,
        notional_usd,
        note: "Simulated fill recorded for demo — no live broker.",
      };
      audit({
        agent: "AdvisorAgent",
        action: "propose_paper_action",
        customer_id: id,
        decision: "APPROVAL_REQUIRED",
        reason: "Human approved write tool; paper ticket accepted",
        detail: ticket,
      });
      return text({ policy: decision, ticket });
    }
  );

  server.registerTool(
    "simulate_kyc_expiration",
    {
      description: "Demo control: mark customer KYC as EXPIRED so the next recommendation is blocked.",
      inputSchema: {
        customer_id: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ customer_id }) => {
      const id = resolveCustomerId(customer_id);
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      const customer = setKycStatus(id, "EXPIRED", yesterday);
      audit({
        agent: "KycAgent",
        action: "simulate_kyc_expiration",
        customer_id: id,
        decision: "INFO",
        reason: "Demo toggle: KYC expired",
      });
      return text({
        customer_id: id,
        kyc_status: effectiveKycStatus(customer),
        kyc_expires_at: customer.kyc_expires_at,
        message: "KYC expired. Recommendations and trades should now BLOCK.",
        next_step:
          "Call notify_kyc_expired (NotificationAgent) to email the client a KYC renewal form, then queue_slack_update for the desk.",
      });
    }
  );

  server.registerTool(
    "simulate_kyc_verified",
    {
      description: "Demo control: restore customer to VERIFIED KYC with a future expiration.",
      inputSchema: {
        customer_id: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ customer_id }) => {
      const id = resolveCustomerId(customer_id);
      const customer = updateCustomer(id, {
        kyc_status: "VERIFIED",
        kyc_expires_at: "2027-04-15T00:00:00-07:00",
        income: { ...(getCustomer(id)!.income), verified: true },
        risk_questionnaire: {
          ...(getCustomer(id)!.risk_questionnaire),
          completed: true,
          score: getCustomer(id)!.risk_questionnaire.score || "moderate",
        },
        investment_objective:
          getCustomer(id)!.investment_objective || "retirement_growth",
      });
      const closed = completeKycRemediationTasks(id);
      audit({
        agent: "KycAgent",
        action: "simulate_kyc_verified",
        customer_id: id,
        decision: "INFO",
        reason: "Demo toggle: KYC verified",
        detail: { remediation_tasks_closed: closed },
      });
      return text({
        customer_id: id,
        kyc_status: effectiveKycStatus(customer),
        kyc_expires_at: customer.kyc_expires_at,
        missing: missingKycFields(customer),
        remediation_tasks_closed: closed,
        message: "KYC restored to VERIFIED.",
      });
    }
  );

  server.registerTool(
    "simulate_incomplete_income",
    {
      description:
        "Demo control: clear income verification so suitability is incomplete while other KYC fields stay verified.",
      inputSchema: {
        customer_id: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ customer_id }) => {
      const id = resolveCustomerId(customer_id);
      const current = getCustomer(id);
      if (!current) return blocked({ error: `Unknown customer ${id}` });
      const customer = updateCustomer(id, {
        kyc_status: "IN_PROGRESS",
        income: { ...current.income, verified: false },
      });
      audit({
        agent: "KycAgent",
        action: "simulate_incomplete_income",
        customer_id: id,
        decision: "INFO",
        reason: "Demo: income verification cleared",
      });
      return text({
        customer_id: id,
        kyc_status: effectiveKycStatus(customer),
        missing: missingKycFields(customer),
        message: "Income verification missing — recommendations should BLOCK.",
      });
    }
  );

  server.registerTool(
    "get_audit_log",
    {
      description: "Return recent FinGuard audit events (observability for the demo).",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const events = readAudit(limit || 40);
      return text({ path: auditPath(), events });
    }
  );

  server.registerTool(
    "get_advisor_dashboard",
    {
      description:
        "Financial advisor desk snapshot: market news, open tasks, upcoming appointments, and Slack message queue.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const snapshot = dashboardSnapshot();
      audit({
        agent: "AdvisorAgent",
        action: "get_advisor_dashboard",
        decision: "INFO",
      });
      return text(snapshot);
    }
  );

  server.registerTool(
    "list_market_news",
    {
      description: "List curated (demo) market news relevant to client portfolios.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text({ news: listNews() })
  );

  server.registerTool(
    "list_advisor_tasks",
    {
      description: "List advisor follow-up tasks (open or all).",
      inputSchema: {
        status: z.enum(["open", "done"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status }) => text({ tasks: listTasks(status) })
  );

  server.registerTool(
    "create_advisor_task",
    {
      description: "Create an advisor follow-up task on the desk.",
      inputSchema: {
        title: z.string(),
        due: z.string().describe("ISO timestamp"),
        priority: z.enum(["high", "medium", "low"]).optional(),
        related_customer_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const task = createTask(input);
      audit({
        agent: "AdvisorAgent",
        action: "create_advisor_task",
        decision: "ALLOW",
        detail: { task_id: task.id },
      });
      return text({ task });
    }
  );

  server.registerTool(
    "complete_advisor_task",
    {
      description: "Mark an advisor task done.",
      inputSchema: { task_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id }) => {
      const task = completeTask(task_id);
      if (!task) return blocked({ error: `Unknown task ${task_id}` });
      audit({
        agent: "AdvisorAgent",
        action: "complete_advisor_task",
        decision: "ALLOW",
        detail: { task_id },
      });
      return text({ task });
    }
  );

  server.registerTool(
    "list_appointments",
    {
      description: "List upcoming client/compliance appointments.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text({ appointments: listAppointments() })
  );

  server.registerTool(
    "schedule_appointment",
    {
      description: "Schedule a client or internal appointment on the advisor calendar.",
      inputSchema: {
        title: z.string(),
        with_whom: z.string(),
        start: z.string(),
        end: z.string(),
        channel: z.enum(["zoom", "phone", "in_person", "slack"]).optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const appointment = scheduleAppointment(input);
      audit({
        agent: "AdvisorAgent",
        action: "schedule_appointment",
        decision: "ALLOW",
        detail: { appointment_id: appointment.id },
      });
      return text({ appointment });
    }
  );

  server.registerTool(
    "queue_slack_update",
    {
      description:
        "Queue a Slack message for the advisory team (e.g. KYC block alert or recommendation summary). After approval, use the Slack MCP connector to actually post it.",
      inputSchema: {
        channel: z
          .string()
          .describe("Slack channel name or ID, e.g. #finguard-alerts"),
        text: z.string(),
        related: z.string().optional().describe("customer id or ticket id"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const draft = draftSlackMessage(input);
      audit({
        agent: "AdvisorAgent",
        action: "queue_slack_update",
        decision: "APPROVAL_REQUIRED",
        detail: { draft_id: draft.id, channel: draft.channel },
      });
      return text({
        draft,
        next_step:
          "If Slack MCP is connected in TrueForge, post this exact text to the channel. Otherwise leave queued for the desk dashboard.",
      });
    }
  );

  server.registerTool(
    "list_slack_queue",
    {
      description: "List queued Slack drafts awaiting post via Slack MCP.",
      inputSchema: { limit: z.number().int().positive().max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => text({ drafts: listSlackDrafts(limit || 20) })
  );

  server.registerTool(
    "notify_kyc_expired",
    {
      description:
        "NotificationAgent: email the client that KYC expired and include a secure renewal form link. Demo queues the email (approval-gated); does not send live SMTP.",
      inputSchema: {
        customer_id: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ customer_id }) => {
      const id = resolveCustomerId(customer_id);
      const customer = getCustomer(id);
      if (!customer) return blocked({ error: `Unknown customer ${id}` });
      const status = effectiveKycStatus(customer);
      if (status !== "EXPIRED" && status !== "IN_PROGRESS" && status !== "FAILED") {
        return blocked({
          error: `KYC is ${status}; notify_kyc_expired is for expired/incomplete clients.`,
          hint: "Call simulate_kyc_expiration first in the demo.",
        });
      }
      const email =
        customer.email ||
        `${customer.name.toLowerCase().replace(/\s+/g, ".")}@example.com`;
      const notification = queueKycExpiredNotification({
        customer_id: id,
        customer_name: customer.name,
        email,
        kyc_expires_at: customer.kyc_expires_at,
        missing_fields: missingKycFields(customer),
      });
      markNotificationSent(notification.id);
      audit({
        agent: "NotificationAgent",
        action: "notify_kyc_expired",
        customer_id: id,
        decision: "APPROVAL_REQUIRED",
        reason: "Client email + KYC renewal form queued (demo send)",
        detail: {
          notification_id: notification.id,
          to: notification.to,
          form_url: notification.form_url,
        },
      });
      return text({
        notification,
        form_preview: notification.form_url,
        note: "Demo: email queued and marked sent after TrueForge approval. Open form_url to show the client renewal form.",
      });
    }
  );

  server.registerTool(
    "list_client_notifications",
    {
      description: "NotificationAgent: list queued/sent client email notifications and form links.",
      inputSchema: { limit: z.number().int().positive().max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const notifications = listClientNotifications(limit || 20);
      audit({
        agent: "NotificationAgent",
        action: "list_client_notifications",
        decision: "ALLOW",
        detail: { count: notifications.length },
      });
      return text({ notifications });
    }
  );

  return server;
}

const app = createMcpExpressApp();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "finguard",
    mcp: `http://127.0.0.1:${PORT}/mcp`,
    data: dataBackendInfo(),
  });
});

app.get("/dashboard", (_req, res) => {
  res.json({ data: dashboardSnapshot() });
});

app.get("/data-backend", (_req, res) => {
  res.json({ data: dataBackendInfo() });
});

app.get("/market/quote/:symbol", async (req, res) => {
  try {
    const quote = await fetchQuote(req.params.symbol);
    res.json({ data: quote });
  } catch (e) {
    res.status(502).json({
      error: e instanceof Error ? e.message : "quote failed",
    });
  }
});

app.get("/market/snapshot", async (req, res) => {
  try {
    const raw = typeof req.query.symbols === "string" ? req.query.symbols : "";
    const symbols = raw
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const snapshot = await liveMarketSnapshot(symbols);
    res.json({ data: snapshot });
  } catch (e) {
    res.status(502).json({
      error: e instanceof Error ? e.message : "snapshot failed",
    });
  }
});

app.get("/market/technical/:symbol", async (req, res) => {
  try {
    const days = Number(req.query.days || 260);
    const analysis = await technicalAnalysis(
      req.params.symbol,
      Number.isFinite(days) ? days : 260
    );
    res.json({ data: analysis });
  } catch (e) {
    res.status(502).json({
      error: e instanceof Error ? e.message : "technical analysis failed",
    });
  }
});

app.post("/sessions/bind", (req, res) => {
  try {
    const session_id = String(req.body?.session_id || "");
    const customer_id = String(
      req.body?.customer_id || defaultCustomerId()
    );
    const title =
      typeof req.body?.title === "string" ? req.body.title : undefined;
    if (!session_id) {
      res.status(400).json({ error: "session_id required" });
      return;
    }
    if (!getCustomer(customer_id)) {
      res.status(404).json({ error: `Unknown customer ${customer_id}` });
      return;
    }
    const binding = bindTrueForgeSession({ session_id, customer_id, title });
    audit({
      agent: "KycAgent",
      action: "bind_trueforge_session_http",
      customer_id,
      decision: "ALLOW",
      detail: binding,
    });
    res.json({ data: binding });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "bind failed",
    });
  }
});

app.get("/sessions/:sessionId", (req, res) => {
  const binding = getTrueForgeSessionBinding(req.params.sessionId);
  res.json({ data: binding });
});

app.get("/kyc-form/:token", (req, res) => {
  const notification = getNotificationByToken(req.params.token);
  if (!notification) {
    res.status(404).type("html").send(`<!doctype html><html><body style="font-family:system-ui;padding:2rem">
      <h1>Form not found</h1><p>This KYC renewal link is invalid or expired (demo).</p></body></html>`);
    return;
  }
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>FinGuard KYC renewal</title>
  <style>
    :root { color-scheme: light; --brand:#0b5c4a; --ink:#0c1f1a; --mist:#eef4f1; }
    body { margin:0; font-family:"IBM Plex Sans", system-ui, sans-serif; background:linear-gradient(180deg,#f4f8f6,#e8efeb); color:var(--ink); }
    main { max-width:34rem; margin:2.5rem auto; padding:1.5rem; background:#fff; border:1px solid rgba(11,92,74,.14); border-radius:14px; box-shadow:0 18px 40px rgba(7,61,51,.08); }
    h1 { font-family:Georgia,serif; color:var(--brand); font-size:1.6rem; margin:0 0 .4rem; }
    p { color:#2a453c; line-height:1.5; }
    label { display:block; font-size:.8rem; font-weight:600; margin:1rem 0 .35rem; }
    input, select { width:100%; box-sizing:border-box; padding:.7rem .8rem; border:1px solid rgba(11,92,74,.2); border-radius:10px; font:inherit; }
    button { margin-top:1.25rem; width:100%; border:0; border-radius:10px; padding:.85rem 1rem; background:var(--brand); color:#f3faf7; font:inherit; font-weight:600; cursor:pointer; }
    .meta { font-size:.75rem; color:#5d736a; margin-top:1rem; }
    .badge { display:inline-block; padding:.2rem .5rem; border-radius:6px; background:var(--mist); color:var(--brand); font-size:.7rem; letter-spacing:.04em; text-transform:uppercase; }
  </style>
</head>
<body>
  <main>
    <span class="badge">FinGuard · KYC renewal</span>
    <h1>Re-verify ${notification.customer_name}</h1>
    <p>Your KYC expired. Submit this form so advisory recommendations can resume. Demo only — no data is stored live.</p>
    <form onsubmit="event.preventDefault(); this.querySelector('button').textContent='Submitted (demo)'; this.querySelector('button').disabled=true;">
      <label>Legal name</label>
      <input value="${notification.customer_name}" required />
      <label>Email</label>
      <input type="email" value="${notification.to}" required />
      <label>Government ID type</label>
      <select><option>Driver license</option><option>Passport</option><option>State ID</option></select>
      <label>Annual income (approx)</label>
      <input type="number" placeholder="185000" />
      <label>Risk questionnaire</label>
      <select><option>Moderate</option><option>Conservative</option><option>Aggressive</option></select>
      <button type="submit">Submit KYC renewal</button>
    </form>
    <p class="meta">Token ${notification.form_token} · notification ${notification.id} · educational demo</p>
  </main>
</body>
</html>`);
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("MCP error", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    })
  );
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`FinGuard MCP listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`Health: http://127.0.0.1:${PORT}/health`);
  console.log(`Audit log: ${auditPath()}`);
});
