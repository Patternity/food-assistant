import type { Request, Response, NextFunction } from "express";
import { DEFAULT_USER_ID, usersRepo } from "./store.js";

// Two separate concerns, deliberately not conflated:
//
// 1. SERVICE token (service-to-service): proves the CALLER (e.g. the Telegram
//    bot backend) is allowed to use this API. It is NOT end-user auth. If
//    SERVICE_TOKEN is unset we run in dev mode (open) so the local browser UI
//    works on localhost without embedding a secret in client JS.
//
// 2. user_id: WHO the request is for (e.g. a Telegram id). The caller asserts it
//    via X-User-Id; the assistant trusts it because the caller is authenticated
//    by the token. End users are authenticated upstream (by the bot), not here.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: number;
    }
  }
}

function presentedToken(req: Request): string | undefined {
  const h = req.header("authorization");
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return req.header("x-api-key") ?? undefined;
}

/** Auth + user resolution middleware for /api routes (health is mounted before it). */
export function authAndUser(req: Request, res: Response, next: NextFunction): void {
  const required = process.env.SERVICE_TOKEN;
  if (required) {
    if (presentedToken(req) !== required) {
      res.status(401).json({ error: "Unauthorized: missing or invalid service token." });
      return;
    }
  }

  const raw = req.header("x-user-id") ?? (req.body && req.body.userId) ?? req.query.uid;
  const uid = Number(raw ?? DEFAULT_USER_ID);
  if (!Number.isInteger(uid) || uid <= 0) {
    res.status(400).json({ error: "Invalid user id (X-User-Id must be a positive integer)." });
    return;
  }

  const provider = String(req.header("x-user-provider") ?? "local").slice(0, 32);
  usersRepo.touch(uid, provider); // register on first contact, bump last_seen
  req.userId = uid;
  next();
}

/** True in open dev mode (no service token configured). */
export function isDevOpen(): boolean {
  return !process.env.SERVICE_TOKEN;
}
