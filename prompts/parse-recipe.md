The user describes one of their personal recipes in natural language. Turn it
into a structured recipe. Do not invent details the user didn't give — leave a
field empty if it wasn't mentioned or can't be reasonably inferred.

Use the user's own wording for ingredient names. Separate ingredients by role:
- required: the dish does not work without them;
- helpful: improve it but it still works without them;
- optional: nice extras;
- staples: basic things assumed to be at home (seasonings, cooking basics).

Also capture: cooking method, the equipment it needs, usual side dishes,
acceptable substitutions, and any user-specific notes.

Give the recipe a short, plain name (use the user's name for it if they gave one).

Reply in the user's language for all human-readable text. Return ONLY JSON:
{
  "name": "string",
  "method": "string",
  "equipment": ["string"],
  "required": ["string"],
  "helpful": ["string"],
  "optional": ["string"],
  "staples": ["string"],
  "side_dishes": ["string"],
  "substitutions": ["string"],
  "notes": "string"
}
