/** Git: branch graphs of the repositories in the projects folders and of GitHub repositories, and GitHub pull
 *  requests to review (description, commits, diff) and merge or close. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { Badge, Button, Markdown, Select } from "./ui.tsx";

interface Ref {
  name: string;
  kind: "head" | "branch" | "remote" | "tag" | "pr";
}
interface Commit {
  sha: string;
  parents: string[];
  author: string;
  ts: number;
  refs: Ref[];
  subject: string;
}
interface FileStat {
  path: string;
  additions: number;
  deletions: number;
}
interface Repo {
  id: string;
  kind: "local" | "github";
  name: string;
  dir: string;
  slug?: string;
  meta?: { defaultBranch: string; private: boolean; canMerge: boolean; url: string } | null;
  fetchedAt?: number | null;
}
interface Graph {
  commits: Commit[];
  head: string | null;
  branches: string[];
  dirty: number;
}
interface Pull {
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
interface PullDetail extends Pull {
  body: string;
  mergeable: boolean | null;
  mergeableState: string;
  sameRepo: boolean;
  commits: Commit[];
  files: FileStat[];
  patch: string;
  clipped: boolean;
}

function ago(t: number | string): string {
  const ms = Date.now() - (typeof t === "string" ? Date.parse(t) : t);
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

const SELECTED = "echo.git.repo";

export function Git({ active }: { active: boolean }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [token, setToken] = useState(false);
  const [selected, setSelected] = useState<string>(() => localStorage.getItem(SELECTED) ?? "");
  const [view, setView] = useState<"history" | "pulls">("history");
  const [openPulls, setOpenPulls] = useState<number | null>(null);
  const [error, setError] = useState("");

  const loadRepos = useCallback(() => api<{ repos: Repo[]; token: boolean }>("/api/git/repos").then((r) => {
    setRepos(r.repos);
    setToken(r.token);
    setSelected((s) => (r.repos.some((x) => x.id === s) ? s : r.repos[0]?.id ?? ""));
  }).catch((e) => setError(e.message)), []);
  useEffect(() => {
    if (active) loadRepos();
  }, [active, loadRepos]);
  useEffect(() => {
    if (selected) localStorage.setItem(SELECTED, selected);
  }, [selected]);

  const repo = repos.find((r) => r.id === selected);
  useEffect(() => {
    if (repo?.kind !== "github") setView("history");
  }, [repo?.kind]);

  // how many pull requests are open, for the tab's badge
  useEffect(() => {
    if (!active || repo?.kind !== "github") return setOpenPulls(null);
    api<{ pulls: Pull[] }>(`/api/git/prs?id=${encodeURIComponent(repo.id)}&state=open`).then((r) => setOpenPulls(r.pulls.length)).catch(() => setOpenPulls(null));
  }, [active, repo?.id, repo?.kind]);

  const github = repos.filter((r) => r.kind === "github");
  const local = repos.filter((r) => r.kind === "local");
  return (
    <div className="h-full flex min-h-0">
      <aside className="w-60 shrink-0 border-r border-line overflow-y-auto p-2 text-sm">
        {github.length > 0 && <div className="px-2 pt-1 pb-1 text-[11px] uppercase tracking-wide text-dim">GitHub</div>}
        {github.map((r) => <RepoButton key={r.id} repo={r} selected={r.id === selected} onClick={() => setSelected(r.id)} />)}
        <div className="px-2 pt-3 pb-1 text-[11px] uppercase tracking-wide text-dim">Projects folder</div>
        {local.map((r) => <RepoButton key={r.id} repo={r} selected={r.id === selected} onClick={() => setSelected(r.id)} />)}
        {!local.length && <div className="px-2 text-xs text-dim">No git repositories in the folders listed under git.dirs in echo.yaml.</div>}
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        {error && <div className="m-3 text-sm text-bad border border-bad/40 rounded p-2">{error}</div>}
        {repo && (
          <>
            <header className="flex items-center gap-3 px-4 h-11 border-b border-line shrink-0">
              <span className="font-medium truncate">{repo.name}</span>
              <span className="text-xs text-dim truncate font-mono">{repo.kind === "local" ? repo.dir : repo.meta?.url ?? ""}</span>
              <div className="flex-1" />
              {repo.kind === "github" && (
                <div className="flex rounded-md border border-line overflow-hidden text-xs" role="tablist">
                  {(["history", "pulls"] as const).map((v) => (
                    <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
                      className={`px-3 py-1.5 ${view === v ? "bg-accent/20 text-accent" : "text-dim hover:text-text"}`}>
                      {v === "history" ? "History" : `Pull requests${openPulls ? ` (${openPulls})` : ""}`}
                    </button>
                  ))}
                </div>
              )}
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {view === "history" ? <History key={repo.id} repo={repo} active={active} onFetched={loadRepos} /> : <Pulls key={repo.id} repo={repo} token={token} />}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function RepoButton({ repo, selected, onClick }: { repo: Repo; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={repo.kind === "local" ? repo.dir : repo.slug}
      className={`w-full text-left px-2 py-1.5 rounded-md truncate ${selected ? "bg-panel-2 text-text" : "text-dim hover:text-text"}`}>
      {repo.name}
    </button>
  );
}

// ---------- history: the branch graph ----------

interface LaneRow {
  lane: number;
  before: (string | null)[];
  after: (string | null)[];
  merges: number[];
}

/** Give each commit a lane (column). A lane holds the commit it expects next (its current commit's first parent);
 *  merge commits open lanes for their other parents, and lanes that expect the same commit join at it. */
export function layout(commits: Commit[]): { rows: LaneRow[]; width: number } {
  const lanes: (string | null)[] = [];
  const rows: LaneRow[] = [];
  let width = 1;
  for (const c of commits) {
    const before = lanes.slice();
    let lane = lanes.indexOf(c.sha);
    if (lane < 0) lane = lanes.indexOf(null) >= 0 ? lanes.indexOf(null) : lanes.length;
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.sha) lanes[j] = null;
    lanes[lane] = c.parents[0] ?? null;
    const merges: number[] = [];
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) {
        k = lanes.indexOf(null) >= 0 ? lanes.indexOf(null) : lanes.length;
        lanes[k] = p;
      }
      merges.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, lanes.length, lane + 1);
    rows.push({ lane, before, after: lanes.slice(), merges });
  }
  return { rows, width };
}

const COLORS = ["#7dd3fc", "#4ade80", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c", "#2dd4bf", "#f87171"];
const ROW_H = 28;
/** Lanes narrow down when there are many (up to ~180 px in all), so every commit keeps its dot. */
const laneWidth = (lanes: number) => Math.max(5, Math.min(14, 180 / Math.max(1, lanes - 1)));
const color = (j: number) => COLORS[j % COLORS.length];
const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;

function GraphCell({ row, sha, merge, head, width }: { row: LaneRow; sha: string; merge: boolean; head: boolean; width: number }) {
  const w = laneWidth(width);
  const lx = (j: number) => 9 + j * w;
  const cy = ROW_H / 2;
  const x = lx(row.lane);
  return (
    <svg width={lx(width - 1) + 9} height={ROW_H} className="shrink-0 block" aria-hidden>
      {row.before.map((s, j) => s === null ? null : s === sha
        ? <path key={`in${j}`} d={curve(lx(j), 0, x, cy)} stroke={color(j)} strokeWidth={2} fill="none" />
        : <line key={`p${j}`} x1={lx(j)} y1={0} x2={lx(j)} y2={ROW_H} stroke={color(j)} strokeWidth={2} />)}
      {row.after[row.lane] != null && <line x1={x} y1={cy} x2={x} y2={ROW_H} stroke={color(row.lane)} strokeWidth={2} />}
      {row.merges.map((k) => <path key={`m${k}`} d={curve(x, cy, lx(k), ROW_H)} stroke={color(k)} strokeWidth={2} fill="none" />)}
      <circle cx={x} cy={cy} r={head ? 5.5 : 4.5} fill={merge ? "var(--color-bg)" : color(row.lane)} stroke={head ? "var(--color-text)" : color(row.lane)} strokeWidth={merge || head ? 2.5 : 0} />
    </svg>
  );
}

function RefBadge({ r, head }: { r: Ref; head: string | null }) {
  if (r.kind === "head") return null;
  const tone = r.kind === "tag" ? "warn" : r.kind === "pr" ? "good" : r.kind === "remote" ? "dim" : "accent";
  return <Badge tone={tone}>{r.kind === "pr" ? `PR ${r.name}` : r.kind === "tag" ? `tag ${r.name}` : r.name === head ? `${r.name} ●` : r.name}</Badge>;
}

function History({ repo, active, onFetched }: { repo: Repo; active: boolean; onFetched: () => void }) {
  const [graph, setGraph] = useState<Graph>();
  const [limit, setLimit] = useState(300);
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => api<Graph>(`/api/git/graph?id=${encodeURIComponent(repo.id)}&limit=${limit}`)
    .then((g) => {
      setGraph(g);
      setError("");
    }).catch((e) => setError(e.message)), [repo.id, limit]);

  const fetchNow = useCallback(async () => {
    setStatus("Fetching from GitHub…");
    try {
      await api("/api/git/fetch", { method: "POST", json: { id: repo.id } });
      onFetched();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStatus("");
    }
  }, [repo.id, load, onFetched]);

  useEffect(() => {
    if (!active) return;
    // GitHub: fetch when the mirror is older than a minute. Local: re-read every 10 s, so an agent's commits show up.
    if (repo.kind === "github" && (!repo.fetchedAt || Date.now() - repo.fetchedAt > 60_000)) void fetchNow();
    else void load();
    if (repo.kind !== "local") return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [active, repo.id, load]);

  const lay = useMemo(() => layout(graph?.commits ?? []), [graph]);
  const width = lay.width;
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-4 pb-2 text-xs text-dim">
        {graph && <span>{graph.branches.length} branch{graph.branches.length === 1 ? "" : "es"}{graph.head ? ` · on ${graph.head}` : ""}{graph.dirty ? ` · ${graph.dirty} uncommitted change${graph.dirty === 1 ? "" : "s"}` : ""}</span>}
        {repo.kind === "github" && repo.fetchedAt && <span>· fetched {ago(repo.fetchedAt)}</span>}
        <div className="flex-1" />
        {status && <span>{status}</span>}
        <Button kind="ghost" onClick={repo.kind === "github" ? fetchNow : load}>{repo.kind === "github" ? "Fetch" : "Refresh"}</Button>
      </div>
      {error && <div className="mx-4 mb-2 text-sm text-bad border border-bad/40 rounded p-2">{error}</div>}
      {graph && !graph.commits.length && <div className="px-4 text-sm text-dim">No commits yet.</div>}
      <div role="list">
        {graph?.commits.map((c, i) => (
          <div key={c.sha} role="listitem">
            <button onClick={() => setOpen(open === c.sha ? null : c.sha)} aria-expanded={open === c.sha}
              className={`w-full flex items-center gap-2 pl-3 pr-4 text-left hover:bg-panel-2 ${open === c.sha ? "bg-panel-2" : ""}`} style={{ height: ROW_H }}>
              <GraphCell row={lay.rows[i]} sha={c.sha} merge={c.parents.length > 1} head={c.refs.some((r) => r.kind === "head")} width={width} />
              <span className="flex items-center gap-1 shrink-0">{c.refs.map((r) => <RefBadge key={`${r.kind}${r.name}`} r={r} head={graph.head} />)}</span>
              <span className={`truncate text-sm ${c.parents.length > 1 ? "text-dim" : ""}`}>{c.subject}</span>
              <span className="flex-1" />
              <span className="text-xs text-dim shrink-0 hidden md:inline">{c.author}</span>
              <span className="text-xs text-dim shrink-0 w-16 text-right">{ago(c.ts)}</span>
              <span className="text-xs text-dim shrink-0 font-mono w-16 text-right">{c.sha.slice(0, 7)}</span>
            </button>
            {open === c.sha && <CommitDetail repo={repo} sha={c.sha} />}
          </div>
        ))}
      </div>
      {graph && graph.commits.length >= limit && <div className="px-4 py-2"><Button onClick={() => setLimit(limit + 300)}>Show older commits</Button></div>}
    </div>
  );
}

function CommitDetail({ repo, sha }: { repo: Repo; sha: string }) {
  const [d, setD] = useState<{ sha: string; parents: string[]; author: string; email: string; ts: number; subject: string; body: string; files: FileStat[]; patch: string; clipped: boolean }>();
  const [error, setError] = useState("");
  useEffect(() => {
    api(`/api/git/commit?id=${encodeURIComponent(repo.id)}&sha=${sha}`).then(setD).catch((e) => setError(e.message));
  }, [repo.id, sha]);
  if (error) return <div className="mx-4 my-2 text-sm text-bad">{error}</div>;
  if (!d) return <div className="mx-4 my-2 text-xs text-dim">Loading…</div>;
  return (
    <div className="mx-4 my-2 border border-line rounded-md p-3 bg-panel">
      <div className="font-medium">{d.subject}</div>
      {d.body && <pre className="whitespace-pre-wrap text-sm text-dim mt-1 font-sans">{d.body}</pre>}
      <div className="text-xs text-dim mt-2 font-mono">
        {d.sha} · {d.author} &lt;{d.email}&gt; · {new Date(d.ts).toLocaleString()}
        {d.parents.length > 1 && <span> · merge of {d.parents.map((p) => p.slice(0, 7)).join(" + ")} (changes shown against the first)</span>}
      </div>
      <DiffView files={d.files} patch={d.patch} clipped={d.clipped} />
    </div>
  );
}

// ---------- pull requests ----------

function Pulls({ repo, token }: { repo: Repo; token: boolean }) {
  const [state, setState] = useState<"open" | "closed">("open");
  const [list, setList] = useState<Pull[]>();
  const [number, setNumber] = useState<number | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<{ pulls: Pull[] }>(`/api/git/prs?id=${encodeURIComponent(repo.id)}&state=${state}`)
    .then((r) => {
      setList(r.pulls);
      setError("");
    }).catch((e) => setError(e.message)), [repo.id, state]);
  useEffect(() => {
    void load();
  }, [load]);

  if (number !== null) return <PullView repo={repo} number={number} token={token} onBack={() => { setNumber(null); void load(); }} />;
  return (
    <div className="p-4 max-w-4xl">
      <div className="flex items-center gap-2 mb-3">
        <Select value={state} onChange={setState} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed and merged" }]} />
        <Button kind="ghost" onClick={load}>Refresh</Button>
      </div>
      {error && <div className="text-sm text-bad border border-bad/40 rounded p-2 mb-3">{error}</div>}
      {list && !list.length && (
        <div className="text-sm text-dim">
          No {state} pull requests. The agent's work becomes one with <code className="font-mono">node sdk/cli.ts self branch &lt;name&gt; --pr</code>.
        </div>
      )}
      <div className="flex flex-col gap-2">
        {list?.map((p) => (
          <button key={p.number} onClick={() => setNumber(p.number)} className="text-left border border-line rounded-md px-3 py-2 hover:border-dim bg-panel">
            <div className="flex items-center gap-2">
              <span className="text-dim font-mono text-sm">#{p.number}</span>
              <span className="font-medium truncate">{p.title}</span>
              {p.draft && <Badge>draft</Badge>}
              {p.merged ? <Badge tone="accent">merged</Badge> : p.state === "closed" ? <Badge tone="bad">closed</Badge> : null}
            </div>
            <div className="text-xs text-dim mt-0.5">
              <span className="font-mono">{p.head}</span> → <span className="font-mono">{p.base}</span> · {p.author} · updated {ago(p.updated)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const MERGEABLE: Record<string, { label: string; tone: "good" | "warn" | "bad" | "dim" }> = {
  clean: { label: "Ready to merge", tone: "good" },
  has_hooks: { label: "Ready to merge", tone: "good" },
  unstable: { label: "Mergeable, checks failing", tone: "warn" },
  behind: { label: "Behind its base branch", tone: "warn" },
  blocked: { label: "Blocked by branch rules", tone: "warn" },
  dirty: { label: "Conflicts with its base branch", tone: "bad" },
  draft: { label: "Draft", tone: "dim" },
  unknown: { label: "GitHub is checking mergeability…", tone: "dim" },
};

function PullView({ repo, number, token, onBack }: { repo: Repo; number: number; token: boolean; onBack: () => void }) {
  const [p, setP] = useState<PullDetail>();
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => api<PullDetail>(`/api/git/pr?id=${encodeURIComponent(repo.id)}&number=${number}`).then((d) => {
    setP(d);
    setError("");
  }).catch((e) => setError(e.message)), [repo.id, number]);
  useEffect(() => {
    void load();
  }, [load]);
  // GitHub works out mergeability in the background after a push: ask again shortly
  useEffect(() => {
    if (p?.state !== "open" || (p.mergeableState && p.mergeableState !== "unknown")) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [p, load]);

  async function merge() {
    if (!p || !confirm(`Merge #${p.number} "${p.title}" into ${p.base} on GitHub (${method})?`)) return;
    setBusy("Merging…");
    setError("");
    try {
      const r = await api<{ merged: boolean; sha: string; message: string; deletedBranch: boolean }>("/api/git/pr/merge", { method: "POST", json: { id: repo.id, number, method, sha: p.headSha, deleteBranch } });
      setResult(`${r.message}${r.deletedBranch ? ` Branch ${p.head} deleted.` : ""}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function close() {
    if (!p || !confirm(`Close #${p.number} without merging?`)) return;
    setBusy("Closing…");
    try {
      await api("/api/git/pr/close", { method: "POST", json: { id: repo.id, number } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const mstate = p ? MERGEABLE[p.draft ? "draft" : p.mergeableState || "unknown"] ?? { label: p.mergeableState, tone: "dim" as const } : undefined;
  const writable = token && repo.meta?.canMerge !== false;
  return (
    <div className="p-4 max-w-5xl">
      <Button kind="ghost" onClick={onBack}>← Pull requests</Button>
      {error && <div className="text-sm text-bad border border-bad/40 rounded p-2 my-3">{error}</div>}
      {!p ? !error && <div className="text-sm text-dim mt-3">Loading…</div> : (
        <>
          <h2 className="text-lg font-semibold mt-3">{p.title} <span className="text-dim font-normal">#{p.number}</span></h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-dim mt-1">
            {p.merged ? <Badge tone="accent">merged</Badge> : p.state === "closed" ? <Badge tone="bad">closed</Badge> : mstate && <Badge tone={mstate.tone}>{mstate.label}</Badge>}
            <span><span className="font-mono">{p.head}</span> → <span className="font-mono">{p.base}</span></span>
            <span>· {p.author} · opened {ago(p.created)} · {p.commits.length} commit{p.commits.length === 1 ? "" : "s"} · {p.files.length} file{p.files.length === 1 ? "" : "s"}</span>
            <a href={p.url} target="_blank" rel="noreferrer" className="text-accent underline">on GitHub</a>
          </div>
          {p.body && <div className="mt-3 border border-line rounded-md p-3 bg-panel text-sm"><Markdown text={p.body} /></div>}

          {p.state === "open" && (
            <div className="mt-4 border border-line rounded-md p-3 bg-panel">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={method} onChange={setMethod} options={[
                  { value: "merge", label: "Create a merge commit" },
                  { value: "squash", label: "Squash and merge" },
                  { value: "rebase", label: "Rebase and merge" },
                ]} />
                {p.sameRepo && (
                  <label className="text-xs text-dim flex items-center gap-1.5">
                    <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />delete {p.head} after merging
                  </label>
                )}
                <div className="flex-1" />
                <Button kind="danger" onClick={close} disabled={!writable || !!busy}>Close</Button>
                <Button kind="primary" onClick={merge} disabled={!writable || !!busy || p.draft || p.mergeableState === "dirty"}
                  title={`Merges exactly ${p.headSha.slice(0, 7)}, the commit shown below`}>{busy || "Merge pull request"}</Button>
              </div>
              {!token && (
                <p className="text-xs text-dim mt-2">
                  Merging and closing need a GitHub token: create a fine-grained token at github.com/settings/personal-access-tokens for this
                  repository with Pull requests and Contents set to Read and write, add <code className="font-mono">GITHUB_TOKEN=…</code> to
                  Echo's .env and run <code className="font-mono">docker compose up -d</code>.
                </p>
              )}
              {token && repo.meta?.canMerge === false && <p className="text-xs text-warn mt-2">The token in .env cannot write to this repository.</p>}
              {p.mergeableState === "dirty" && <p className="text-xs text-bad mt-2">The branch conflicts with {p.base}: resolve it first (merge {p.base} into it), then review again.</p>}
            </div>
          )}
          {result && (
            <div className="mt-3 text-sm border border-good/40 rounded p-2 text-good">
              {result} To run it on this PC: <code className="font-mono">git pull</code> in your checkout (for Echo itself, then
              <code className="font-mono"> docker compose up -d --build</code>).
            </div>
          )}

          <h3 className="text-sm font-medium mt-5 mb-1">Commits</h3>
          <div className="border border-line rounded-md divide-y divide-line">
            {p.commits.map((c) => (
              <div key={c.sha} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="font-mono text-xs text-dim">{c.sha.slice(0, 7)}</span>
                <span className="truncate">{c.subject}</span>
                <span className="flex-1" />
                <span className="text-xs text-dim shrink-0">{c.author} · {ago(c.ts)}</span>
              </div>
            ))}
          </div>
          <h3 className="text-sm font-medium mt-5">Changes</h3>
          <DiffView files={p.files} patch={p.patch} clipped={p.clipped} />
        </>
      )}
    </div>
  );
}

// ---------- diffs ----------

/** One file's part of a unified diff: its path and the lines from the first hunk on (headers dropped). */
export function splitPatch(patch: string): { path: string; lines: string[]; binary: boolean }[] {
  return patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git ")).map((p) => {
    const all = p.replace(/\n$/, "").split("\n");
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(all[0]);
    const first = all.findIndex((l) => l.startsWith("@@"));
    return { path: header?.[2] ?? all[0].slice(11), lines: first < 0 ? [] : all.slice(first), binary: all.some((l) => l.startsWith("Binary files")) };
  });
}

const LINE_CAP = 400;

function DiffView({ files, patch, clipped }: { files: FileStat[]; patch: string; clipped: boolean }) {
  const parts = useMemo(() => splitPatch(patch), [patch]);
  const stat = new Map(files.map((f) => [f.path, f]));
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="mt-2">
      <div className="text-xs text-dim mb-2">{files.length} file{files.length === 1 ? "" : "s"} changed · <span className="text-good">+{adds}</span> <span className="text-bad">−{dels}</span></div>
      <div className="flex flex-col gap-2">
        {parts.map((f, i) => <FileDiff key={f.path + i} file={f} stat={stat.get(f.path)} startOpen={i < 12} />)}
      </div>
      {clipped && <div className="text-xs text-warn mt-2">The diff is too large to show in full; the rest is on GitHub or in git.</div>}
    </div>
  );
}

function FileDiff({ file, stat, startOpen }: { file: { path: string; lines: string[]; binary: boolean }; stat?: FileStat; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen && file.lines.length < 1500);
  const [all, setAll] = useState(false);
  const lines = all ? file.lines : file.lines.slice(0, LINE_CAP);
  return (
    <div className="border border-line rounded-md overflow-hidden">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-2 px-3 py-1.5 bg-panel-2 text-left text-sm">
        <span className="w-3 text-dim">{open ? "▾" : "▸"}</span>
        <span className="font-mono truncate">{file.path}</span>
        <span className="flex-1" />
        {stat && <span className="text-xs shrink-0"><span className="text-good">+{stat.additions}</span> <span className="text-bad">−{stat.deletions}</span></span>}
      </button>
      {open && (
        file.binary ? <div className="px-3 py-2 text-xs text-dim">Binary file</div> : (
          <pre className="text-[12px] font-mono overflow-x-auto bg-[#0a0c10] py-1">
            {lines.map((l, i) => (
              <div key={i} className={`px-3 whitespace-pre ${l.startsWith("+") ? "bg-good/10 text-good" : l.startsWith("-") ? "bg-bad/10 text-bad" : l.startsWith("@@") ? "text-accent/70" : "text-dim"}`}>{l || " "}</div>
            ))}
            {!all && file.lines.length > LINE_CAP && (
              <button onClick={() => setAll(true)} className="mx-3 my-1 text-xs text-accent underline">Show all {file.lines.length} lines</button>
            )}
          </pre>
        )
      )}
    </div>
  );
}
