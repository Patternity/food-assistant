import { settingsRepo } from "./store.js";
import type { Lang } from "./lang.js";

// Token budgets guard against abuse and runaway spend. Two limits, combined:
//   - session: ONE conversation per user, tracked server-side (see sessionsRepo).
//     The bot only signals open/close; a session also closes itself when spent
//     or after the inactivity TTL. No session id is plumbed around.
//   - day: a rolling per-user daily cap so one user can't burn the whole quota.
//
// The env values are DEFAULTS only; the effective config is stored in the
// settings table and editable at runtime via the admin API (so an operator can
// tune budgets from the bot's admin panel without redeploying). See budgetConfig().
//
// At warnRatio of either budget the assistant is told to warn the user and add a
// short session summary, but it keeps answering ("chit-chat") until a budget is
// fully spent. At 100% the controller hard-stops before calling the LLM.

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

// Env-provided defaults (used until an admin overrides them at runtime).
const DEFAULTS = {
  sessionBudget: num(process.env.SESSION_TOKEN_BUDGET, 20000),
  dailyBudget: num(process.env.DAILY_TOKEN_BUDGET, 100000),
  warnRatio: Math.min(1, Math.max(0, num(process.env.TOKEN_WARN_RATIO, 0.8))),
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 6),
};

// Settings keys (also the field names accepted by the admin API).
const KEYS = {
  sessionBudget: "session_token_budget",
  dailyBudget: "daily_token_budget",
  warnRatio: "token_warn_ratio",
  sessionTtlHours: "session_ttl_hours",
} as const;

export type BudgetConfig = {
  sessionBudget: number;
  dailyBudget: number;
  warnRatio: number;
  sessionTtlHours: number;
  sessionTtlMs: number;
};

/** Effective config: stored settings over env defaults. Read fresh each call. */
export function budgetConfig(): BudgetConfig {
  const s = settingsRepo.all();
  const sessionTtlHours = num(s[KEYS.sessionTtlHours], DEFAULTS.sessionTtlHours);
  return {
    sessionBudget: num(s[KEYS.sessionBudget], DEFAULTS.sessionBudget),
    dailyBudget: num(s[KEYS.dailyBudget], DEFAULTS.dailyBudget),
    warnRatio: Math.min(1, Math.max(0, num(s[KEYS.warnRatio], DEFAULTS.warnRatio))),
    sessionTtlHours,
    sessionTtlMs: sessionTtlHours * 3_600_000,
  };
}

/**
 * Apply an admin patch to the budget config (partial). Only known, valid fields
 * are written; anything else is ignored. Returns the new effective config.
 */
export function setBudgetConfig(patch: Record<string, unknown>): BudgetConfig {
  const write = (key: string, raw: unknown, min = 0, max = Number.POSITIVE_INFINITY) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) settingsRepo.set(key, String(n));
  };
  write(KEYS.sessionBudget, patch.sessionBudget);
  write(KEYS.dailyBudget, patch.dailyBudget);
  write(KEYS.warnRatio, patch.warnRatio, 0, 1);
  write(KEYS.sessionTtlHours, patch.sessionTtlHours);
  return budgetConfig();
}

export type BudgetScope = "session" | "day";

export type BudgetView = {
  session: { used: number; limit: number };
  day: { used: number; limit: number };
  low: boolean; // reached warnRatio of a budget -> warn + summarize
  exhausted: boolean; // reached 100% of a budget -> hard stop
  scope: BudgetScope | null; // which budget is the tightest right now
};

/** UTC day key so the daily window is stable regardless of server locale. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Daily-counter key for the token_usage store. */
export const dayKey = (userId: number): string => `${userId}:${today()}`;

/** Derive the budget state from tokens already spent (session + day). */
export function viewFromUsage(sessionUsed: number, dayUsed: number): BudgetView {
  const { sessionBudget, dailyBudget, warnRatio } = budgetConfig();
  const sOver = sessionBudget > 0 && sessionUsed >= sessionBudget;
  const dOver = dailyBudget > 0 && dayUsed >= dailyBudget;
  const sLow = sessionBudget > 0 && sessionUsed >= sessionBudget * warnRatio;
  const dLow = dailyBudget > 0 && dayUsed >= dailyBudget * warnRatio;

  const scope: BudgetScope | null = dOver ? "day" : sOver ? "session" : dLow ? "day" : sLow ? "session" : null;

  return {
    session: { used: sessionUsed, limit: sessionBudget },
    day: { used: dayUsed, limit: dailyBudget },
    low: sLow || dLow,
    exhausted: sOver || dOver,
    scope,
  };
}

/**
 * System-prompt block asking the model to warn the user and summarize. Empty
 * unless the budget is low. Deliberately abstract — it's about the session's
 * usage limit, with no product/culture assumptions.
 */
export function budgetDirective(view: BudgetView): string {
  if (!view.low) return "";
  return [
    "",
    "",
    "SESSION LIMIT: This session is close to its token budget. Answer the user's",
    "message normally, keeping all your usual fields unchanged. In ADDITION, add",
    'one extra key to the JSON object you return: "session_summary" — a short,',
    "friendly text (2-4 sentences) in the user's language that (a) gently warns",
    "the session is nearing its limit, and (b) recaps this session so far: the",
    "key products discussed, any chosen dish, and what to buy — so the user can",
    'wrap up now or continue later. Only add "session_summary"; change nothing else.',
  ].join("\n");
}

/** Canned, LLM-free message returned once a budget is fully spent. */
export function budgetHardStopText(view: BudgetView, lang: Lang): string {
  const daily = view.scope === "day";
  if (lang === "en") {
    return daily
      ? "You've reached today's usage limit for the assistant. Please come back tomorrow."
      : "This session has reached its usage limit. Start a new session to continue.";
  }
  return daily
    ? "На сегодня лимит запросов к ассистенту исчерпан. Возвращайтесь завтра."
    : "Лимит этой сессии исчерпан. Начните новую сессию, чтобы продолжить.";
}
