import { describe, expect, it, vi } from "vitest";
import { chooseProject, sortProjects } from "../src/commands/project.js";
import { AuthError, EliteaClient, EliteaError } from "../src/elitea.js";

function fakeFetch(routes: Record<string, { status: number; body?: unknown; location?: string }>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://elitea.test", "");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: route.location ? { location: route.location } : {},
    });
  }) as unknown as typeof fetch;
}

const user = { id: 7, name: "Ada", email: "ada@example.com", personal_project_id: 4 };
const projectsPath = "/api/v2/projects/project/default/4?check_public_role=true";
const projects = [
  { id: 1, name: "promptlib_public" },
  { id: 27, name: "Zeta team" },
  { id: 4, name: "project_user_7" },
  { id: 19, name: "Alpha team" },
  { id: 50, name: "Old", suspended: true },
];

describe("EliteaClient", () => {
  it("returns the user for a valid token", async () => {
    const client = new EliteaClient("https://elitea.test", "tok", fakeFetch({ "/api/v2/auth/user/": { status: 200, body: user } }));
    expect(await client.getUser()).toEqual(user);
  });

  it("treats a redirect to the login page as an auth failure", async () => {
    const location = "https://elitea.test/forward-auth/auth_oidc/login?target_to=x";
    const client = new EliteaClient("https://elitea.test", "tok", fakeFetch({ "/api/v2/auth/user/": { status: 302, location } }));
    await expect(client.getUser()).rejects.toBeInstanceOf(AuthError);
  });

  it("reports other redirects (e.g. trailing-slash 308) as errors, not auth failures", async () => {
    const location = "https://elitea.test/api/v2/auth/user/";
    const client = new EliteaClient("https://elitea.test", "tok", fakeFetch({ "/api/v2/auth/user/": { status: 308, location } }));
    await expect(client.getUser()).rejects.toBeInstanceOf(EliteaError);
  });

  it("treats 401 and 403 as auth failures and other errors as EliteaError", async () => {
    const c401 = new EliteaClient("https://elitea.test", "tok", fakeFetch({ "/api/v2/auth/user/": { status: 401 } }));
    await expect(c401.getUser()).rejects.toBeInstanceOf(AuthError);
    const c500 = new EliteaClient("https://elitea.test", "tok", fakeFetch({ "/api/v2/auth/user/": { status: 500 } }));
    await expect(c500.getUser()).rejects.toBeInstanceOf(EliteaError);
  });

  it("drops suspended projects", async () => {
    const client = new EliteaClient("https://elitea.test", "tok", fakeFetch({ [projectsPath]: { status: 200, body: projects } }));
    expect((await client.listProjects(4)).map((p) => p.id)).toEqual([1, 27, 4, 19]);
  });
});

describe("projects", () => {
  it("sorts personal first, then by name, hiding the public project", () => {
    expect(sortProjects(projects.slice(0, 4), user).map((p) => p.id)).toEqual([4, 19, 27]);
  });

  const client = new EliteaClient("https://elitea.test", "tok", fakeFetch({ [projectsPath]: { status: 200, body: projects } }));

  it("accepts a requested project by id or name", async () => {
    expect((await chooseProject(client, user, { requested: "27" })).name).toBe("Zeta team");
    expect((await chooseProject(client, user, { requested: "alpha TEAM" })).id).toBe(19);
  });

  it("rejects projects the user is not a member of (EliteA would silently fall back)", async () => {
    await expect(chooseProject(client, user, { requested: "999999" })).rejects.toThrow(/not found/);
  });

  it("defaults to the personal project when not interactive", async () => {
    // vitest runs without a TTY
    expect((await chooseProject(client, user, {})).id).toBe(4);
  });
});
