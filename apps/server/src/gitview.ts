// Git tab: commit graphs of the repositories in the projects folders and of GitHub repositories (mirrored into
// data/git), and GitHub pull requests: review the diff, then merge or close. Reading works without a token for
// public repositories; merging and closing need GITHUB_TOKEN (.env), which never leaves the server.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { abs, config } from "./config.ts";

const SEP = "\x1f";
const END = "\x1e";

/** Run git and return stdout. GIT_TERMINAL_PROMPT=0: never wait for a password. */
export function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join(" ")));
      else resolve(stdout);
    });
  });
}

// ---------- which repositories ----------

export interface Repo {
  id: string;
  kind: "local" | "github";
  name: string;
  /** Working tree (local) or bare mirror (github) */
  dir: string;
  slug?: string;
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());
const isRepo = (d: string) => existsSync(path.join(d, ".git"));

/** Git repositories in git.dirs (echo.yaml): the folder itself if it is one, else its direct subfolders that are. */
export function localRepos(dirs = config.echo.git?.dirs ?? ["/projects", "~/Projects"]): Repo[] {
  const seen = new Set<string>();
  const out: Repo[] = [];
  const add = (d: string) => {
    let real = d;
    try {
      real = realpathSync(d);
    } catch {}
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ id: `local:${d}`, kind: "local", name: path.basename(d), dir: d });
  };
  for (const raw of dirs) {
    const dir = expand(raw);
    if (!existsSync(dir)) continue;
    if (isRepo(dir)) add(dir);
    else {
      for (const e of readdirSync(dir).sort()) {
        const d = path.join(dir, e);
        try {
          if (statSync(d).isDirectory() && isRepo(d)) add(d);
        } catch {}
      }
    }
  }
  return out;
}

const SLUG = /^[\w.-]+\/[\w.-]+$/;
const mirrorDir = (slug: string) => abs(path.join(config.echo.paths.data, "git", `${slug.replace("/", "__")}.git`));

export function githubRepos(): Repo[] {
  return (config.echo.git?.github ?? []).filter((s) => SLUG.test(s)).map((slug) => ({ id: `gh:${slug}`, kind: "github" as const, name: slug, dir: mirrorDir(slug), slug }));
}

/** Only repositories Echo lists can be read: an id never becomes an arbitrary path. */
export function repoById(id: string): Repo {
  const r = [...githubRepos(), ...localRepos()].find((x) => x.id === id);
  if (!r) throw new Error(`unknown repository ${id}`);
  return r;
}

// ---------- GitHub ----------

const token = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const cache = new Map<string, { at: number; data: unknown }>();

async function gh<T = any>(pathname: string, init: { method?: string; body?: unknown } = {}, maxAgeMs = 20_000): Promise<T> {
  const key = pathname;
  if (!init.method || init.method === "GET") {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.data as T;
  }
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Echo" };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`https://api.github.com${pathname}`, {
    method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) {
    if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error(`GitHub's rate limit is used up${token() ? "" : " (60 requests an hour without a token: add GITHUB_TOKEN to .env)"}; try again later`);
    }
    throw new Error(`GitHub ${r.status}: ${data.message ?? text.slice(0, 200)}`);
  }
  if (!init.method || init.method === "GET") cache.set(key, { at: Date.now(), data });
  else for (const k of [...cache.keys()]) if (k.startsWith(pathname.split("/pulls")[0])) cache.delete(k);
  return data as T;
}

export interface RepoMeta {
  defaultBranch: string;
  private: boolean;
  canMerge: boolean;
  url: string;
}
const meta = new Map<string, RepoMeta>();
const fetchedAt = new Map<string, number>();

async function repoMeta(slug: string): Promise<RepoMeta> {
  const j = await gh(`/repos/${slug}`, {}, 5 * 60_000);
  const m = { defaultBranch: j.default_branch, private: !!j.private, canMerge: !!j.permissions?.push, url: j.html_url };
  meta.set(slug, m);
  return m;
}

const authArgs = () => (token() ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token()}`).toString("base64")}`] : []);

/** Bring the mirror up to date: branches, tags, and the heads of open pull requests (so the graph shows them). */
export async function fetchMirror(slug: string) {
  const dir = mirrorDir(slug);
  if (!existsSync(path.join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    await git(dir, ["init", "--bare", "--quiet"]);
  }
  const url = `https://github.com/${slug}.git`;
  const m = await repoMeta(slug).catch(() => undefined);
  await git(dir, [...authArgs(), "fetch", "--prune", "--quiet", url, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
  if (m) await git(dir, ["symbolic-ref", "HEAD", `refs/heads/${m.defaultBranch}`]);
  const open = (await pulls(slug, "open").catch(() => [])).map((p) => p.number);
  const have = (await git(dir, ["for-each-ref", "--format=%(refname)", "refs/pull"])).split("\n").filter(Boolean);
  for (const ref of have) if (!open.includes(Number(ref.split("/")[2]))) await git(dir, ["update-ref", "-d", ref]);
  if (open.length) await git(dir, [...authArgs(), "fetch", "--quiet", url, ...open.map((n) => `+refs/pull/${n}/head:refs/pull/${n}/head`)]);
  fetchedAt.set(slug, Date.now());
}

export interface PullSummary {
  number: number;
  title: string;
  author: string;
  head: string;
  headSha: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  created: string;
  updated: string;
  url: string;
}

const pullSummary = (p: any): PullSummary => ({
  number: p.number, title: p.title, author: p.user?.login ?? "?", head: p.head?.ref, headSha: p.head?.sha, base: p.base?.ref,
  state: p.state, merged: !!p.merged_at, draft: !!p.draft, created: p.created_at, updated: p.updated_at, url: p.html_url,
});

export async function pulls(slug: string, state: "open" | "closed" | "all"): Promise<PullSummary[]> {
  return (await gh<any[]>(`/repos/${slug}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`)).map(pullSummary);
}

// ---------- reading history ----------

export interface Ref {
  name: string;
  kind: "head" | "branch" | "remote" | "tag" | "pr";
}

/** git log's %D decorations as typed refs: "HEAD -> main, origin/main, tag: v1, refs/pull/3/head". `remotes` are
 *  the repo's remote names: "origin/main" is a remote branch, "feat/live-chat" a local one. */
export function parseRefs(d: string, remotes: string[] = []): Ref[] {
  const out: Ref[] = [];
  for (const raw of d.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith("HEAD -> ")) out.push({ name: "HEAD", kind: "head" }, { name: raw.slice(8), kind: "branch" });
    else if (raw === "HEAD") out.push({ name: "HEAD", kind: "head" });
    else if (raw.startsWith("tag: ")) out.push({ name: raw.slice(5), kind: "tag" });
    else if (/^refs\/pull\/\d+\/head$/.test(raw)) out.push({ name: `#${raw.split("/")[2]}`, kind: "pr" });
    else if (remotes.some((r) => raw === `${r}/HEAD`)) continue; // only repeats the remote's default branch
    else if (remotes.some((r) => raw.startsWith(`${r}/`))) out.push({ name: raw, kind: "remote" });
    else out.push({ name: raw.replace(/^refs\/(heads\/)?/, ""), kind: "branch" });
  }
  return out;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  ts: number;
  refs: Ref[];
  subject: string;
}

export function parseLog(out: string, remotes: string[] = []): Commit[] {
  return out.split(END).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [sha, parents, author, ts, refs, subject] = r.split(SEP);
    return { sha, parents: parents ? parents.split(" ") : [], author, ts: Number(ts) * 1000, refs: parseRefs(refs ?? "", remotes), subject: subject ?? "" };
  });
}

const LOG_FORMAT = `--format=%H${SEP}%P${SEP}%an${SEP}%at${SEP}%D${SEP}%s${END}`;

const remoteNames = async (repo: Repo) => (await git(repo.dir, ["remote"]).catch(() => "")).split("\n").filter(Boolean);

/** The commit graph: newest first, every branch, remote branch and tag (and open pull requests on GitHub). */
export async function graph(repo: Repo, limit: number) {
  if (repo.kind === "github" && !existsSync(path.join(repo.dir, "HEAD"))) await fetchMirror(repo.slug!);
  const empty = { commits: [] as Commit[], head: null, branches: [] as string[], dirty: 0 };
  const refs = (await git(repo.dir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])).split("\n").filter(Boolean);
  if (!refs.length) return empty;
  const revs = repo.kind === "github" ? ["--branches", "--tags", "--glob=refs/pull/*/head"] : ["--branches", "--remotes", "--tags", "HEAD"];
  // labels: git leaves refs/pull/ undecorated unless asked
  const labels = ["refs/heads/", "refs/remotes/", "refs/tags/", "refs/pull/", "HEAD"].map((r) => `--decorate-refs=${r}`);
  // --branches/--remotes/--tags, not --all: the agent's checkpoints under refs/echo/ would flood the graph
  const commits = parseLog(await git(repo.dir, ["log", "--date-order", `-n${limit}`, LOG_FORMAT, ...labels, ...revs]), await remoteNames(repo));
  const head = (await git(repo.dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim() || null;
  const branches = (await git(repo.dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean);
  const dirty = repo.kind === "local" ? (await git(repo.dir, ["status", "--porcelain"]).catch(() => "")).split("\n").filter(Boolean).length : 0;
  return { commits, head, branches, dirty };
}

const SHA = /^[0-9a-f]{7,40}$/;
const MAX_PATCH = 600_000;

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
}

const parseNumstat = (s: string): FileStat[] => s.split("\n").filter(Boolean).map((l) => {
  const [a, d, ...p] = l.split("\t");
  return { path: p.join("\t"), additions: a === "-" ? 0 : Number(a), deletions: d === "-" ? 0 : Number(d) };
});

/** Diff of `from..to` (or of a root commit) with per-file counts, the patch clipped to a size the browser handles. */
async function diff(dir: string, from: string | null, to: string) {
  const range = from ? [from, to] : ["--root", to];
  const cmd = from ? "diff" : "show";
  const pre = from ? [] : ["--format="];
  const files = parseNumstat(await git(dir, [cmd, ...pre, "--numstat", "-M", ...range]));
  let patch = await git(dir, [cmd, ...pre, "--patch", "-M", ...range]);
  const clipped = patch.length > MAX_PATCH;
  if (clipped) patch = patch.slice(0, patch.lastIndexOf("\ndiff --git", MAX_PATCH) > 0 ? patch.lastIndexOf("\ndiff --git", MAX_PATCH) : MAX_PATCH);
  return { files, patch, clipped };
}

export async function commitDetail(repo: Repo, sha: string) {
  if (!SHA.test(sha)) throw new Error("not a commit id");
  const [h, parents, author, email, ts, refs, subject, body] = (await git(repo.dir, ["show", "-s", `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%D${SEP}%s${SEP}%b`, sha])).split(SEP);
  const ps = parents ? parents.split(" ") : [];
  // a merge is shown against its first parent: what the merge brought in
  const d = await diff(repo.dir, ps[0] ?? null, h);
  return { sha: h, parents: ps, author, email, ts: Number(ts) * 1000, refs: parseRefs(refs, await remoteNames(repo)), subject, body: body.trim(), ...d };
}

// ---------- pull requests ----------

async function haveCommit(dir: string, sha: string) {
  return git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
}

export async function pullDetail(repo: Repo, number: number) {
  const slug = repo.slug!;
  const p = await gh(`/repos/${slug}/pulls/${number}`, {}, 5_000);
  const url = `https://github.com/${slug}.git`;
  if (!existsSync(path.join(repo.dir, "HEAD"))) await fetchMirror(slug);
  if (!(await haveCommit(repo.dir, p.head.sha))) await git(repo.dir, [...authArgs(), "fetch", "--quiet", url, `+refs/pull/${number}/head:refs/pull/${number}/head`]);
  if (!(await haveCommit(repo.dir, p.base.sha))) await git(repo.dir, [...authArgs(), "fetch", "--quiet", url, `+refs/heads/${p.base.ref}:refs/heads/${p.base.ref}`]);
  // what the pull request changes: from where it left the base branch to its head (what GitHub shows as "Files")
  const base = (await git(repo.dir, ["merge-base", p.base.sha, p.head.sha])).trim();
  const commits = parseLog(await git(repo.dir, ["log", LOG_FORMAT, `${base}..${p.head.sha}`]));
  const d = await diff(repo.dir, base, p.head.sha);
  return {
    ...pullSummary(p), body: p.body ?? "", mergeable: p.mergeable as boolean | null, mergeableState: p.mergeable_state as string,
    sameRepo: p.head?.repo?.full_name === slug, commits, ...d,
  };
}

export async function mergePull(repo: Repo, number: number, method: "merge" | "squash" | "rebase", sha: string, deleteBranch: boolean) {
  if (!token()) throw new Error("merging needs a GitHub token: add GITHUB_TOKEN to .env and recreate the container (docker compose up -d)");
  if (!SHA.test(sha)) throw new Error("which commit did you review?");
  const slug = repo.slug!;
  // sha: GitHub refuses if the branch moved after you reviewed it, so only what you saw gets merged
  const r = await gh(`/repos/${slug}/pulls/${number}/merge`, { method: "PUT", body: { merge_method: method, sha } });
  let deleted = false;
  if (deleteBranch) {
    const p = await gh(`/repos/${slug}/pulls/${number}`, {}, 0);
    if (p.head?.repo?.full_name === slug) {
      await gh(`/repos/${slug}/git/refs/heads/${encodeURIComponent(p.head.ref)}`, { method: "DELETE" });
      deleted = true;
    }
  }
  await fetchMirror(slug).catch(() => {});
  return { merged: !!r.merged, sha: r.sha as string, message: r.message as string, deletedBranch: deleted };
}

export async function closePull(repo: Repo, number: number) {
  if (!token()) throw new Error("closing needs a GitHub token: add GITHUB_TOKEN to .env and recreate the container (docker compose up -d)");
  await gh(`/repos/${repo.slug}/pulls/${number}`, { method: "PATCH", body: { state: "closed" } });
  await fetchMirror(repo.slug!).catch(() => {});
  return { closed: true };
}

// ---------- routes, mounted at /api/git ----------

const err = (e: unknown) => ({ error: (e as Error).message ?? String(e) });
const needGithub = (r: Repo) => {
  if (r.kind !== "github") throw new Error("pull requests are for GitHub repositories");
  return r;
};

export const gitApp = new Hono();

gitApp.get("/repos", (c) => c.json({
  token: !!token(),
  repos: [
    ...githubRepos().map((r) => ({ ...r, meta: meta.get(r.slug!) ?? null, fetchedAt: fetchedAt.get(r.slug!) ?? null, mirrored: existsSync(path.join(r.dir, "HEAD")) })),
    ...localRepos(),
  ],
}));

gitApp.post("/fetch", async (c) => {
  try {
    const r = repoById((await c.req.json<{ id: string }>()).id);
    if (r.kind === "github") await fetchMirror(r.slug!);
    return c.json({ ok: true, fetchedAt: r.slug ? fetchedAt.get(r.slug) : Date.now(), meta: r.slug ? meta.get(r.slug) ?? null : null });
  } catch (e) {
    return c.json(err(e), 502);
  }
});

gitApp.get("/graph", async (c) => {
  try {
    const r = repoById(c.req.query("id") ?? "");
    return c.json(await graph(r, Math.min(2000, Math.max(20, Number(c.req.query("limit") ?? 300) || 300))));
  } catch (e) {
    return c.json(err(e), 400);
  }
});

gitApp.get("/commit", async (c) => {
  try {
    return c.json(await commitDetail(repoById(c.req.query("id") ?? ""), c.req.query("sha") ?? ""));
  } catch (e) {
    return c.json(err(e), 400);
  }
});

gitApp.get("/prs", async (c) => {
  try {
    const r = needGithub(repoById(c.req.query("id") ?? ""));
    const state = (["open", "closed", "all"] as const).find((s) => s === c.req.query("state")) ?? "open";
    return c.json({ pulls: await pulls(r.slug!, state) });
  } catch (e) {
    return c.json(err(e), 502);
  }
});

gitApp.get("/pr", async (c) => {
  try {
    return c.json(await pullDetail(needGithub(repoById(c.req.query("id") ?? "")), Number(c.req.query("number"))));
  } catch (e) {
    return c.json(err(e), 502);
  }
});

gitApp.post("/pr/merge", async (c) => {
  try {
    const b = await c.req.json<{ id: string; number: number; method?: "merge" | "squash" | "rebase"; sha: string; deleteBranch?: boolean }>();
    return c.json(await mergePull(needGithub(repoById(b.id)), Number(b.number), b.method ?? "merge", b.sha, !!b.deleteBranch));
  } catch (e) {
    return c.json(err(e), 400);
  }
});

gitApp.post("/pr/close", async (c) => {
  try {
    const b = await c.req.json<{ id: string; number: number }>();
    return c.json(await closePull(needGithub(repoById(b.id)), Number(b.number)));
  } catch (e) {
    return c.json(err(e), 400);
  }
});
