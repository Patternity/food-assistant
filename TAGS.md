# Interest & session tags

The assistant emits **neutral tags** instead of selecting ads. It never sees
offers; the orchestrator (bot/app) maps tags to whatever it wants — ads,
personalization, analytics. This keeps the assistant a neutral food core with no
monetization logic inside it.

## The tag object

Every answer from `/api/analyze`, `/api/ask`, `/api/chat`, `/api/message`
includes:

```json
"tags": {
  "interests": ["vegetable", "grain", "dairy"],
  "session":   ["meat", "grain", "dinner", "quick"],
  "excluded":  ["alcohol", "tobacco"]
}
```

- **interests** — durable portrait, from the pantry (what's usually at home).
  Category codes only. Deterministic; no LLM.
- **session** — what this answer is about: the categories present in it **plus**
  descriptor tags the model chose from the vocabulary (see below).
- **excluded** — always-prohibited categories (safety). The orchestrator layers
  its own per-user exclusions (e.g. from `state.preferences`) on top.

`GET /api/tags` returns the durable portrait alone (`session` empty), no LLM.

## Two tag layers

1. **Structural categories** — `meat | fish | vegetable | fruit | dairy | grain |
   bread | drink | water | sweet | snack | household | condiment | other`.
   Code-owned backbone (also used by extraction/pantry). Always valid; **not
   editable**.
2. **Descriptor tags** — an abstract, culture-agnostic vocabulary (e.g.
   `dinner`, `quick`, `low-sugar`, `batch-cook`). The operator manages it at
   runtime, and the model may emit **only** tags from it (anything else is
   filtered out server-side, so the contract always holds).

## Managing the vocabulary (admin)

The orchestrator is the source of truth: it both **sets** the vocabulary and
**consumes** the tags, so the two stay consistent.

- `GET /api/tags/vocabulary` → `{ "vocabulary": ["dinner", "quick", ...] }`
- `PUT /api/tags/vocabulary` with `{ "vocabulary": [...] }` → replaces it.
  Values are lowercased, trimmed, deduped, and capped (≤100 tags, ≤40 chars
  each). Returns the stored list.

Both sit under the service-token guard; the bot decides who is an admin. The
seed vocabulary applies until the first `PUT`.
