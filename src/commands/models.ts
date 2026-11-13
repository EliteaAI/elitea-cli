import { parseFormat, printData } from "../output.js";
import { requireSession } from "../session.js";

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export async function modelsCommand(opts: { json?: boolean; output?: string }): Promise<void> {
  const format = parseFormat(opts);
  const { client, projectId } = await requireSession();
  const catalog = await client.getModels(projectId);
  if (format !== "text") {
    printData(format, catalog);
    return;
  }
  const width = Math.max(...catalog.items.map((m) => m.name.length), 4);
  console.log(`${"NAME".padEnd(width)}  ${"CONTEXT".padStart(7)}  ${"OUTPUT".padStart(6)}  FEATURES          DISPLAY NAME`);
  for (const m of catalog.items) {
    const tags = [m.supports_reasoning && "reasoning", m.supports_vision && "vision"].filter(Boolean).join(",");
    const role =
      m.name === catalog.default_model_name ? " [default]"
      : m.name === catalog.high_tier_default_model_name ? " [high tier]"
      : m.name === catalog.low_tier_default_model_name ? " [low tier]"
      : "";
    console.log(
      `${m.name.padEnd(width)}  ${k(m.context_window).padStart(7)}  ${k(m.max_output_tokens).padStart(6)}  ${tags.padEnd(16)}  ${m.display_name}${role}`,
    );
  }
}
