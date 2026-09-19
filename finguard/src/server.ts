import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";
import { audit, auditPath, readAudit } from "./audit.js";
import {
  completeTask,
  createTask,
  dashboardSnapshot,
  draftSlackMessage,
  listAppointments,
  listNews,
  listSlackDrafts,
  listTasks,
  scheduleAppointment,
} from "./desk.js";
import { evaluatePolicy, formatBlockBanner } from "./policy.js";
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

function resolveCustomerId(customer_id?: string) {
  return customer_id || defaultCustomerId();
}

function buildServer() {
  const server = new McpServer({ name: "finguard", version: "0.1.0" });

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
        customer_id: z.string().optional().describe("Defaults to Jane Smith demo customer"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customer_id }) => {
      const id = resolveCustomerId(customer_id);
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
        "Educational market context with explicit as-of dates (synthetic for demo; not live quotes).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const snapshot = {
        as_of: "2026-09-19",
        disclaimer: "Synthetic demo snapshot for hackathon — verify live data before any real advice.",
        money_market_yield_approx: "4.2%",
        spy_vs_200dma: "above",
        qqq_vs_200dma: "above",
        regime_note:
          "Elevated cash yields reduce urgency of lump-sum deployment; DCA still reasonable for behavioral risk.",
      };
      audit({
        agent: "AdvisorAgent",
        action: "get_market_snapshot",
        decision: "INFO",
      });
      return text(snapshot);
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
      audit({
        agent: "KycAgent",
        action: "simulate_kyc_verified",
        customer_id: id,
        decision: "INFO",
        reason: "Demo toggle: KYC verified",
      });
      return text({
        customer_id: id,
        kyc_status: effectiveKycStatus(customer),
        kyc_expires_at: customer.kyc_expires_at,
        missing: missingKycFields(customer),
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

  return server;
}

const app = createMcpExpressApp();

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "finguard", mcp: `http://127.0.0.1:${PORT}/mcp` });
});

app.get("/dashboard", (_req, res) => {
  res.json({ data: dashboardSnapshot() });
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
