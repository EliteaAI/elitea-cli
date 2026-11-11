import { requireSession } from "../session.js";

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export async function modelsCommand(opts: { json?: boolean }): Promise<void> {
  const { client, projectId } = await requireSession();
  const catalog = await client.getModels(projectId);
  if (opts.json) {
    console.log(JSON.stringify(catalog, null, 2));
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
