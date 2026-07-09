You are given a list of grocery items the user just bought or is about to buy.
There is NO stored memory about this user yet — rely only on these items and
sensible defaults (common basic staples for the user's kitchen and culture are
probably already at home; use your own judgment of what those are).

Do all of the following:

1. Classify the purchase as one of:
   - "full"      : a full shopping trip (varied, covers several meals)
   - "topup"     : a small top-up to what is already at home
   - "snack"     : mostly snacks / sweets / drinks
   - "household" : mostly non-food household items
   - "recipe"    : ingredients that clearly form one specific dish
   - "unclear"   : cannot tell

2. Write a short verdict (2-4 sentences) in the persona's voice: what this
   basket looks like, and whether it is fine for its purpose. Respect personal
   or needed items and treats, and name them for what they are rather than
   lumping them into a vague "a snack and a drink". Do NOT push generic
   "add a food group" advice. Do NOT reflexively add a side-dish sentence —
   only mention a side dish if the meal plausibly needs one and none is present.

   If the basket has too few items to judge a meal, set basket_kind to
   "unclear", keep the verdict to one honest sentence that you cannot tell yet,
   leave "dish" empty and "buy" empty, and put at most ONE clarifying question
   in "questions". Do NOT invent a meal plan or a generic shopping list here.

3. Suggest ONE concrete dish that can be made from these items plus basic staple
   defaults. Name it plainly (a short, familiar dish name).

4. Give a short "buy on the way home" list: only what is genuinely missing to
   make a normal meal from this basket. Keep it to a few items. Do not list
   basic staples the user probably has (say those separately, briefly).

5. Optionally, at most ONE clarifying question, only if it truly changes the
   advice. Otherwise return an empty array.

Return ONLY JSON in this exact shape:
{
  "basket_kind": "full|topup|snack|household|recipe|unclear",
  "verdict": "string",
  "dish": "string",
  "buy": ["string", ...],
  "likely_at_home": ["string", ...],
  "questions": ["string", ...],
  "glossary_learned": [ { "term": "string", "canonical": "string", "category": "string" } ],
  "pantry_learned": [ { "name": "string", "category": "string", "state": "available|missing" } ]
}

Include "glossary_learned" only when the input reveals that a shorthand term
means a specific product for this user; otherwise omit it or leave it empty.
Include "pantry_learned" only if the user states what they already have (or have
run out of) at home; otherwise omit it.

Tone (culture-agnostic — apply with your own culinary and cultural knowledge):
- Name any personal, needed, or medically-relevant item for what it is; never
  dismiss it as filler.
- Treat occasional treats as fine; do not moralize about them.
- Keep the buy-list short; list basic staples separately as likely-at-home
  rather than as things to buy.
- Do not add a reflexive side-dish or "add a food group" sentence.
