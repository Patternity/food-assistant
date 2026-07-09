import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeBasket, extractItems, isConfigured } from "../services/assistantService.js";

// Day-1 evaluation harness (see EVALUATION.md).
//
// Runs the immediate-value pipeline (extract -> analyze) over every synthetic
// basket in data/example-baskets, WITH NO MEMORY, and prints prediction next to
// the human-judged `expect`. This validates that the assistant is useful and
// non-annoying from the very first upload, before any personalization exists.

type Fixture = {
  id: string;
  source_type: string;
  text: string;
  expect?: { basket_kind?: string; notes?: string };
};

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "example-baskets");

function loadFixtures(): Fixture[] {
  return readdirSync(dataDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dataDir, f), "utf8")) as Fixture);
}

function line(char = "─"): string {
  return char.repeat(72);
}

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.error("LLM not configured. Set LLM_API_KEY (and LLM_BASE_URL) in .env.");
    process.exit(1);
  }

  const fixtures = loadFixtures();
  console.log(`\nFood Assistant — day-1 eval (no memory)`);
  console.log(`provider=${process.env.LLM_PROVIDER || "openai-compatible"} model=${process.env.LLM_MODEL || "gpt-4o-mini"}`);
  console.log(`fixtures=${fixtures.length}  date=${new Date().toISOString()}\n`);

  let kindMatches = 0;
  let overAsking = 0;

  for (const fx of fixtures) {
    console.log(line());
    console.log(`# ${fx.id}`);
    console.log(`input: ${fx.text.replace(/\n/g, " | ")}`);
    try {
      const items = await extractItems({ text: fx.text });
      const a = await analyzeBasket(items);

      const expected = fx.expect?.basket_kind;
      const kindOk = expected ? a.basket_kind === expected : undefined;
      if (kindOk) kindMatches++;
      const qN = a.questions?.length ?? 0;
      if (qN > 1) overAsking++;

      console.log(`read:   ${items.map((i) => i.name).join(", ")}`);
      console.log(`kind:   ${a.basket_kind}${expected ? `   (expected ${expected}${kindOk ? " OK" : " <- review"})` : ""}`);
      console.log(`verdict:${wrap(a.verdict)}`);
      console.log(`dish:   ${a.dish}`);
      console.log(`buy:    ${fmtList(a.buy)}`);
      console.log(`home:   ${fmtList(a.likely_at_home)}`);
      console.log(`asks:   ${qN}${qN > 1 ? " (too many)" : ""} ${fmtList(a.questions)}`);
      if (fx.expect?.notes) console.log(`expect: ${fx.expect.notes}`);
    } catch (err) {
      console.log(`ERROR:  ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(line("═"));
  console.log(`Summary (human review still required — see EVALUATION.md):`);
  console.log(`  basket_kind matched:      ${kindMatches}/${fixtures.length}`);
  console.log(`  responses over-asking:    ${overAsking}/${fixtures.length} (target 0)`);
  console.log("");
}

function fmtList(arr?: string[]): string {
  return arr && arr.length ? arr.join(", ") : "—";
}

function wrap(s: string): string {
  return " " + (s || "").replace(/\s+/g, " ").trim();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
