/**
 * Standalone smoke test for the data sources - run with:
 *   bun scripts/check.ts [--json]
 *
 * Prints usage for Codex / Claude / GLM based on local credentials.
 * Never prints tokens.
 */

import { queryClaude } from "../src/sources/claude";
import { queryCodex } from "../src/sources/codex";
import { queryGlm } from "../src/sources/glm";
import { renderBar } from "../src/format";

const asJson = process.argv.includes("--json");

const results = await Promise.allSettled([queryCodex(), queryClaude(), queryGlm()]);
const names = ["Codex", "Claude", "GLM"] as const;

for (const [index, settled] of results.entries()) {
  const name = names[index]!;
  if (settled.status === "rejected") {
    console.log(`${name}: CRASH ${settled.reason instanceof Error ? settled.reason.message : settled.reason}`);
    continue;
  }
  const result = settled.value;
  if (asJson) {
    console.log(name, JSON.stringify(result));
    continue;
  }
  if (result.ok) {
    const plan = result.plan ? ` (${result.plan})` : "";
    console.log(`${name}${plan}:`);
    for (const window of result.windows) {
      const pct = `${Math.round(window.usedPct)}%`;
      console.log(`  ${window.label.padEnd(4)} ${renderBar(window.usedPct, 12)} ${pct}`);
    }
  } else {
    console.log(`${name}: ${result.kind.toUpperCase()} - ${result.message}`);
  }
}
