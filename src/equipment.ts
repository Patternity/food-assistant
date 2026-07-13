// Kitchen equipment memory: what the user can actually cook with. Collected
// unobtrusively — from what the user states ("нет духовки", "у меня
// пароконвектомат") and from the equipment named in their saved recipes — never
// via a form. Injected as context so the assistant never suggests a dish that
// needs equipment the user doesn't have. We keep equipment as free-text names in
// the user's own words (culture-agnostic) and let the LLM reason about what each
// piece enables, rather than hardcoding a capability taxonomy.

export type EquipmentItem = {
  name: string;
  state?: "has" | "absent"; // default "has"
  source?: "user_confirmed" | "observed";
  updated_at?: string;
};

/** Prompt block describing the user's kitchen equipment. "" if empty. */
export function equipmentDirective(equipment?: EquipmentItem[]): string {
  const items = equipment ?? [];
  const has = items.filter((e) => e.name && (e.state ?? "has") === "has");
  const absent = items.filter((e) => e.name && e.state === "absent");
  if (!has.length && !absent.length) return "";
  const lines: string[] = ["", "", "KITCHEN EQUIPMENT (what the user can cook with):"];
  if (has.length) lines.push(`- available: ${has.map((e) => e.name).join(", ")}`);
  if (absent.length) lines.push(`- NOT available: ${absent.map((e) => e.name).join(", ")}`);
  lines.push(
    "Never suggest a dish or method that requires equipment the user does not",
    "have. Prefer methods the available equipment supports. Use your own knowledge",
    "of what each piece of equipment can do."
  );
  return lines.join("\n");
}
