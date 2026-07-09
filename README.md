# Food Assistant — Research Prototype

A source-available research prototype by [Patternity](https://github.com/Patternity)
for studying household food-consumption patterns from sparse multimodal inputs
(basket screenshots, receipts, notes, recipes) and lightweight user corrections.

This repository contains the **local single-user alpha / playground** used to
validate the product concept and to run reproducible experiments. It is not the
commercial product. See [Two Tracks](#two-tracks) below.

---

## Licensing at a glance

This project is **source-available, not OSI-style open source.**

- The source is public for **transparency, research, learning, review, and
  non-commercial experimentation.**
- It is licensed under the **PolyForm Noncommercial License 1.0.0**
  (see [`LICENSE`](./LICENSE)).
- **This is NOT MIT/Apache/GPL/AGPL.** It does **not** grant permissive or
  copyleft open-source rights.
- **Commercial use is not permitted under the public license.** Hosted services,
  resale, paid integrations, use inside commercial products, or any use with an
  anticipated commercial application require a **separate commercial license from
  Patternity.** See [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md).
- Code availability does **not** grant trademark or branding rights. See
  [`TRADEMARKS.md`](./TRADEMARKS.md).

> Not legal advice. The license files describe intent in practical terms; the
> authoritative text is [`LICENSE`](./LICENSE), and final terms should be
> reviewed by a legal professional before any serious commercial launch.

---

## What this prototype does

The assistant delivers value in **two layers**:

**Immediate value (works on the very first upload, with no memory):**

- evaluate an uploaded basket / receipt / text list;
- classify the purchase: `full` shopping trip, `topup`, `snack`, `household`,
  `recipe`, or `unclear`;
- suggest what can be cooked from it;
- suggest what is missing for a practical meal;
- suggest a short "what to buy on the way home" list;
- ask at most 1–2 lightweight clarifying questions.

**Accumulated value (retention layer, studied but intentionally minimal here):**

- purchase cadence vs. consumption speed;
- probabilistic pantry inference;
- correction-based memory (`still have`, `already consumed`, `don't suggest`, …);
- user-specific recipes and kitchen-equipment awareness.

This alpha focuses on making the **immediate layer** strong and measurable. The
accumulated layer is scoped in [`RESEARCH.md`](./RESEARCH.md) and evaluated per
[`EVALUATION.md`](./EVALUATION.md).

---

## Design principles

- The assistant is useful from a **single uploaded basket** — no long setup, no
  manually maintained digital pantry, no onboarding form.
- Memory is a **by-product of useful actions**, not a task for the user.
- Communicate **uncertainty in words**, never as raw numbers.
- **Do not moralize** on a single basket; guardrails act on repeated patterns.
- The LLM owns reasoning; code owns memory and rules.
- Provider-agnostic: the LLM backend is pluggable (any OpenAI-compatible
  aggregator today; other providers later).

---

## Quick start

Requirements: Node.js 20+, and an OpenAI-compatible API key (direct or via an
aggregator/gateway).

```bash
cp .env.example .env      # then fill in LLM_API_KEY and LLM_BASE_URL
npm install
npm run dev               # serves the local web UI on http://localhost:3000
```

Open <http://localhost:3000>, upload a basket screenshot or paste a text list,
and try the quick actions: **Check basket**, **What can I cook?**,
**What to buy on the way home?**

Run the day-1 evaluation harness over the bundled anonymized baskets:

```bash
npm run eval              # prints basket_kind / dish / buy-list / tone per fixture
```

See [`EVALUATION.md`](./EVALUATION.md) for what the harness measures and why.

---

## Repository layout

```
prompts/               Prompt modules (persona + per-task), versioned as text
src/llm/               Pluggable LLM provider abstraction
src/services/          Domain primitives (extract, eval, cook, buy)
src/controllers/       Use-case orchestration
src/eval/              Day-1 evaluation harness
public/                Single-page local web UI
data/example-baskets/  Anonymized demo baskets (synthetic, non-personal)
```

---

## Two tracks

This repository is the **research track**: public, transparent, non-commercial,
suitable for research framing, grant/credit applications, community review, and
reproducible experiments.

The **commercial track** — production service, Telegram-bot module,
subscriptions, billing, multi-user logic, hosted deployment — lives in a
**separate private repository** and is a proprietary Patternity product. Nothing
in this repository grants rights to that product or to commercial use of this
code. See [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md).

---

## Documents

- [`LICENSE`](./LICENSE) — PolyForm Noncommercial License 1.0.0
- [`RESEARCH.md`](./RESEARCH.md) — research question, method, scope
- [`EVALUATION.md`](./EVALUATION.md) — how the prototype is measured
- [`PRIVACY.md`](./PRIVACY.md) — data handling for the local alpha
- [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md) — what commercial use means, how to license it
- [`TRADEMARKS.md`](./TRADEMARKS.md) — name/branding boundaries
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution terms (inbound license)

---

© Patternity. Source-available under PolyForm Noncommercial 1.0.0.
Commercial rights reserved.
