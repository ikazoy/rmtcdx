import type {
  AccountRateLimitCredits,
  AccountRateLimitSnapshot,
  AccountRateLimitWindow,
  AccountRateLimits,
  AccountRateLimitsResponse,
  AccountPlanType
} from "../../../../packages/shared-types/src/index";
import type { CodexAccountRateLimits, CodexRateLimitCredits, CodexRateLimitSnapshot, CodexRateLimitWindow } from "../codex/types";

function toIsoTime(unixSeconds: number | null) {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;
}

function presentWindow(windowData: CodexRateLimitWindow | null): AccountRateLimitWindow | null {
  if (!windowData) {
    return null;
  }

  return {
    usedPercent: windowData.usedPercent,
    windowDurationMins: windowData.windowDurationMins,
    resetsAt: toIsoTime(windowData.resetsAt)
  };
}

function presentCredits(credits: CodexRateLimitCredits | null): AccountRateLimitCredits | null {
  if (!credits) {
    return null;
  }

  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    balance: credits.balance
  };
}

function presentSnapshot(snapshot: CodexRateLimitSnapshot): AccountRateLimitSnapshot {
  return {
    limitId: snapshot.limitId,
    limitName: snapshot.limitName,
    primary: presentWindow(snapshot.primary),
    secondary: presentWindow(snapshot.secondary),
    credits: presentCredits(snapshot.credits),
    planType: snapshot.planType as AccountPlanType | null
  };
}

function presentSnapshotMap(rateLimitsByLimitId: CodexAccountRateLimits["rateLimitsByLimitId"]) {
  if (!rateLimitsByLimitId) {
    return null;
  }

  const entries = Object.entries(rateLimitsByLimitId).map(([key, snapshot]) => [key, presentSnapshot(snapshot)] as const);
  return Object.fromEntries(entries);
}

export function presentAccountRateLimits(rateLimits: CodexAccountRateLimits): AccountRateLimits {
  return {
    rateLimits: presentSnapshot(rateLimits.rateLimits),
    rateLimitsByLimitId: presentSnapshotMap(rateLimits.rateLimitsByLimitId),
    fetchedAt: new Date().toISOString()
  };
}

export function unavailableAccountRateLimits(error: string | null): AccountRateLimitsResponse {
  return {
    available: false,
    rateLimits: null,
    error
  };
}
