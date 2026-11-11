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

/** An EliteA agent ("application" in the API); list rows carry no versions. */
export interface EliteaAgent {
  id: number;
  name: string;
  description?: string | null;
  status?: string;
  agent_type?: string;
  tags?: Array<{ name: string }>;
}

export interface EliteaAgentDetails extends EliteaAgent {
  versions: Array<{ id: number; name: string; status?: string }>;
  version_details?: { id: number; name: string };
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
}

/** The PAT is missing, expired, revoked, or lacks access. */
export class AuthError extends Error {
  constructor(message = "EliteA rejected the token — run `elitea-cli login` again") {
    super(message);
    this.name = "AuthError";
  }
}

export class EliteaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EliteaError";
  }
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

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, retried = false): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // An invalid token gets a 302 to the login page, not a 401.
        redirect: "manual",
      });
    } catch (err) {
      throw new EliteaError(`Cannot reach ${this.baseUrl}: ${(err as Error).message}`, 0);
    }
    if (res.status === 401) throw new AuthError();
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (/forward-auth|access_denied|login/.test(location)) throw new AuthError();
      throw new EliteaError(`EliteA ${path} redirected unexpectedly to ${location || "(no location)"}`, res.status);
    }
    if (res.status === 403) {
      throw new AuthError(`EliteA denied access to ${path} (403) — the token may lack permissions`);
    }
    if (res.status === 429) throw new EliteaError("EliteA budget for this project is exhausted (429)", 429);
    if (res.status === 503 && !retried) {
      // Busy worker pool: {"error": "temporarily_unavailable", "retry_after": 5}
      const retryAfter = Number((await errorBody(res)).retry_after) || 5;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 30) * 1000));
      return this.request<T>(method, path, body, true);
    }
    if (!res.ok) {
      const detail = (await errorBody(res)).error;
      throw new EliteaError(`EliteA ${path} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, res.status);
    }
    return (await res.json()) as T;
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

  /** All agents in the project, newest first; `query` filters by name on the server. */
  async listAgents(projectId: number, opts: { query?: string; pageSize?: number } = {}): Promise<EliteaAgent[]> {
    const limit = opts.pageSize ?? 100;
    const agents: EliteaAgent[] = [];
    for (;;) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(agents.length) });
      if (opts.query) params.set("query", opts.query);
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

  /** Private conversation with one agent; EliteA adds the user's own participant. */
  createConversation(
    projectId: number,
    opts: { name: string; agentId: number; versionId?: number },
  ): Promise<AgentConversation> {
    return this.request<AgentConversation>("POST", `/api/v2/elitea_core/conversations/prompt_lib/${projectId}`, {
      name: opts.name,
      is_private: true,
      participants: [
        {
          entity_name: "application",
          entity_meta: { id: opts.agentId, project_id: projectId },
          ...(opts.versionId === undefined ? {} : { entity_settings: { version_id: opts.versionId } }),
        },
      ],
    });
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
      user_input: text,
      participant_id: participantId,
      await_task_timeout: 0,
      return_task_id: true,
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

async function errorBody(res: Response): Promise<{ error?: string; retry_after?: number }> {
  try {
    const body = (await res.json()) as unknown;
    // Pydantic validation failures come back as [{loc, msg}, …].
    if (Array.isArray(body)) {
      const msgs = body.map((e: { loc?: unknown[]; msg?: string }) => `${(e.loc ?? []).join(".")}: ${e.msg}`);
      return { error: msgs.join("; ") };
    }
    const obj = body as { error?: unknown; retry_after?: unknown };
    return { error: typeof obj.error === "string" ? obj.error : undefined, retry_after: Number(obj.retry_after) };
  } catch {
    return {};
  }
}

/** Human name for a project; personal projects are named project_user_<id> in EliteA. */
export function projectName(project: EliteaProject, user?: EliteaUser): string {
  return user && project.id === user.personal_project_id ? "Personal" : project.name;
}

export function projectLabel(project: EliteaProject, user?: EliteaUser): string {
  return `${projectName(project, user)} (${project.id})`;
}
