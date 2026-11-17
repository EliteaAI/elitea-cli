import { ctx, isDebug } from "./context.js";
import { BUSY_MESSAGE, httpErrorMessage, parseErrorBody, platformText } from "./platformError.js";

import { redactBody, redactPath, scrub, scrubAll } from "./redact.js";

export interface EliteaUser {
  id: number;
  name: string;
  email: string;
  personal_project_id: number;
}

export interface EliteaProject {
  id: number;
  name: string;
}

export interface EliteaModel {
  name: string;
  display_name: string;
  project_id: number;
  shared: boolean;
  context_window: number;
  max_output_tokens: number;
  supports_reasoning: boolean;
  supports_vision: boolean;
}

export interface ModelCatalog {
  items: EliteaModel[];
  default_model_name?: string | null;
  low_tier_default_model_name?: string | null;
  high_tier_default_model_name?: string | null;
}

/** Which applications to list: classic agents, pipelines, or both. */
export type ApplicationType = "agent" | "pipeline" | "all";

/** An EliteA agent ("application" in the API); list rows carry no versions. */
export interface EliteaAgent {
  id: number;
  name: string;
  description?: string | null;
  status?: string;
  agent_type?: string;
  tags?: Array<{ name: string }>;
}

export interface AgentVersionSummary {
  id: number;
  name: string;
  status?: string;
  created_at?: string;
  author_name?: string | null;
  author_email?: string | null;
}

export interface EliteaAgentDetails extends EliteaAgent {
  versions: AgentVersionSummary[];
  /** The default version. */
  version_details?: { id: number; name: string; agent_type?: string };
}

export interface AgentVariable {
  name: string;
  value?: unknown;
}

/** GET version/...; kept as the server sends it, the typed fields are the ones the CLI reads. */
export interface AgentVersion {
  id: number;
  name: string;
  status?: string;
  agent_type?: string;
  instructions?: string | null;
  llm_settings?: { model_name?: string | null } | null;
  tools?: Array<{ id?: number; name?: string; type?: string; toolkit_name?: string; settings?: unknown }> | null;
  /** sha256 of `instructions`, for read-before-write checks. */
  instructions_sha256?: string;
  variables?: AgentVariable[] | null;
  conversation_starters?: unknown[] | null;
  welcome_message?: string | null;
  tags?: Array<{ name: string }> | null;
  [key: string]: unknown;
}

/** POST applications: the application, its versions and the created base version in full. */
export interface CreatedApplication extends EliteaAgentDetails {
  version_details: AgentVersion;
}

export interface PipelineIssue {
  code: string;
  node_id?: string | null;
  field?: string | null;
  message: string;
  severity: "error" | "warning";
}

export interface PipelineValidation {
  valid: boolean;
  errors: PipelineIssue[];
  warnings: PipelineIssue[];
}

export interface EliteaTag {
  id: number;
  name: string;
}

export interface ConversationParticipant {
  id: number;
  entity_name: string;
  entity_meta?: { id?: number; project_id?: number };
}

export interface AgentConversation {
  id: number;
  uuid: string;
  name: string;
  participants: ConversationParticipant[];
}

export interface MessageGroup {
  id: number;
  uuid: string;
  author_participant_id: number;
  is_streaming: boolean;
  message_items: Array<{ item_type: string; item_details?: { content?: string } }>;
  /** is_error/error: the run failed; hitl_interrupt(s)/authorization_requests: paused for the user. */
  meta?: {
    is_error?: boolean;
    error?: string | null;
    hitl_interrupt?: unknown;
    hitl_interrupts?: unknown[];
    authorization_requests?: unknown[];
    [key: string]: unknown;
  };
}

/** One entry of the configuration type catalog (`configurations/available`). */
export interface CredentialType {
  type: string;
  section: string;
  /** JSON schema of the create body; `properties.data` is the type's own schema. */
  config_schema: { title?: string; properties?: { data?: JsonSchema; [key: string]: unknown }; [key: string]: unknown };
  has_test_connection?: boolean;
  managed_by?: string | null;
  manage_url?: string | null;
  check_connection_label?: string | null;
  [key: string]: unknown;
}

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  writeOnly?: boolean;
  hidden?: boolean;
  enum?: unknown[];
  default?: unknown;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $defs?: Record<string, JsonSchema>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A saved credential ("configuration" in the API), as list and details return it. */
export interface Credential {
  id: number;
  uuid: string;
  project_id: number;
  elitea_title: string;
  label?: string | null;
  type: string;
  section: string;
  data: Record<string, unknown>;
  meta?: Record<string, unknown>;
  shared?: boolean;
  status_ok?: boolean;
  status_logs?: string | null;
  author_id?: number | null;
  created_at?: string;
  updated_at?: string | null;
  [key: string]: unknown;
}

/** Sections whose rows are credentials (integrations and AI provider keys). */
export const CREDENTIAL_SECTIONS = ["credentials", "ai_credentials"];

/** POST check_connection: what the platform answered, kept as it said it. */
export interface ConnectionCheck {
  ok: boolean;
  message?: string;
  /** The type needs a browser sign-in before it can connect. */
  signInRequired?: boolean;
}

/** The PAT is missing, expired, revoked, or lacks access. */
export class AuthError extends Error {
  constructor(message = "EliteA rejected the token — run `elitea-cli login` again") {
    super(message);
    this.name = "AuthError";
  }
}

export class EliteaError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the server could not be reached. */
    readonly status: number,
    /** The platform's error code (`TOKEN_SCOPE_PROJECT`, `project_budget_exceeded`, …). */
    readonly code?: string,
    /** What the platform said, unformatted: its text and its field errors. */
    readonly platform?: PlatformSaid,
  ) {
    super(message);
    this.name = "EliteaError";
  }
}

/** What the platform said, unformatted: its text, its field errors and the field it names. */
export interface PlatformSaid {
  text?: string;
  fields: string[];
  field?: string;
}

/** HTTP 403: the token works but lacks access to this project or item. */
export class AccessDeniedError extends EliteaError {
  constructor(message = "Forbidden", code?: string, platform?: PlatformSaid) {
    super(message, 403, code, platform);
    this.name = "AccessDeniedError";
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  /** JSON body. */
  body?: unknown;
  /** multipart/form-data body (file uploads); fetch sets the boundary. */
  form?: FormData;
  /** A body sent unchanged (the `api` command's -f); set Content-Type in `headers`. */
  raw?: string;
  /** Added to the path's query string. */
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

export interface ListAgentsOptions {
  /** Name search on the server. */
  query?: string;
  pageSize?: number;
  /** "agent" (default): classic agents; "pipeline": pipelines; "all": both. */
  type?: ApplicationType;
  /** Every tag must match (the server ANDs them). */
  tagIds?: number[];
  /** Any version with one of these statuses. */
  statuses?: string[];
  /** Any version by this author. */
  authorId?: number;
  /** Stop after this many rows. */
  maxTotal?: number;
}

/** Public project that holds the shared models; not a useful default for users. */
export const PUBLIC_PROJECT_ID = 1;

export class EliteaClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get llmBaseUrl(): string {
    return `${this.baseUrl}/llm`;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /**
   * One HTTP exchange with the token, nothing mapped (the `api` command uses it as is).
   * Redirects are never followed; an unreachable server is an EliteaError with status 0.
   */
  async send(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = withQuery(path, opts.query);
    const jsonBody = opts.body !== undefined && opts.form === undefined && opts.raw === undefined;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
      Authorization: `Bearer ${this.token}`,
    };
    const body = opts.form ?? opts.raw ?? (jsonBody ? JSON.stringify(opts.body) : undefined);
    const started = Date.now();
    let res: Response;
    try {
      // An invalid token gets a 302 to the login page, not a 401.
      res = await this.fetchImpl(`${this.baseUrl}${url}`, { method, headers, body, redirect: "manual" });
    } catch (err) {
      const reason = ((err as Error).cause as Error | undefined)?.message ?? (err as Error).message;
      if (isDebug()) console.error(`${method} ${redactPath(url, ctx.secretKeys)} → network error (${Date.now() - started} ms)`);
      throw new EliteaError(`Cannot reach ${this.baseUrl}: ${reason}`, 0);
    }
    if (isDebug()) await this.logExchange(method, url, typeof body === "string" ? body : opts.form ? "(multipart form)" : "", res, started);
    return res;
  }

  /** --debug: `METHOD path?query → status (ms)`, then the masked bodies; never the token (AC-13). */
  private async logExchange(method: string, url: string, body: string, res: Response, started: number): Promise<void> {
    const extra = ctx.secretKeys;
    // Values the user typed for this command never appear, whatever key carries them (AC-14).
    const clean = (text: string) => scrubAll(text, ctx.secretValues);
    console.error(`${method} ${redactPath(url, extra)} → ${res.status} (${Date.now() - started} ms)`);
    if (body) console.error(`  request:  ${body.startsWith("(") ? body : clean(redactBody(body, extra))}`);
    const text = scrub(await res.clone().text().catch(() => ""), this.token);
    if (text) console.error(`  response: ${clean(redactBody(text, extra))}`);
  }

  /** A call with EliteA's errors mapped to CLI errors (AC-8…AC-12). JSON in, JSON out; 204 → undefined. */
  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}, retried = false): Promise<T> {
    const res = await this.send(method, path, options);
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    // Only reads are retried: a write may have been applied before the 503 (AC-12).
    if (res.status === 503 && method === "GET" && !retried) {
      // Busy worker pool: {"error": "temporarily_unavailable", "retry_after": 5}
      const err = parseErrorBody(await res.text().catch(() => ""), res.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, Math.min(err.retryAfter ?? 5, 30) * 1000));
      return this.request<T>(method, path, options, true);
    }
    return this.fail(method, path, res);
  }

  /** A response that is not 2xx as the CLI error for it (AC-8…AC-12). */
  private async fail(method: HttpMethod, path: string, res: Response): Promise<never> {
    const bare = path.split("?")[0]!;
    if (res.status === 401) throw new AuthError();
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (isLoginRedirect(location)) throw new AuthError();
      throw new EliteaError(`EliteA ${bare} redirected unexpectedly to ${location || "(no location)"}`, res.status);
    }
    const err = parseErrorBody(await res.text().catch(() => ""), res.headers.get("retry-after"));
    if (res.status === 503 && method !== "GET") throw new EliteaError(BUSY_MESSAGE, 503, err.code);
    const message = httpErrorMessage(res.status, bare, err, { projectId: ctx.projectId, operation: ctx.operation });
    const said = { text: platformText(err), fields: err.fields, field: err.field };
    if (res.status === 403) throw new AccessDeniedError(message, err.code, said);
    throw new EliteaError(message, res.status, err.code, said);
  }

  getUser(): Promise<EliteaUser> {
    return this.get<EliteaUser>("/api/v2/auth/user/");
  }

  /** Projects the user is a member of. The trailing id is just a routing context. */
  async listProjects(contextProjectId: number): Promise<EliteaProject[]> {
    const rows = await this.get<Array<EliteaProject & { suspended?: boolean }>>(
      `/api/v2/projects/project/default/${contextProjectId}?check_public_role=true`,
    );
    return rows.filter((p) => !p.suspended).map(({ id, name }) => ({ id, name }));
  }

  getModels(projectId: number): Promise<ModelCatalog> {
    return this.get<ModelCatalog>(`/api/v2/configurations/models/${projectId}?include_shared=true`);
  }

  /**
   * Agents in the project, newest first; `query` filters by name on the server. Pipelines are
   * applications too and share this endpoint: `type` "agent" (the default) leaves them out,
   * "pipeline" returns only them, "all" both.
   */
  async listAgents(projectId: number, opts: ListAgentsOptions = {}): Promise<EliteaAgent[]> {
    const pageSize = opts.pageSize ?? 100;
    const type = opts.type ?? "agent";
    const max = opts.maxTotal ?? Infinity;
    const agents: EliteaAgent[] = [];
    for (;;) {
      const limit = Math.min(pageSize, max - agents.length);
      if (limit <= 0) return agents;
      const params = new URLSearchParams({ limit: String(limit), offset: String(agents.length) });
      if (opts.query) params.set("query", opts.query);
      if (type !== "all") params.set("agents_type", type === "agent" ? "classic" : "pipeline");
      if (opts.tagIds?.length) params.set("tags", opts.tagIds.join(","));
      if (opts.statuses?.length) params.set("statuses", opts.statuses.join(","));
      if (opts.authorId !== undefined) params.set("author_id", String(opts.authorId));
      const page = await this.get<{ total: number; rows: EliteaAgent[] }>(
        `/api/v2/elitea_core/applications/prompt_lib/${projectId}?${params}`,
      );
      agents.push(...page.rows);
      if (page.rows.length === 0 || agents.length >= page.total) return agents;
    }
  }

  /** Agent with its versions; `version_details` is the default version. */
  getAgent(projectId: number, agentId: number): Promise<EliteaAgentDetails> {
    return this.get<EliteaAgentDetails>(`/api/v2/elitea_core/application/prompt_lib/${projectId}/${agentId}`);
  }

  /** Full configuration of one version (instructions, model, tools, variables…). */
  getVersion(projectId: number, agentId: number, versionId: number): Promise<AgentVersion> {
    return this.get<AgentVersion>(`/api/v2/elitea_core/version/prompt_lib/${projectId}/${agentId}/${versionId}`);
  }

  /** New agent or pipeline with its `base` version (exactly one version, named base). */
  createApplication(projectId: number, body: Record<string, unknown>): Promise<CreatedApplication> {
    return this.request<CreatedApplication>("POST", `/api/v2/elitea_core/applications/prompt_lib/${projectId}`, { body });
  }

  /** Change one version; fields left out of `body` keep their value. `name` is required. 201 → the version. */
  updateVersion(projectId: number, agentId: number, versionId: number, body: Record<string, unknown>): Promise<AgentVersion> {
    return this.request<AgentVersion>("PUT", `/api/v2/elitea_core/version/prompt_lib/${projectId}/${agentId}/${versionId}`, { body });
  }

  /** New version from a full version body; `copy_skills_from_version_id` copies that version's skills. */
  createVersion(projectId: number, agentId: number, body: Record<string, unknown>): Promise<AgentVersion> {
    return this.request<AgentVersion>("POST", `/api/v2/elitea_core/versions/prompt_lib/${projectId}/${agentId}`, { body });
  }

  setDefaultVersion(projectId: number, agentId: number, versionId: number): Promise<EliteaAgentDetails> {
    return this.request<EliteaAgentDetails>("PATCH", `/api/v2/elitea_core/default_version/prompt_lib/${projectId}/${agentId}`, {
      body: { version_id: versionId },
    });
  }

  /** The agent or pipeline with all its versions (204). */
  async deleteApplication(projectId: number, agentId: number): Promise<void> {
    await this.request("DELETE", `/api/v2/elitea_core/application/prompt_lib/${projectId}/${agentId}`);
  }

  /** One version; a version other agents use needs `replacementVersionId` to move them first. */
  async deleteVersion(projectId: number, agentId: number, versionId: number, replacementVersionId?: number): Promise<void> {
    await this.request("DELETE", `/api/v2/elitea_core/version/prompt_lib/${projectId}/${agentId}/${versionId}`, {
      query: { replacement_version_id: replacementVersionId },
    });
  }

  /** Check pipeline YAML without saving; HTTP 200 whether it is valid or not. */
  validatePipeline(projectId: number, yaml: string): Promise<PipelineValidation> {
    return this.request<PipelineValidation>("POST", `/api/v2/elitea_core/validate_pipeline/prompt_lib/${projectId}`, {
      body: { pipeline_yaml: yaml },
    });
  }

  /** Credential types this project can create, with their schemas (admin-managed types are left out). */
  async listCredentialTypes(projectId: number): Promise<CredentialType[]> {
    const params = new URLSearchParams(CREDENTIAL_SECTIONS.map((s) => ["section", s]));
    return this.get<CredentialType[]>(`/api/v2/configurations/available/${projectId}?${params}`);
  }

  /**
   * Credentials of the project, then (`includeShared`) those the public project shares. Every page
   * is read; `type` filters on the server.
   */
  async listCredentials(projectId: number, opts: { type?: string; includeShared?: boolean } = {}): Promise<Credential[]> {
    type Page = { total?: number; items?: Credential[]; shared?: { total?: number; items?: Credential[] } };
    const PAGE = 100;
    const page = (own: number, shared?: number) => {
      const params = new URLSearchParams(CREDENTIAL_SECTIONS.map((s) => ["section", s]));
      if (opts.type) params.append("type", opts.type);
      params.set("offset", String(own));
      params.set("limit", String(shared === undefined ? PAGE : 1));
      if (shared !== undefined) {
        params.set("include_shared", "true");
        params.set("shared_offset", String(shared));
        params.set("shared_limit", String(PAGE));
      }
      return this.get<Page>(`/api/v2/configurations/configurations/${projectId}?${params}`);
    };
    // The server wraps an offset past the end back to 0, so the loops stop on the total.
    const own: Credential[] = [];
    for (;;) {
      const p = await page(own.length);
      own.push(...(p.items ?? []));
      if (!p.items?.length || own.length >= (p.total ?? 0)) break;
    }
    const shared: Credential[] = [];
    while (opts.includeShared) {
      const p = (await page(0, shared.length)).shared;
      shared.push(...(p?.items ?? []));
      if (!p?.items?.length || shared.length >= (p.total ?? 0)) break;
    }
    return [...own, ...shared];
  }

  /** One credential with its stored data; secret fields hold `{{secret.…}}` references, not values. */
  getCredential(projectId: number, credentialId: number): Promise<Credential> {
    return this.get<Credential>(`/api/v2/configurations/configuration/${projectId}/${credentialId}`);
  }

  createCredential(projectId: number, body: Record<string, unknown>): Promise<Credential> {
    return this.request<Credential>("POST", `/api/v2/configurations/configurations/${projectId}`, { body });
  }

  /** `data` replaces the stored data wholesale; other fields left out keep their value. */
  updateCredential(projectId: number, credentialId: number, body: Record<string, unknown>): Promise<Credential> {
    return this.request<Credential>("PUT", `/api/v2/configurations/configuration/${projectId}/${credentialId}`, { body });
  }

  async deleteCredential(projectId: number, credentialId: number): Promise<void> {
    await this.request("DELETE", `/api/v2/configurations/configuration/${projectId}/${credentialId}`);
  }

  /**
   * Run the type's connection check on a saved credential: its stored data (vault references are
   * resolved on the server) and its uuid, which credential governance tests instead of the body.
   * A failed check (400) or a needed sign-in (401 requires_authorization) is a result, not an error.
   */
  async checkCredential(projectId: number, credential: Credential): Promise<ConnectionCheck> {
    const path = `/api/v2/configurations/check_connection/${projectId}/${encodeURIComponent(credential.type)}`;
    const opts = { body: credential.data, query: { configuration_uuid: credential.uuid } };
    const res = await this.send("POST", path, opts);
    const body = res.ok || res.status === 400 || res.status === 401 ? await res.clone().json().catch(() => undefined) : undefined;
    const said = (body ?? {}) as { success?: boolean; message?: unknown; error?: unknown; requires_authorization?: boolean };
    const message = typeof said.message === "string" ? said.message : typeof said.error === "string" ? said.error : undefined;
    if (res.ok) return { ok: said.success !== false, message };
    if (res.status === 401 && said.requires_authorization) return { ok: false, message, signInRequired: true };
    if (res.status === 400 && said.success === false) return { ok: false, message };
    return this.fail("POST", path, res);
  }

  /** Skills attached to a version (they are not part of the version object). */
  async getVersionSkills(projectId: number, versionId: number): Promise<Array<{ name: string; skill_id?: number }>> {
    const res = await this.get<{ skills?: Array<{ name: string; skill_id?: number }> }>(
      `/api/v2/elitea_core/application_skills/prompt_lib/${projectId}/${versionId}`,
    );
    return res.skills ?? [];
  }

  /** Tags used in the project; the list API filters by tag id, not name. */
  async listTags(projectId: number): Promise<EliteaTag[]> {
    const res = await this.get<{ rows: EliteaTag[] }>(`/api/v2/elitea_core/tags/prompt_lib/${projectId}`);
    return res.rows.map(({ id, name }) => ({ id, name }));
  }

  /** Private conversation with one agent; EliteA adds the user's own participant. */
  createConversation(
    projectId: number,
    opts: { name: string; agentId: number; versionId?: number; variables?: AgentVariable[] },
  ): Promise<AgentConversation> {
    const settings = {
      ...(opts.versionId === undefined ? {} : { version_id: opts.versionId }),
      ...(opts.variables === undefined ? {} : { variables: opts.variables }),
    };
    return this.request<AgentConversation>("POST", `/api/v2/elitea_core/conversations/prompt_lib/${projectId}`, { body: {
      name: opts.name,
      is_private: true,
      participants: [
        {
          entity_name: "application",
          entity_meta: { id: opts.agentId, project_id: projectId },
          ...(Object.keys(settings).length === 0 ? {} : { entity_settings: settings }),
        },
      ],
    } });
  }

  getConversation(projectId: number, conversationId: number): Promise<AgentConversation> {
    return this.get<AgentConversation>(
      `/api/v2/elitea_core/conversation/prompt_lib/${projectId}/${conversationId}?messages_limit=0`,
    );
  }

  /** Start the agent's reply in the background; poll `recentMessages` for it. */
  sendMessage(
    projectId: number,
    conversationUuid: string,
    participantId: number,
    text: string,
  ): Promise<{ request_message_group_id: number; response_message_group_id: number }> {
    return this.request("POST", `/api/v2/elitea_core/messages/prompt_lib/${projectId}/${conversationUuid}`, {
      body: { user_input: text, participant_id: participantId, await_task_timeout: 0, return_task_id: true },
    });
  }

  /** Newest message groups first. Takes the numeric conversation id (a uuid gives HTTP 500). */
  async recentMessages(projectId: number, conversationId: number, limit = 5): Promise<MessageGroup[]> {
    const page = await this.get<{ rows: MessageGroup[] }>(
      `/api/v2/elitea_core/messages/prompt_lib/${projectId}/${conversationId}?limit=${limit}`,
    );
    return page.rows;
  }
}

/** EliteA sends an invalid token to its login page instead of answering 401. */
export function isLoginRedirect(location: string): boolean {
  return /forward-auth|access_denied|login/.test(location);
}

function withQuery(path: string, query: RequestOptions["query"]): string {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined) as Array<[string, string | number | boolean]>;
  if (entries.length === 0) return path;
  const params = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
  return `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

/** Human name for a project; personal projects are named project_user_<id> in EliteA. */
export function projectName(project: EliteaProject, user?: EliteaUser): string {
  return user && project.id === user.personal_project_id ? "Personal" : project.name;
}

export function projectLabel(project: EliteaProject, user?: EliteaUser): string {
  return `${projectName(project, user)} (${project.id})`;
}
