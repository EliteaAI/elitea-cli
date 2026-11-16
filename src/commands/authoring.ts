import { confirm } from "@inquirer/prompts";
import { readFile } from "node:fs/promises";
import { stringify } from "yaml";
import {
  NotSentError,
  REPLACE_HINT,
  changedFields,
  checkPipelineYaml,
  createBody,
  editableView,
  formatValidation,
  isFixable,
  newVersionBody,
  parseDocument,
  toolsNote,
  unifiedDiff,
  updateBody,
  versionCreateHint,
  writeRefusal,
} from "../authoring.js";
import { ctx } from "../context.js";
import { createTempFile, editFile, removeTempFile } from "../editor.js";
import type { AgentVersion, AgentVersionSummary, EliteaAgent, EliteaAgentDetails, EliteaClient } from "../elitea.js";
import { CliError, EXIT, needsTerminal, notFoundError, usageError } from "../errors.js";
import { confirmDestructive, readStdin } from "../interaction.js";
import { findModel } from "../models.js";
import { type OutputFormat, parseFormat, printData, printQuiet } from "../output.js";
import { type ItemKind, isPipeline, resolveAgent, resolveVersion } from "../resolve.js";
import { isInteractive } from "../session.js";
import { projectSession } from "./common.js";

type Doc = Record<string, unknown>;

export interface AuthoringOptions {
  file?: string;
  yaml?: string;
  name?: string;
  model?: string;
  description?: string;
  agentVersion?: string;
  from?: string;
  replaceWith?: string;
  dryRun?: boolean;
  yes?: boolean;
  project?: string;
  output?: string;
  json?: boolean;
}

const label = (a: Pick<EliteaAgent, "agent_type">) => (isPipeline(a) ? "pipeline" : "agent");

/** `-f <path>` / `--yaml <path>`; `-` reads stdin. Unreadable → exit 2. */
async function readSource(path: string, option: string): Promise<string> {
  try {
    return path === "-" ? await readStdin(`${option} -`) : await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw usageError(`Cannot read ${path}: ${(err as Error).message}`);
  }
}

const sourceName = (path: string) => (path === "-" ? "stdin" : path);

/** Output of a write: -q the id, -o json|yaml the object, else the sentence. */
function report(format: OutputFormat, data: unknown, id: number | undefined, sentence: string): void {
  if (printQuiet(id)) return;
  if (format !== "text") printData(format, data);
  else console.log(sentence);
}

/** The item, its versions and one version summary (`--agent-version`, else the default). */
async function target(kind: ItemKind, query: string, opts: AuthoringOptions, verb: string) {
  const { client, projectId } = await projectSession(opts.project);
  const { agent } = await resolveAgent(client, projectId, query, kind, `elitea-cli ${kind}s ${verb} <${kind}>`);
  const details = await client.getAgent(projectId, agent.id);
  return { client, projectId, agent, details };
}

const where = (details: EliteaAgentDetails, version: { name: string }) => `${details.name}/${version.name}`;

// ---------------------------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------------------------

/** The model named by --model as llm_settings; an unknown model exits 5. */
async function modelSettings(client: EliteaClient, projectId: number, name: string): Promise<Doc> {
  const model = findModel(await client.getModels(projectId), name);
  if (!model) throw notFoundError(`No model "${name}" in project ${projectId} — run \`elitea-cli models\``);
  return { model_name: model.name, model_project_id: model.project_id };
}

/** `pipelines create --name --yaml [--model] [--description]` (AC-3): no file needed. */
async function pipelineFromFlags(client: EliteaClient, projectId: number, opts: AuthoringOptions): Promise<Doc> {
  if (opts.name === undefined) throw usageError("--yaml needs --name: elitea-cli pipelines create --name <name> --yaml <file>");
  if (opts.yaml === undefined) throw usageError("--name needs --yaml: elitea-cli pipelines create --name <name> --yaml <file>");
  const yaml = await readSource(opts.yaml, "--yaml");
  checkPipelineYaml(yaml, sourceName(opts.yaml));
  return {
    name: opts.name,
    ...(opts.description === undefined ? {} : { description: opts.description }),
    versions: [
      {
        name: "base",
        agent_type: "pipeline",
        instructions: yaml,
        // Required by the platform; without a model_name the project's default model applies.
        llm_settings: opts.model === undefined ? {} : await modelSettings(client, projectId, opts.model),
      },
    ],
  };
}

/** Exact, case-sensitive name match among all agents and pipelines; best-effort (AC-7). */
async function sameName(client: EliteaClient, projectId: number, name: unknown): Promise<EliteaAgent | undefined> {
  if (typeof name !== "string" || !name) return undefined;
  try {
    return (await client.listAgents(projectId, { type: "all", query: name })).find((a) => a.name === name);
  } catch {
    return undefined;
  }
}

/** `agents create` / `pipelines create` (AC-1…AC-7). */
export async function createCommand(kind: ItemKind, opts: AuthoringOptions): Promise<void> {
  const format = parseFormat(opts);
  const flags = opts.name !== undefined || opts.yaml !== undefined;
  if (kind === "pipeline" && flags && opts.file !== undefined) throw usageError("Give -f <file>, or --name and --yaml, not both");
  if (kind === "pipeline" && !flags && (opts.model !== undefined || opts.description !== undefined)) {
    throw usageError("--model and --description go with --name and --yaml; in a file, set them in the file");
  }
  if (!flags && opts.file === undefined) {
    throw usageError(
      kind === "pipeline"
        ? "Give the pipeline as -f <file> or --name <name> --yaml <file>"
        : "Give the agent as a JSON or YAML file: elitea-cli agents create -f <file>",
    );
  }
  // The file is read and checked before any request (AC-5).
  const doc = opts.file === undefined ? undefined : parseDocument(await readSource(opts.file, "-f"), sourceName(opts.file));
  const { client, projectId } = await projectSession(opts.project);
  const body = doc ? createBody(doc, kind) : await pipelineFromFlags(client, projectId, opts);

  const existing = await sameName(client, projectId, body.name);
  let created;
  try {
    created = await client.createApplication(projectId, body);
  } catch (err) {
    throw writeRefusal(err);
  }
  const version = created.version_details;
  const what = label({ agent_type: version?.agent_type ?? created.agent_type });
  if (existing) console.error(`Another ${label(existing)} named "${existing.name}" already exists (${existing.id})`);
  report(format, created, created.id, `Created ${what} "${created.name}" (${created.id}), version ${version?.name ?? "base"} (${version?.id ?? "?"})`);
}

// ---------------------------------------------------------------------------------------------
// update / edit
// ---------------------------------------------------------------------------------------------

/**
 * AC-22: the version must still have the instructions it had when it was read. The PUT itself does
 * not compare them, so this re-read is the only guard. Changed: ask (--yes overwrites); no or no
 * terminal → exit 6, nothing sent.
 */
async function ensureUnchanged(
  client: EliteaClient,
  projectId: number,
  details: EliteaAgentDetails,
  version: AgentVersionSummary,
  sha: string | undefined,
): Promise<void> {
  if (sha === undefined) return;
  const now = await client.getVersion(projectId, details.id, version.id);
  if (now.instructions_sha256 === undefined || now.instructions_sha256 === sha) return;
  const message = `${where(details, version)} was changed on the server since you opened it`;
  if (ctx.yes) return;
  if (!isInteractive()) throw new NotSentError(`${message}; nothing sent (--yes overwrites)`);
  if (!(await confirm({ message: `${message}. Overwrite?`, default: false }))) throw new NotSentError("Nothing sent");
}

/** PUT the changes; refusals become the platform's text and the right hint (AC-13). */
async function sendUpdate(
  client: EliteaClient,
  projectId: number,
  kind: ItemKind,
  details: EliteaAgentDetails,
  version: AgentVersionSummary,
  current: AgentVersion,
  changes: Doc,
): Promise<AgentVersion> {
  const body = updateBody({ name: current.name, agent_type: current.agent_type }, editableView(current as Doc), changes);
  try {
    return await client.updateVersion(projectId, details.id, version.id, body);
  } catch (err) {
    throw writeRefusal(err, { notUpdatable: versionCreateHint(kind) });
  }
}

const asYaml = (value: unknown) => stringify(value, { lineWidth: 0 });

/** `agents update` / `pipelines update` (AC-8…AC-9, AC-13, AC-14, AC-22). */
export async function updateCommand(kind: ItemKind, query: string, opts: AuthoringOptions): Promise<void> {
  const format = parseFormat(opts);
  if ((opts.file === undefined) === (opts.yaml === undefined)) {
    throw usageError(kind === "pipeline" ? "Give -f <version file> or --yaml <pipeline.yaml>" : "Give the version file with -f <file>");
  }
  // Read and check the file before contacting EliteA (AC-5).
  const text = await readSource((opts.file ?? opts.yaml)!, opts.file !== undefined ? "-f" : "--yaml");
  const source = sourceName((opts.file ?? opts.yaml)!);
  const doc = opts.file !== undefined ? parseDocument(text, source) : undefined;
  if (doc === undefined) checkPipelineYaml(text, source);

  const { client, projectId, details } = await target(kind, query, opts, "update");
  const summary = resolveVersion(details, opts.agentVersion);
  const current = await client.getVersion(projectId, details.id, summary.id);
  const currentView = editableView(current as Doc);

  let changes: Doc;
  if (doc) {
    const note = toolsNote(doc.tools, current.tools, kind);
    if (note) console.error(note);
    if (typeof doc.name === "string" && doc.name !== current.name) {
      console.error(`The file names version "${doc.name}"; ${where(details, summary)} is updated and keeps its name`);
    }
    changes = changedFields(currentView, editableView(doc));
  } else {
    // AC-9: only the pipeline YAML of the version.
    changes = text === (current.instructions ?? "") ? {} : { instructions: text };
  }

  if (opts.dryRun) {
    const diff = unifiedDiff(asYaml(currentView), asYaml({ ...currentView, ...changes }), `${where(details, summary)} (EliteA)`, source);
    if (diff) process.stdout.write(diff);
    else console.error("No changes");
    return;
  }
  if (Object.keys(changes).length === 0) {
    console.error("No changes");
    return;
  }
  await ensureUnchanged(client, projectId, details, summary, current.instructions_sha256);
  const updated = await sendUpdate(client, projectId, kind, details, summary, current, changes);
  report(format, updated, updated.id ?? summary.id, `Updated ${where(details, summary)}`);
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";

/** What `edit` opens: the version as YAML (agents), or only the pipeline YAML (pipelines). */
function editorText(kind: ItemKind, details: EliteaAgentDetails, current: AgentVersion): string {
  if (kind === "pipeline") return current.instructions ?? "";
  const header = [
    `# ${label(current)} "${details.name}" (${details.id}), version ${current.name} (${current.id}).`,
    "# Save and close to update it; close without changes to cancel. Fields you delete keep their value.",
    "# Toolkits are not listed here: use `elitea-cli agents toolkits add|remove`.",
  ];
  return `${header.join("\n")}\n${asYaml(editableView(current as Doc))}`;
}

/**
 * `agents edit` / `pipelines edit` (AC-10…AC-12, AC-22): the version in $VISUAL/$EDITOR, sent on
 * save. A refusal the user can fix asks "Edit again?"; on no, the edits stay in the temp file.
 */
export async function editCommand(kind: ItemKind, query: string, opts: AuthoringOptions, run?: (path: string) => Promise<number>): Promise<void> {
  const format = parseFormat(opts);
  if (!isInteractive()) {
    throw needsTerminal(`elitea-cli ${kind}s edit`, `use \`elitea-cli ${kind}s update -f <file>\`${kind === "pipeline" ? " or `--yaml <file>`" : ""}`);
  }
  const { client, projectId, details } = await target(kind, query, opts, "edit");
  const summary = resolveVersion(details, opts.agentVersion);
  const current = await client.getVersion(projectId, details.id, summary.id);
  const original = editorText(kind, details, current);
  const path = await createTempFile(`${slug(details.name)}-${slug(current.name)}.yaml`, original);
  // An unexpected failure (network, 403) keeps the file, so edits are never lost silently.
  const keep = () => console.error(`Your edits are kept in ${path} (delete it when done)`);

  for (let round = 0; ; round++) {
    let text: string;
    try {
      text = await editFile(path, run);
    } catch (err) {
      // After a refused save the file holds the user's edits: keep it.
      if (round === 0) await removeTempFile(path);
      else keep();
      throw err;
    }
    if (!text.trim()) {
      await removeTempFile(path);
      throw usageError("Empty file; nothing saved");
    }
    if (text === original) {
      await removeTempFile(path);
      console.error("No changes");
      return;
    }
    try {
      let changes: Doc;
      if (kind === "pipeline") {
        changes = text === (current.instructions ?? "") ? {} : { instructions: text };
        if (Object.keys(changes).length) {
          // AC-12: the platform's validation first; warnings alone don't block the save.
          const result = await client.validatePipeline(projectId, text);
          const lines = formatValidation(result);
          if (result.errors?.length || result.warnings?.length) for (const line of lines) console.error(line);
          if (!result.valid) throw new CliError("The pipeline YAML has errors", EXIT.conflict);
        }
      } else {
        changes = changedFields(editableView(current as Doc), editableView(parseDocument(text, path)));
      }
      if (Object.keys(changes).length === 0) {
        await removeTempFile(path);
        console.error("No changes");
        return;
      }
      await ensureUnchanged(client, projectId, details, summary, current.instructions_sha256);
      const updated = await sendUpdate(client, projectId, kind, details, summary, current, changes);
      await removeTempFile(path);
      report(format, updated, updated.id ?? summary.id, `Updated ${where(details, summary)}`);
      return;
    } catch (err) {
      const fixable = isFixable(err) || (err instanceof CliError && err.exitCode === EXIT.usage);
      if (!fixable) {
        keep();
        throw err;
      }
      console.error((err as Error).message);
      if (!(await confirm({ message: "Edit again?", default: true }))) {
        keep();
        throw new CliError("Nothing saved", (err as CliError).exitCode);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------------------------

/** `version create <item> <name> [--from]` (AC-15, AC-17): a copy of --from, else of the default version. */
export async function versionCreateCommand(kind: ItemKind, query: string, name: string, opts: AuthoringOptions): Promise<void> {
  const format = parseFormat(opts);
  if (!name.trim()) throw usageError("The version name is empty");
  const { client, projectId, details } = await target(kind, query, opts, "version create");
  // The platform answers a duplicate with a database error (500); the same refusal, clearly.
  if (details.versions.some((v) => v.name === name)) {
    throw new CliError(`${details.name} already has a version named "${name}" — run \`elitea-cli ${kind}s versions ${details.id}\``, EXIT.conflict);
  }
  const source = resolveVersion(details, opts.from);
  const full = await client.getVersion(projectId, details.id, source.id);
  let created;
  try {
    created = await client.createVersion(projectId, details.id, newVersionBody(full, name));
  } catch (err) {
    throw writeRefusal(err);
  }
  report(format, created, created.id, `Created version ${created.name} (${created.id}) of ${details.name}, from ${source.name}`);
}

/** `version default <item> <name|id>` (AC-16, AC-17). */
export async function versionDefaultCommand(kind: ItemKind, query: string, version: string, opts: AuthoringOptions): Promise<void> {
  const format = parseFormat(opts);
  const { client, projectId, details } = await target(kind, query, opts, "version default");
  const summary = resolveVersion(details, version);
  let result;
  try {
    result = await client.setDefaultVersion(projectId, details.id, summary.id);
  } catch (err) {
    throw writeRefusal(err);
  }
  report(format, result, summary.id, `Default version of ${details.name}: ${summary.name} (${summary.id})`);
}

// ---------------------------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------------------------

/** `agents delete` / `pipelines delete` (AC-19…AC-21): the whole item, or one version. */
export async function deleteCommand(kind: ItemKind, query: string, opts: AuthoringOptions): Promise<void> {
  if (opts.replaceWith !== undefined && opts.agentVersion === undefined) throw usageError("--replace-with goes with --agent-version");
  const { client, projectId, agent, details } = await target(kind, query, opts, "delete");
  const what = label(details.version_details ?? agent);

  if (opts.agentVersion === undefined) {
    const ok = await confirmDestructive({
      action: "delete",
      type: what,
      name: details.name,
      id: details.id,
      note: `All its versions (${details.versions.length}) are deleted too.`,
      yes: opts.yes,
    });
    if (!ok) return;
    // AC-20b: whatever the platform answers (published versions are refused) is shown unchanged.
    try {
      await client.deleteApplication(projectId, details.id);
    } catch (err) {
      throw writeRefusal(err);
    }
    if (!printQuiet(details.id)) console.log(`Deleted ${what} "${details.name}" (${details.id})`);
    return;
  }

  const version = resolveVersion(details, opts.agentVersion);
  const replacement = opts.replaceWith === undefined ? undefined : resolveVersion(details, opts.replaceWith);
  if (replacement?.id === version.id) throw usageError("--replace-with must name another version");
  const notes = ["Its schedules will be disabled."];
  if (replacement) notes.push(`Agents and pipelines that use it are moved to version ${replacement.name} (${replacement.id}).`);
  const ok = await confirmDestructive({
    action: "delete",
    type: "version",
    name: `${details.name}/${version.name}`,
    id: version.id,
    note: notes.join(" "),
    yes: opts.yes,
  });
  if (!ok) return;
  try {
    await client.deleteVersion(projectId, details.id, version.id, replacement?.id);
  } catch (err) {
    throw writeRefusal(err, { inUse: REPLACE_HINT });
  }
  if (!printQuiet(version.id)) console.log(`Deleted version ${version.name} (${version.id}) of ${details.name}`);
}

// ---------------------------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------------------------

/**
 * `pipelines validate -f|--yaml <file>` (AC-18): nothing is saved. The exit code follows `valid`
 * (HTTP is 200 either way): 0 valid (warnings allowed), 6 not valid.
 */
export async function validateCommand(opts: AuthoringOptions): Promise<number> {
  const format = parseFormat(opts);
  if ((opts.file === undefined) === (opts.yaml === undefined)) throw usageError("Give the pipeline YAML with -f <file> (or --yaml <file>)");
  const path = (opts.file ?? opts.yaml)!;
  const yaml = await readSource(path, opts.file !== undefined ? "-f" : "--yaml");
  if (!yaml.trim()) throw usageError(`${sourceName(path)}: empty file`);
  const { client, projectId } = await projectSession(opts.project);
  const result = await client.validatePipeline(projectId, yaml);
  if (format !== "text") printData(format, result);
  else for (const line of formatValidation(result)) console.log(line);
  return result.valid ? EXIT.ok : EXIT.conflict;
}
