import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { GlossaryEntry } from "./glossary.js";
import type { PantryItem } from "./pantry.js";
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
`);

const now = () => new Date().toISOString();

// --- Purchases (history) ----------------------------------------------------

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
      `INSERT INTO purchase_items (purchase_id, user_id, name, category, qty, unit)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      const res = insertPurchase.run(userId, now(), meta.source_type ?? null, meta.basket_kind ?? null, meta.raw_text ?? null);
      const purchaseId = Number(res.lastInsertRowid);
      for (const it of items) {
        insertItem.run(purchaseId, userId, it.name, it.category ?? null, it.qty ?? null, it.unit ?? null);
      }
      return purchaseId;
    });
    return tx();
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
      `INSERT INTO pantry (user_id, name, category, state, source, confidence, updated_at)
       VALUES (@user_id, @name, @category, @state, @source, @confidence, @updated_at)
       ON CONFLICT(user_id, name) DO UPDATE SET
         category = excluded.category,
         state = excluded.state,
         source = excluded.source,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at`
    ).run({
      user_id: userId,
      name: item.name.trim(),
      category: item.category ?? null,
      state: item.state === "missing" ? "missing" : "available",
      source: item.source ?? "user_confirmed",
      confidence: item.confidence ?? "high",
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
      `INSERT INTO pantry (user_id, name, category, state, source, confidence, updated_at)
       VALUES (@user_id, @name, @category, 'available', 'observed', 'low', @updated_at)
       ON CONFLICT(user_id, name) DO UPDATE SET
         category = excluded.category,
         state = 'available',
         updated_at = excluded.updated_at
       WHERE pantry.source != 'user_confirmed'`
    );
    const tx = db.transaction(() => {
      for (const it of items) {
        if (!it?.name?.trim()) continue;
        stmt.run({ user_id: userId, name: it.name.trim(), category: it.category ?? null, updated_at: now() });
      }
    });
    tx();
  },

  /** Items currently believed to be at home (state = available). */
  list(userId: number): PantryItem[] {
    return db
      .prepare(`SELECT name, category, state, source, confidence, updated_at FROM pantry WHERE user_id = ? AND state = 'available' ORDER BY updated_at DESC`)
      .all(userId) as PantryItem[];
  },

  remove(userId: number, name: string): void {
    db.prepare(`DELETE FROM pantry WHERE user_id = ? AND name = ?`).run(userId, name);
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
        `SELECT pi.name AS name, p.ts AS ts
         FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
         WHERE pi.user_id = ? ORDER BY p.ts ASC`
      )
      .all(userId) as Array<{ name: string; ts: string }>;

    // Group by a normalized name so slight label variations still line up.
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
