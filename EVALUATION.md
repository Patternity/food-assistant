# Evaluation

This document defines how the prototype is measured. Metrics double as product
KPIs (is the assistant useful and non-annoying?) and research evaluation (does it
infer useful patterns responsibly?).

## What the day-1 harness checks

`npm run eval` runs the immediate-value pipeline over every basket in
`data/example-baskets/` **with no memory** and prints, per basket:

- `basket_kind` — predicted purchase type (`full` / `topup` / `snack` /
  `household` / `recipe` / `unclear`);
- `dish` — the concrete meal suggested from the basket;
- `buy` — the short "what to buy on the way home" list;
- `questions` — clarifying questions asked (target: 0–1);
- `verdict` — the one-paragraph evaluation shown to the user.

Each fixture carries an `expect` block (expected `basket_kind` and notes) so
runs can be compared by hand. This is intentionally a human-judged harness, not
an automated pass/fail gate — the object under study is response quality and
tone, which are not reducible to string matching at this stage.

## Immediate-layer metrics

| Metric | Definition | Target (alpha) |
|---|---|---|
| Purchase-type accuracy | correct `basket_kind` vs. `expect` | high on clear cases |
| Meal usefulness | is the dish cookable from the basket + safe pantry defaults? | judged 1–5 |
| Missing-items usefulness | is the buy-list short and practical (not generic)? | ≤ 3 items typical |
| Question restraint | clarifying questions per response | ≤ 1 |
| Response length | verdict stays concise | 2–4 sentences |
| Tone: non-annoying | no nagging, no unsolicited advice | judged pass/fail |
| Tone: non-moralizing | no shaming on a single basket | judged pass/fail |

## Accumulated-layer metrics (later)

Measured once memory is enabled, over repeated interactions:

- extraction precision/recall and manual-correction rate;
- cadence prediction error (was "time to restock" right?);
- pantry-inference accuracy, checked post-hoc against `still have` /
  `already consumed` corrections;
- corrections-to-stable-profile (how many corrections until answers stabilize);
- guardrail false-positive rate (moralizing when it should not).

## Uncertainty communication check

Verify the mapping from internal pantry state to user-facing language:

| Internal state | Acceptable phrasing |
|---|---|
| `confirmed_available` | "you have …" |
| `likely_available` | "you probably have …" |
| `maybe_available` | "you might still have …" / "if you haven't used it yet" |
| `likely_consumed` / `likely_expired` | "that's probably gone by now" |
| `unknown` | omit, or ask once |

Numbers (confidence scores) must not appear in user-facing text.

## Responsible-recommendation check

Guardrails must not fire on a single basket. They may add **one** neutral,
non-shaming note only when repeated baskets contain no base food. See
[`RESEARCH.md`](./RESEARCH.md) and the persona prompt in `prompts/persona.md`.

## Reproducibility notes

Record, per evaluation run: provider, model id, prompt version (git commit), and
date. Because model backends change, comparisons are only valid against a pinned
model id.
