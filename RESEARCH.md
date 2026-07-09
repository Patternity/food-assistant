# Research Framing

This document states the research framing for the Food Assistant prototype under
Patternity. The framing strengthens the design and evaluation; it does not
replace the product. The product goal is a practical, commercial assistant.

## Research question

> Can a multimodal AI assistant infer useful household food-consumption patterns
> from grocery basket screenshots, receipts, purchase history, recipes, and
> lightweight user feedback, while giving practical recommendations without being
> intrusive, overconfident, or moralizing?

## Relation to Patternity

Patternity studies how repeated behavior over time becomes a meaningful signal.
Baskets, receipts, corrections, recipe descriptions, restock confirmations, and
consumption/attribution labels are everyday behavioral events. Each event is an
edge in a per-user behavioral pattern graph; the product value is the mapping
from that graph to practical decisions (what to buy, what not to buy, what to
cook, what may spoil, what is likely already at home).

This prototype departs from Patternity's protocol/consensus focus in that it is
an explicit consumer-product experiment. It is positioned as a research
prototype and alpha playground, kept in a dedicated repository and under a
source-available non-commercial license, so the commercial track can proceed
separately.

## Two value layers (studied separately)

1. **Immediate layer** — value available on the first upload with no memory:
   basket evaluation, purchase-type classification, meal ideas, missing-item and
   "what to buy" suggestions. Primary object of study in this alpha.
2. **Accumulated layer** — value that emerges from repeated use: purchase
   cadence, consumption speed, probabilistic pantry state, correction-based
   memory, recipe and equipment awareness. Studied as the retention/personal-
   ization mechanism.

## Research aspects

- multimodal extraction from basket screenshots and receipts;
- behavioral pattern detection from repeated purchases;
- distinguishing **consumption speed** from **purchase cadence**;
- probabilistic pantry inference (state with uncertainty, not inventory truth);
- lightweight correction-based memory;
- user-specific recipe matching;
- kitchen-equipment awareness;
- uncertainty communication in natural language;
- responsible food-related recommendations;
- avoiding both generic advice and harmful personalization.

## Key modeling commitments

- **Consumption speed ≠ purchase cadence.** Modeled as distinct fields. Fast
  post-purchase consumption does not imply frequent restock (e.g. a one-time
  treat bought rarely but finished the same evening).
- **Pantry state is probabilistic**, expressed as `likely_available`,
  `maybe_available`, `likely_consumed`, `likely_expired`, `unknown`,
  `confirmed_available`, `confirmed_missing` — never as absolute inventory.
- **Corrections outrank inferences:** `user_confirmed` > `observed` > `default`.

## Non-goals

- Not a dietician or strict healthy-eating system.
- No calorie/macro tracking, no barcode/product-catalog dependency.
- No exact inventory tracking.
- The prototype does not claim clinical, nutritional, or medical validity.

## Reproducibility

Prompts are stored as versioned text under `prompts/`. The evaluation harness
(`src/eval/`) runs over bundled synthetic baskets in `data/example-baskets/`.
Model provider and model id are configured via environment variables so runs can
be reproduced against a pinned model. See [`EVALUATION.md`](./EVALUATION.md).
