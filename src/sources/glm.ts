/**
 * GLM Coding Plan (Z.ai / Zhipu) usage via /api/monitor/usage/quota/limit.
 *
 * Platform is auto-detected from where the API key was found:
 * - "zai-coding-plan" credential or ZAI_API_KEY        -> https://api.z.ai
 * - "zhipu*-coding-plan" credential or ZHIPU_API_KEY   -> https://bigmodel.cn
 *
 * NOTE: the Authorization header carries the raw key, WITHOUT a "Bearer" prefix.
 */

import { credentialKey, credentialsFor, legacyAuthEntry } from "./auth";
import { clampPct, describe, fetchJson, rateLimitedUntil, toIso } from "./http";
import { errorResult, missingResult, type QuotaResult, type UsageWindow } from "./types";

const ZAI_BASE = "https://api.z.ai";
const ZHIPU_BASE = "https://bigmodel.cn";

interface QuotaLimit {
  type?: string; // TOKENS_LIMIT | CREDIT_LIMIT | TIME_LIMIT
  unit?: number; // 3 -> 5h window, 6 -> weekly
  percentage?: number; // used percent
  nextResetTime?: number; // epoch (ms)
}

interface QuotaResponse {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: { limits?: QuotaLimit[] } | null;
  limits?: QuotaLimit[];
}

function unitLabel(unit: unknown): string | undefined {
  if (unit === 3) return "5h";
  if (unit === 6) return "7d";
  return undefined;
}

export function parseWindows(body: QuotaResponse, platform: "zai" | "zhipu"): UsageWindow[] {
  if (
    platform === "zai" &&
    (body.success === false || (typeof body.code === "number" && body.code >= 400))
  ) {
    throw new Error(body.msg || `GLM API error ${body.code ?? ""}`.trim());
  }
  const limits = body.data?.limits ?? body.limits;
  if (!Array.isArray(limits)) throw new Error("Invalid GLM quota response shape.");

  const windows: UsageWindow[] = [];
  for (const limit of limits) {
    const isQuota = limit.type === "TOKENS_LIMIT" || limit.type === "CREDIT_LIMIT";
    if (!isQuota) continue; // skip TIME_LIMIT (MCP) windows
    const label = unitLabel(limit.unit);
    if (!label || typeof limit.percentage !== "number") continue;
    windows.push({
      label,
      usedPct: clampPct(limit.percentage),
      resetsAt: toIso(limit.nextResetTime),
    });
  }
  return windows;
}

const GLM_IDS = ["zai-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"] as const;

function platformAuth(apiKey: string, platform: "zai" | "zhipu") {
  return { apiKey, base: platform === "zai" ? ZAI_BASE : ZHIPU_BASE, platform };
}

export async function resolveGlmAuth(): Promise<
  { apiKey: string; base: string; platform: "zai" | "zhipu" } | undefined
> {
  for (const id of GLM_IDS) {
    const credential = (await credentialsFor([id]))[0];
    const apiKey = credential ? credentialKey(credential) : (await legacyAuthEntry([id]))?.entry.key?.trim();
    if (apiKey) return platformAuth(apiKey, id === "zai-coding-plan" ? "zai" : "zhipu");
  }

  const zaiEnv = process.env["ZAI_API_KEY"]?.trim() || process.env["ZAI_CODING_PLAN_API_KEY"]?.trim();
  if (zaiEnv) return platformAuth(zaiEnv, "zai");

  const zhipuEnv =
    process.env["ZHIPU_API_KEY"]?.trim() || process.env["ZHIPU_CODING_PLAN_API_KEY"]?.trim();
  if (zhipuEnv) return platformAuth(zhipuEnv, "zhipu");

  return undefined;
}

export async function queryGlm(): Promise<QuotaResult> {
  const auth = await resolveGlmAuth();
  if (!auth) {
    return missingResult(
      "No GLM Coding Plan key found (/connect Z.AI Coding Plan, or set ZAI_API_KEY / ZHIPU_API_KEY).",
    );
  }

  try {
    const body = await fetchJson<QuotaResponse>(`${auth.base}/api/monitor/usage/quota/limit`, {
      headers: {
        // Deliberately NOT "Bearer <key>" - the API expects the raw key.
        authorization: auth.apiKey,
        "content-type": "application/json",
      },
    });
    const windows = parseWindows(body, auth.platform);
    if (windows.length === 0) return errorResult("No quota windows in GLM usage response.");
    return { ok: true, windows };
  } catch (error) {
    const limitedUntil = rateLimitedUntil(error);
    if (limitedUntil) return errorResult("GLM: rate limited (HTTP 429).", limitedUntil);
    return errorResult(describe(error, "GLM"));
  }
}
