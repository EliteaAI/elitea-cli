import { stringify } from "yaml";
import { ctx } from "./context.js";
import { usageError } from "./errors.js";

/** `text` is the table/plain view; `-o table` is the same as `-o text`. */
export type OutputFormat = "text" | "json" | "yaml";

export const OUTPUT_VALUES = ["table", "json", "yaml"] as const;

function normalize(value: string, source: string): OutputFormat {
  const v = value.trim().toLowerCase();
  if (v === "table" || v === "text") return "text";
  if (v === "json" || v === "yaml") return v;
  throw usageError(`${source} must be one of ${OUTPUT_VALUES.join(", ")}, got "${value}"`);
}

/**
 * The default format of commands added from story 02 on (AC-6a): ELITEA_CLI_OUTPUT, then
 * `settings.output`, then table. Commands that existed before keep their text default.
 */
export function defaultFormat(): OutputFormat {
  const env = process.env.ELITEA_CLI_OUTPUT;
  if (env) return normalize(env, "ELITEA_CLI_OUTPUT");
  const setting = ctx.settings.output;
  if (typeof setting === "string" && setting) return normalize(setting, "settings.output in the config");
  return "text";
}

/**
 * `-o` value; the older `--json` flag still means json. `useDefaults` (new commands only) lets
 * ELITEA_CLI_OUTPUT and `config output` choose when `-o` is not given.
 */
export function parseFormat(opts: { output?: string; json?: boolean }, useDefaults = false): OutputFormat {
  if (opts.json && (opts.output === undefined || normalize(opts.output, "--output") === "json")) return "json";
  if (opts.json) throw usageError(`--json conflicts with --output ${opts.output}`);
  if (opts.output !== undefined) return normalize(opts.output, "--output");
  return useDefaults ? defaultFormat() : "text";
}

/** Machine-readable data on stdout: one JSON document, or YAML. */
export function printData(format: "json" | "yaml", data: unknown): void {
  if (format === "json") console.log(JSON.stringify(data, null, 2));
  else process.stdout.write(stringify(data, { lineWidth: 0 }));
}

/** `-q`: only the primary id (AC-5). Returns true when it printed, so callers can stop. */
export function printQuiet(id: string | number | undefined): boolean {
  if (!ctx.quiet || id === undefined) return false;
  console.log(String(id));
  return true;
}

/** Fixed-width table; the last column is cut to fit `columns`. */
export function formatTable(header: string[], rows: string[][], columns = 120): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const lead = (cells: string[]) => cells.slice(0, -1).map((c, i) => c.padEnd(widths[i]!)).join("  ") + "  ";
  const room = Math.max(columns - lead(header).length, 10);
  const fit = (s: string) => (s.length > room ? `${s.slice(0, room - 1)}…` : s);
  return [header, ...rows].map((cells) => (lead(cells) + fit(cells[cells.length - 1] ?? "")).trimEnd());
}

export interface Column<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/**
 * The shared list renderer for new commands (AC-1, AC-6): a table, or the rows as one JSON/YAML
 * document. No rows: "No <items> found" on stderr in table mode, `[]` otherwise.
 */
export function render<T>(rows: T[], columns: Column<T>[], format: OutputFormat, items: string): void {
  if (format !== "text") {
    printData(format, rows);
    return;
  }
  if (rows.length === 0) {
    console.error(`No ${items} found`);
    return;
  }
  const cells = rows.map((r) => columns.map((c) => String(c.value(r) ?? "").replace(/\s+/g, " ").trim()));
  for (const line of formatTable(columns.map((c) => c.header), cells, process.stdout.columns)) console.log(line);
}
