// Personal recipes: the user's own favorite dishes, described in natural
// language and stored as structure. Saved recipes are injected as context so the
// assistant can (a) recognize that a basket is probably for one of them, and
// (b) prefer the user's own recipes when suggesting what to cook.

export type Recipe = {
  name: string;
  method?: string;
  equipment?: string[];
  required?: string[];
  helpful?: string[];
  optional?: string[];
  staples?: string[];
  side_dishes?: string[];
  substitutions?: string[];
  notes?: string;
};

/** Compact prompt block listing the user's saved recipes. "" if none. */
export function recipesDirective(recipes?: Recipe[]): string {
  const rs = (recipes ?? []).filter((r) => r?.name);
  if (!rs.length) return "";
  const lines = rs.map((r) => {
    const need = (r.required ?? []).join(", ");
    const equip = r.equipment?.length ? ` [${r.equipment.join(", ")}]` : "";
    return `- ${r.name}${need ? `: needs ${need}` : ""}${equip}`;
  });
  return [
    "",
    "",
    "SAVED RECIPES (the user's own favorites):",
    ...lines,
    "If the current basket or request plausibly matches one of these, you MAY note",
    "it naturally (e.g. this looks like it is for the user's usual <name>). Prefer",
    "the user's own recipes when suggesting what to cook. Don't force a match.",
  ].join("\n");
}
