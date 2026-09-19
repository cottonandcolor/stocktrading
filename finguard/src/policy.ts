import {
  effectiveKycStatus,
  missingKycFields,
  type Customer,
  type KycStatus,
} from "./store.js";

export type PolicyAction =
  | "basic_info"
  | "portfolio_analysis"
  | "recommendation"
  | "trade_execution";

export type PolicyDecision = {
  action: PolicyAction;
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED" | "LIMITED";
  kyc_status: KycStatus;
  missing: string[];
  reasons: string[];
  capabilities: string[];
};

const CAPABILITIES: Record<KycStatus, string[]> = {
  NOT_STARTED: ["basic_info"],
  IN_PROGRESS: ["basic_info", "limited_analysis"],
  VERIFIED: [
    "basic_info",
    "portfolio_analysis",
    "recommendation",
    "trade_execution_with_approval",
  ],
  EXPIRED: ["basic_info", "limited_analysis"],
  FAILED: ["basic_info"],
  MANUAL_REVIEW: ["basic_info", "human_approval_queue"],
};

export function evaluatePolicy(customer: Customer, action: PolicyAction): PolicyDecision {
  const kyc = effectiveKycStatus(customer);
  const missing = missingKycFields(customer);
  const capabilities = CAPABILITIES[kyc];
  const reasons: string[] = [];

  if (action === "basic_info") {
    return {
      action,
      decision: "ALLOW",
      kyc_status: kyc,
      missing,
      reasons: ["Basic information is always available."],
      capabilities,
    };
  }

  if (action === "portfolio_analysis") {
    if (kyc === "VERIFIED" && missing.length === 0) {
      return {
        action,
        decision: "ALLOW",
        kyc_status: kyc,
        missing,
        reasons: ["KYC verified; full portfolio analysis allowed."],
        capabilities,
      };
    }
    if (kyc === "EXPIRED" || kyc === "IN_PROGRESS") {
      return {
        action,
        decision: "LIMITED",
        kyc_status: kyc,
        missing,
        reasons: [
          `KYC is ${kyc}. Holdings summary allowed; no personalized recommendation.`,
        ],
        capabilities,
      };
    }
    return {
      action,
      decision: "BLOCK",
      kyc_status: kyc,
      missing,
      reasons: [`Portfolio analysis blocked while KYC is ${kyc}.`],
      capabilities,
    };
  }

  if (action === "recommendation") {
    if (kyc !== "VERIFIED") {
      reasons.push(`KYC status must be VERIFIED (currently ${kyc}).`);
    }
    if (missing.length) {
      reasons.push(`Missing suitability fields: ${missing.join(", ")}.`);
    }
    if (kyc === "VERIFIED" && missing.length === 0) {
      return {
        action,
        decision: "ALLOW",
        kyc_status: kyc,
        missing,
        reasons: ["KYC complete; investment recommendation allowed."],
        capabilities,
      };
    }
    return {
      action,
      decision: "BLOCK",
      kyc_status: kyc,
      missing,
      reasons: [
        ...reasons,
        "Policy: Investment recommendations require a completed customer suitability profile.",
      ],
      capabilities,
    };
  }

  // trade_execution
  if (kyc !== "VERIFIED" || missing.length) {
    return {
      action,
      decision: "BLOCK",
      kyc_status: kyc,
      missing,
      reasons: [
        `Trade execution blocked. KYC=${kyc}.`,
        missing.length ? `Missing: ${missing.join(", ")}` : "Complete compliance first.",
      ],
      capabilities,
    };
  }
  return {
    action,
    decision: "APPROVAL_REQUIRED",
    kyc_status: kyc,
    missing,
    reasons: [
      "KYC verified and suitability present.",
      "Paper trade still requires human approval before execution.",
    ],
    capabilities,
  };
}

export function formatBlockBanner(decision: PolicyDecision): string {
  const lines = [
    "ACTION BLOCKED",
    "",
    `KYC status: ${decision.kyc_status}`,
    decision.missing.length ? `Missing:\n- ${decision.missing.join("\n- ")}` : "",
    "",
    "Policy:",
    ...decision.reasons.map((r) => `- ${r}`),
    "",
    "Next action: collect missing KYC / re-verify, then retry.",
  ].filter((l) => l !== undefined);
  return lines.join("\n");
}
