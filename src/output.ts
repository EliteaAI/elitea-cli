import { stringify } from "yaml";
import { usageError } from "./errors.js";

export type OutputFormat = "text" | "json" | "yaml";

const FORMATS: OutputFormat[] = ["text", "json", "yaml"];

/** `-o` value; the older `--json` flag still means json. */
export function parseFormat(opts: { output?: string; json?: boolean }): OutputFormat {
  if (opts.json && (opts.output === undefined || opts.output === "json")) return "json";
  const value = opts.output ?? "text";
  if (!FORMATS.includes(value as OutputFormat)) throw usageError(`--output must be one of ${FORMATS.join(", ")}, got "${value}"`);
  if (opts.json) throw usageError(`--json conflicts with --output ${value}`);
  return value as OutputFormat;
}

/** Machine-readable data on stdout. */
export function printData(format: "json" | "yaml", data: unknown): void {
  if (format === "json") console.log(JSON.stringify(data, null, 2));
  else process.stdout.write(stringify(data, { lineWidth: 0 }));
}

/** Fixed-width table; the last column is cut to fit `columns`. */
export function formatTable(header: string[], rows: string[][], columns = 120): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const lead = (cells: string[]) => cells.slice(0, -1).map((c, i) => c.padEnd(widths[i]!)).join("  ") + "  ";
  const room = Math.max(columns - lead(header).length, 10);
  const fit = (s: string) => (s.length > room ? `${s.slice(0, room - 1)}…` : s);
  return [header, ...rows].map((cells) => (lead(cells) + fit(cells[cells.length - 1] ?? "")).trimEnd());
}
