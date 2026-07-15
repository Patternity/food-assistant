import { usageRepo } from "./store.js";
import type { Lang } from "./lang.js";

// Token budgets guard against abuse and runaway spend. Two limits, combined:
//   - session: a single conversation (sessionId supplied by the orchestrator/bot);
//   - day: a rolling per-user daily cap so one user can't burn the whole quota.
// Both are configured at container start (env). A limit of 0 disables that one.
//
// At WARN_RATIO of either budget the assistant is told to warn the user and add
// a short session summary, but it keeps answering ("chit-chat") until a budget
// is fully spent. At 100% the controller hard-stops before calling the LLM.

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export const SESSION_BUDGET = num(process.env.SESSION_TOKEN_BUDGET, 20000);
export const DAILY_BUDGET = num(process.env.DAILY_TOKEN_BUDGET, 100000);
export const WARN_RATIO = Math.min(1, Math.max(0, num(process.env.TOKEN_WARN_RATIO, 0.8)));

export type BudgetScope = "session" | "day";

export type BudgetView = {
  session: { used: number; limit: number };
  day: { used: number; limit: number };
  low: boolean; // reached WARN_RATIO of a budget -> warn + summarize
  exhausted: boolean; // reached 100% of a budget -> hard stop
  scope: BudgetScope | null; // which budget is the tightest right now
};

/** UTC day key so the daily window is stable regardless of server locale. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const sessionKey = (userId: number, sessionId: string) => `${userId}:${sessionId}`;
const dayKey = (userId: number) => `${userId}:${today()}`;

/** Read spend BEFORE this turn and derive the budget state. */
export function readBudget(userId: number, sessionId: string): BudgetView {
  const sUsed = usageRepo.get("session", sessionKey(userId, sessionId));
  const dUsed = usageRepo.get("day", dayKey(userId));

  const sOver = SESSION_BUDGET > 0 && sUsed >= SESSION_BUDGET;
  const dOver = DAILY_BUDGET > 0 && dUsed >= DAILY_BUDGET;
  const sLow = SESSION_BUDGET > 0 && sUsed >= SESSION_BUDGET * WARN_RATIO;
  const dLow = DAILY_BUDGET > 0 && dUsed >= DAILY_BUDGET * WARN_RATIO;

  const scope: BudgetScope | null = dOver ? "day" : sOver ? "session" : dLow ? "day" : sLow ? "session" : null;

  return {
    session: { used: sUsed, limit: SESSION_BUDGET },
    day: { used: dUsed, limit: DAILY_BUDGET },
    low: sLow || dLow,
    exhausted: sOver || dOver,
    scope,
  };
}

/** Charge tokens spent this turn to both the session and the daily counter. */
export function recordUsage(userId: number, sessionId: string, tokens: number): void {
  if (!tokens) return;
  usageRepo.add("session", sessionKey(userId, sessionId), tokens);
  usageRepo.add("day", dayKey(userId), tokens);
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
