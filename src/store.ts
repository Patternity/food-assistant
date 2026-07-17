import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { GlossaryEntry } from "./glossary.js";
import type { PantryItem } from "./pantry.js";
import type { Recipe } from "./recipes.js";
import type { EquipmentItem } from "./equipment.js";
import type { Preference } from "./preferences.js";
import type { Item } from "./services/assistantService.js";

// Durable per-user store (SQLite). In the alpha there is a single user
// (DEFAULT_USER_ID = 1), but every row is keyed by user_id so moving to
// multi-user later is a migration, not a rewrite. This is the persistent home
// for purchase history, the pantry ("what's at home"), and the glossary —
// promoted out of the browser session (see the pantry/glossary design notes).

export const DEFAULT_USER_ID = 1;

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DB_PATH || join(dataDir, "food-assistant.sqlite");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,   -- external uid (e.g. Telegram id) used directly
  provider   TEXT,                  -- 'telegram' | 'local' | ...
  created_at TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  ts          TEXT    NOT NULL,
  source_type TEXT,
  basket_kind TEXT,
  raw_text    TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_user_ts ON purchases(user_id, ts);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  category    TEXT,
  qty         REAL,
  unit        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pitems_user_name ON purchase_items(user_id, name);

CREATE TABLE IF NOT EXISTS pantry (
  user_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL COLLATE NOCASE,
  category   TEXT,
  state      TEXT    NOT NULL DEFAULT 'available',
  source     TEXT,
  confidence TEXT,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS glossary (
  user_id    INTEGER NOT NULL,
  term       TEXT    NOT NULL COLLATE NOCASE,
  canonical  TEXT    NOT NULL,
  category   TEXT,
  confidence TEXT,
  source     TEXT,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, term)
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id    INTEGER NOT NULL,
  text       TEXT    NOT NULL COLLATE NOCASE,
  kind       TEXT,
  state      TEXT    NOT NULL DEFAULT 'active',
  source     TEXT,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, text)
);

CREATE TABLE IF NOT EXISTS equipment (
  user_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL COLLATE NOCASE,
  state      TEXT    NOT NULL DEFAULT 'has',
  source     TEXT,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS token_usage (
  scope      TEXT    NOT NULL,   -- 'day' (rolling per-user daily counter)
  key        TEXT    NOT NULL,   -- '<user>:<YYYY-MM-DD>'
  tokens     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Runtime settings (key/value), editable via the admin API. Overrides the env
-- defaults so an operator can tune budgets without redeploying the container.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One live session per user. The bot signals open/close; a session also self-
-- closes when its token budget is spent or after an inactivity TTL.
CREATE TABLE IF NOT EXISTS sessions (
  user_id    INTEGER PRIMARY KEY,
  seq        INTEGER NOT NULL DEFAULT 0,   -- bumped on each new session (debug/telemetry)
  tokens     INTEGER NOT NULL DEFAULT 0,   -- tokens spent in the current session
  started_at TEXT    NOT NULL,
  last_at    TEXT    NOT NULL,
  closed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recipes (
  user_id       INTEGER NOT NULL,
  name          TEXT    NOT NULL COLLATE NOCASE,
  method        TEXT,
  equipment     TEXT,  -- JSON array
  required      TEXT,  -- JSON array
  helpful       TEXT,  -- JSON array
  optional      TEXT,  -- JSON array
  staples       TEXT,  -- JSON array
  side_dishes   TEXT,  -- JSON array
  substitutions TEXT,  -- JSON array
  notes         TEXT,
  raw_text      TEXT,
  updated_at    TEXT    NOT NULL,
  PRIMARY KEY (user_id, name)
);
`);

// Migrations (guarded ALTERs so existing DBs upgrade in place).
{
  const piCols = db.prepare("PRAGMA table_info(purchase_items)").all() as Array<{ name: string }>;
  if (!piCols.some((c) => c.name === "canonical")) db.exec("ALTER TABLE purchase_items ADD COLUMN canonical TEXT");
  const pCols = db.prepare("PRAGMA table_info(pantry)").all() as Array<{ name: string }>;
  if (!pCols.some((c) => c.name === "edible")) db.exec("ALTER TABLE pantry ADD COLUMN edible INTEGER NOT NULL DEFAULT 1");
}

const now = () => new Date().toISOString();

// --- Users (registry of external uids, e.g. Telegram ids) --------------------

export const usersRepo = {
  /** Record a user on first contact and bump last_seen. Returns the uid. */
  touch(userId: number, provider = "local"): number {
    const t = now();
    db.prepare(
      `INSERT INTO users (id, provider, created_at, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`
    ).run(userId, provider, t, t);
    return userId;
  },
};

// --- Token usage (session + daily budgets) ----------------------------------

// Cumulative LLM token spend, tracked per session and per user-day so the
// controller can warn/summarize near a limit and hard-stop once it's reached
// (abuse guard). Deterministic counters, incremented after each request; the
// budgets themselves live in budget.ts (env-configured at container start).

export const usageRepo = {
  get(scope: "session" | "day", key: string): number {
    const row = db.prepare(`SELECT tokens FROM token_usage WHERE scope = ? AND key = ?`).get(scope, key) as
      | { tokens: number }
      | undefined;
    return row?.tokens ?? 0;
  },

  add(scope: "session" | "day", key: string, tokens: number): void {
    if (!tokens) return;
    db.prepare(
      `INSERT INTO token_usage (scope, key, tokens, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         tokens = token_usage.tokens + excluded.tokens,
         updated_at = excluded.updated_at`
    ).run(scope, key, tokens, now());
  },
};

// --- Settings (runtime config, admin-editable) ------------------------------

export const settingsRepo = {
  /** All settings as a plain map (missing keys simply absent). */
  all(): Record<string, string> {
    const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  get(key: string): string | undefined {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  },

  set(key: string, value: string): void {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, now());
  },
};

// One live session per user (there's never more than one at a time). Lifecycle:
// a fresh session starts when the caller forces it (open), when none exists, when
// the current one is closed, or when it went idle past the TTL. It does NOT auto-
// restart just because it's exhausted — a spent session stays spent until an
// explicit open or the idle TTL, so the budget actually bites.

type SessionRow = { seq: number; tokens: number; started_at: string; last_at: string; closed: number };

export const sessionsRepo = {
  /**
   * Resolve the user's active session for this turn, opening a fresh one when
   * needed. Returns the tokens already spent in the active session (0 for a
   * fresh one). Mutates only when it opens a new session — an existing session's
   * last_at is bumped later via add(), so a blocked turn doesn't extend its life.
   */
  resolve(userId: number, opts: { forceNew: boolean; ttlMs: number }): { seq: number; tokens: number; fresh: boolean } {
    const row = db.prepare(`SELECT seq, tokens, started_at, last_at, closed FROM sessions WHERE user_id = ?`).get(userId) as
      | SessionRow
      | undefined;
    const idleExpired = !!row && Date.now() - Date.parse(row.last_at) >= opts.ttlMs;
    const fresh = opts.forceNew || !row || row.closed === 1 || idleExpired;
    if (!fresh) return { seq: row!.seq, tokens: row!.tokens, fresh: false };

    const seq = (row?.seq ?? 0) + 1;
    const t = now();
    db.prepare(
      `INSERT INTO sessions (user_id, seq, tokens, started_at, last_at, closed)
       VALUES (?, ?, 0, ?, ?, 0)
       ON CONFLICT(user_id) DO UPDATE SET
         seq = excluded.seq, tokens = 0, started_at = excluded.started_at, last_at = excluded.last_at, closed = 0`
    ).run(userId, seq, t, t);
    return { seq, tokens: 0, fresh: true };
  },

  /** Charge tokens spent this turn to the active session (and bump activity). */
  add(userId: number, tokens: number): void {
    if (!tokens) return;
    db.prepare(`UPDATE sessions SET tokens = tokens + ?, last_at = ? WHERE user_id = ?`).run(tokens, now(), userId);
  },

  /** End the current session (the next turn opens a fresh one). */
  close(userId: number): void {
    db.prepare(`UPDATE sessions SET closed = 1, last_at = ? WHERE user_id = ?`).run(now(), userId);
  },

  /** Read-only tokens in the active session (0 if none / closed / idle) — for stats. */
  peek(userId: number, ttlMs: number): number {
    const row = db.prepare(`SELECT tokens, last_at, closed FROM sessions WHERE user_id = ?`).get(userId) as
      | { tokens: number; last_at: string; closed: number }
      | undefined;
    if (!row || row.closed === 1) return 0;
    if (Date.now() - Date.parse(row.last_at) >= ttlMs) return 0;
    return row.tokens;
  },
};

// --- Purchases (history) ----------------------------------------------------

// The canonical (brand/size-agnostic) name is the product's identity for pantry
// and cadence; fall back to the raw name when extraction didn't provide one.
const canon = (it: Item): string => (it.canonical || it.name || "").trim();

export const purchasesRepo = {
  add(
    userId: number,
    meta: { source_type?: string; basket_kind?: string; raw_text?: string },
    items: Item[]
  ): number {
    const insertPurchase = db.prepare(
      `INSERT INTO purchases (user_id, ts, source_type, basket_kind, raw_text)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertItem = db.prepare(
      `INSERT INTO purchase_items (purchase_id, user_id, name, canonical, category, qty, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      const res = insertPurchase.run(userId, now(), meta.source_type ?? null, meta.basket_kind ?? null, meta.raw_text ?? null);
      const purchaseId = Number(res.lastInsertRowid);
      for (const it of items) {
        insertItem.run(purchaseId, userId, it.name, canon(it), it.category ?? null, it.qty ?? null, it.unit ?? null);
      }
      return purchaseId;
    });
    return tx();
  },

  /** Delete the most recent purchase (and its items). Returns its canonical
   *  names so the caller can also roll back the pantry it observed. */
  deleteLast(userId: number): string[] {
    const row = db.prepare(`SELECT id FROM purchases WHERE user_id = ? ORDER BY ts DESC LIMIT 1`).get(userId) as
      | { id: number }
      | undefined;
    if (!row) return [];
    const names = (
      db
        .prepare(`SELECT DISTINCT COALESCE(NULLIF(TRIM(canonical), ''), name) AS n FROM purchase_items WHERE purchase_id = ?`)
        .all(row.id) as Array<{ n: string }>
    ).map((r) => r.n);
    db.prepare(`DELETE FROM purchases WHERE id = ?`).run(row.id); // cascade removes purchase_items
    return names;
  },

  /** Total saved baskets for the user (for usage stats). */
  count(userId: number): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE user_id = ?`).get(userId) as { n: number };
    return row?.n ?? 0;
  },

  recent(userId: number, limit = 20): Array<{ id: number; ts: string; basket_kind: string | null; items: string[] }> {
    const rows = db
      .prepare(`SELECT id, ts, basket_kind FROM purchases WHERE user_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(userId, limit) as Array<{ id: number; ts: string; basket_kind: string | null }>;
    const itemsStmt = db.prepare(`SELECT name FROM purchase_items WHERE purchase_id = ?`);
    return rows.map((r) => ({
      ...r,
      items: (itemsStmt.all(r.id) as Array<{ name: string }>).map((x) => x.name),
    }));
  },
};

// --- Pantry ("what's at home") ---------------------------------------------

export const pantryRepo = {
  upsert(userId: number, item: PantryItem): void {
    if (!item?.name?.trim()) return;
    db.prepare(
      `INSERT INTO pantry (user_id, name, category, state, source, confidence, edible, updated_at)
       VALUES (@user_id, @name, @category, @state, @source, @confidence, @edible, @updated_at)
       ON CONFLICT(user_id, name) DO UPDATE SET
         category = excluded.category,
         state = excluded.state,
         source = excluded.source,
         confidence = excluded.confidence,
         edible = excluded.edible,
         updated_at = excluded.updated_at`
    ).run({
      user_id: userId,
      name: item.name.trim(),
      category: item.category ?? null,
      state: item.state === "missing" ? "missing" : "available",
      source: item.source ?? "user_confirmed",
      confidence: item.confidence ?? "high",
      edible: item.edible === false ? 0 : 1,
      updated_at: now(),
    });
  },

  /**
   * Record bought items as pantry evidence: "observed" (probably at home now),
   * low confidence. Crucially, this must NOT overwrite a `user_confirmed` row —
   * what the user explicitly said (including "used up") outranks a purchase.
   * (Perishables aren't aged yet; that comes with the cadence/spoilage step.)
   */
  observeFromPurchase(userId: number, items: Item[]): void {
    const stmt = db.prepare(
      `INSERT INTO pantry (user_id, name, category, state, source, confidence, edible, updated_at)
       VALUES (@user_id, @name, @category, 'available', 'observed', 'low', @edible, @updated_at)
       ON CONFLICT(user_id, name) DO UPDATE SET
         category = excluded.category,
         state = 'available',
         edible = excluded.edible,
         updated_at = excluded.updated_at
       WHERE pantry.source != 'user_confirmed'`
    );
    const tx = db.transaction(() => {
      for (const it of items) {
        const key = canon(it);
        if (!key) continue;
        stmt.run({ user_id: userId, name: key, category: it.category ?? null, edible: it.edible === false ? 0 : 1, updated_at: now() });
      }
    });
    tx();
  },

  /** Items currently believed to be at home (state = available). */
  list(userId: number): PantryItem[] {
    const rows = db
      .prepare(`SELECT name, category, state, source, confidence, edible, updated_at FROM pantry WHERE user_id = ? AND state = 'available' ORDER BY updated_at DESC`)
      .all(userId) as Array<Omit<PantryItem, "edible"> & { edible: number }>;
    return rows.map((r) => ({ ...r, edible: r.edible !== 0 }));
  },

  remove(userId: number, name: string): void {
    db.prepare(`DELETE FROM pantry WHERE user_id = ? AND name = ?`).run(userId, name);
  },

  /** Roll back observed (not user-confirmed) pantry rows for the given names —
   *  used when a purchase turns out not to be the user's (e.g. for guests). */
  removeObserved(userId: number, names: string[]): void {
    const stmt = db.prepare(`DELETE FROM pantry WHERE user_id = ? AND name = ? AND source = 'observed'`);
    const tx = db.transaction(() => {
      for (const n of names ?? []) if (n?.trim()) stmt.run(userId, n.trim());
    });
    tx();
  },

  /** Wipe the whole at-home memory — the user said everything is gone / asked to
   *  reset the pantry. Returns the number of rows removed. */
  clear(userId: number): number {
    return db.prepare(`DELETE FROM pantry WHERE user_id = ?`).run(userId).changes;
  },
};

// --- Glossary (personal term -> canonical product) --------------------------

// --- Purchase cadence (how often the user rebuys an item) -------------------

export type RestockHint = { name: string; cadence_days: number; days_since_last: number };

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const DAY_MS = 86_400_000;

export const itemStatsRepo = {
  /**
   * Items that may be due to restock, inferred from purchase history:
   * cadence = median interval between purchases. Deterministic; computed in code,
   * not by the LLM. Gated by minPurchases (default 3) — with fewer buys the
   * rhythm isn't reliable, so we stay quiet (per the design).
   */
  dueForRestock(
    userId: number,
    { minPurchases = 3, factor = 0.85 }: { minPurchases?: number; factor?: number } = {}
  ): RestockHint[] {
    const rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(pi.canonical), ''), pi.name) AS name, p.ts AS ts
         FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
         WHERE pi.user_id = ? ORDER BY p.ts ASC`
      )
      .all(userId) as Array<{ name: string; ts: string }>;

    // Group by the canonical name so brand/size label variations line up.
    const groups = new Map<string, { name: string; ts: number[] }>();
    for (const r of rows) {
      const key = r.name.toLowerCase().replace(/\s+/g, " ").trim();
      if (!groups.has(key)) groups.set(key, { name: r.name, ts: [] });
      groups.get(key)!.ts.push(Date.parse(r.ts));
    }

    const nowMs = Date.now();
    const out: RestockHint[] = [];
    for (const g of groups.values()) {
      const ts = g.ts.sort((a, b) => a - b);
      if (ts.length < minPurchases) continue; // need enough buys for a reliable rhythm
      const intervals: number[] = [];
      for (let i = 1; i < ts.length; i++) intervals.push((ts[i] - ts[i - 1]) / DAY_MS);
      const cadence = median(intervals);
      const daysSinceLast = (nowMs - ts[ts.length - 1]) / DAY_MS;
      if (cadence > 0 && daysSinceLast >= cadence * factor) {
        out.push({ name: g.name, cadence_days: Math.round(cadence), days_since_last: Math.round(daysSinceLast) });
      }
    }
    return out.sort((a, b) => b.days_since_last / b.cadence_days - a.days_since_last / a.cadence_days);
  },
};

export const glossaryRepo = {
  upsert(userId: number, entry: GlossaryEntry): void {
    if (!entry?.term?.trim() || !entry?.canonical?.trim()) return;
    db.prepare(
      `INSERT INTO glossary (user_id, term, canonical, category, confidence, source, updated_at)
       VALUES (@user_id, @term, @canonical, @category, @confidence, @source, @updated_at)
       ON CONFLICT(user_id, term) DO UPDATE SET
         canonical = excluded.canonical,
         category = excluded.category,
         confidence = excluded.confidence,
         source = excluded.source,
         updated_at = excluded.updated_at`
    ).run({
      user_id: userId,
      term: entry.term.trim().toLowerCase(),
      canonical: entry.canonical.trim(),
      category: entry.category ?? null,
      confidence: entry.confidence ?? "high",
      source: entry.source ?? "user_confirmed",
      updated_at: now(),
    });
  },

  list(userId: number): GlossaryEntry[] {
    return db
      .prepare(`SELECT term, canonical, category, confidence, source FROM glossary WHERE user_id = ? ORDER BY updated_at DESC`)
      .all(userId) as GlossaryEntry[];
  },
};

// --- Preferences (standing wishes / constraints) ----------------------------

export const preferencesRepo = {
  upsert(userId: number, pref: Preference): void {
    if (!pref?.text?.trim()) return;
    db.prepare(
      `INSERT INTO preferences (user_id, text, kind, state, source, updated_at)
       VALUES (@user_id, @text, @kind, @state, 'user_confirmed', @updated_at)
       ON CONFLICT(user_id, text) DO UPDATE SET
         kind = excluded.kind, state = excluded.state, source = 'user_confirmed', updated_at = excluded.updated_at`
    ).run({
      user_id: userId,
      text: pref.text.trim(),
      kind: pref.kind ?? null,
      state: pref.state === "dropped" ? "dropped" : "active",
      updated_at: now(),
    });
  },

  /** Active preferences (dropped ones are kept but not applied). */
  list(userId: number): Preference[] {
    return db
      .prepare(`SELECT text, kind, state, source FROM preferences WHERE user_id = ? AND state = 'active' ORDER BY updated_at DESC`)
      .all(userId) as Preference[];
  },

  remove(userId: number, text: string): void {
    db.prepare(`DELETE FROM preferences WHERE user_id = ? AND text = ?`).run(userId, text);
  },
};

// --- Equipment (what the user can cook with) --------------------------------

export const equipmentRepo = {
  /** Upsert from an explicit user statement — user_confirmed always wins. */
  upsert(userId: number, item: EquipmentItem): void {
    if (!item?.name?.trim()) return;
    db.prepare(
      `INSERT INTO equipment (user_id, name, state, source, updated_at)
       VALUES (@user_id, @name, @state, 'user_confirmed', @updated_at)
       ON CONFLICT(user_id, name) DO UPDATE SET
         state = excluded.state, source = 'user_confirmed', updated_at = excluded.updated_at`
    ).run({
      user_id: userId,
      name: item.name.trim(),
      state: item.state === "absent" ? "absent" : "has",
      updated_at: now(),
    });
  },

  /** Equipment named in a saved recipe is evidence the user has it (observed);
   *  never overwrite an explicit user statement (e.g. "no oven"). */
  observeFromRecipe(userId: number, names: string[]): void {
    const stmt = db.prepare(
      `INSERT INTO equipment (user_id, name, state, source, updated_at)
       VALUES (@user_id, @name, 'has', 'observed', @updated_at)
       ON CONFLICT(user_id, name) DO UPDATE SET updated_at = excluded.updated_at
       WHERE equipment.source != 'user_confirmed'`
    );
    const tx = db.transaction(() => {
      for (const raw of names ?? []) {
        const name = String(raw ?? "").trim();
        if (name) stmt.run({ user_id: userId, name, updated_at: now() });
      }
    });
    tx();
  },

  list(userId: number): EquipmentItem[] {
    return db
      .prepare(`SELECT name, state, source FROM equipment WHERE user_id = ? ORDER BY updated_at DESC`)
      .all(userId) as EquipmentItem[];
  },

  remove(userId: number, name: string): void {
    db.prepare(`DELETE FROM equipment WHERE user_id = ? AND name = ?`).run(userId, name);
  },
};

// --- Recipes (the user's own favorite dishes) -------------------------------

const arr = (v?: string[]) => JSON.stringify(v ?? []);
const parseArr = (s: string | null): string[] => {
  try { return s ? (JSON.parse(s) as string[]) : []; } catch { return []; }
};

export const recipesRepo = {
  /** Upsert by name (re-describing the same recipe updates it). */
  save(userId: number, r: Recipe, rawText?: string): void {
    if (!r?.name?.trim()) return;
    db.prepare(
      `INSERT INTO recipes (user_id, name, method, equipment, required, helpful, optional, staples, side_dishes, substitutions, notes, raw_text, updated_at)
       VALUES (@user_id, @name, @method, @equipment, @required, @helpful, @optional, @staples, @side_dishes, @substitutions, @notes, @raw_text, @updated_at)
       ON CONFLICT(user_id, name) DO UPDATE SET
         method = excluded.method, equipment = excluded.equipment, required = excluded.required,
         helpful = excluded.helpful, optional = excluded.optional, staples = excluded.staples,
         side_dishes = excluded.side_dishes, substitutions = excluded.substitutions,
         notes = excluded.notes, raw_text = excluded.raw_text, updated_at = excluded.updated_at`
    ).run({
      user_id: userId,
      name: r.name.trim(),
      method: r.method ?? null,
      equipment: arr(r.equipment),
      required: arr(r.required),
      helpful: arr(r.helpful),
      optional: arr(r.optional),
      staples: arr(r.staples),
      side_dishes: arr(r.side_dishes),
      substitutions: arr(r.substitutions),
      notes: r.notes ?? null,
      raw_text: rawText ?? null,
      updated_at: now(),
    });
  },

  list(userId: number): Recipe[] {
    const rows = db
      .prepare(`SELECT name, method, equipment, required, helpful, optional, staples, side_dishes, substitutions, notes FROM recipes WHERE user_id = ? ORDER BY updated_at DESC`)
      .all(userId) as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      name: r.name as string,
      method: r.method ?? undefined,
      equipment: parseArr(r.equipment),
      required: parseArr(r.required),
      helpful: parseArr(r.helpful),
      optional: parseArr(r.optional),
      staples: parseArr(r.staples),
      side_dishes: parseArr(r.side_dishes),
      substitutions: parseArr(r.substitutions),
      notes: r.notes ?? undefined,
    }));
  },

  remove(userId: number, name: string): void {
    db.prepare(`DELETE FROM recipes WHERE user_id = ? AND name = ?`).run(userId, name);
  },
};
