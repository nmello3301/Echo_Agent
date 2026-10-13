import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Checkpoints are commits built with a private index file and kept under refs/echo/, so the
// working folder's own staging area, branches and history are never touched.
async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "Echo", GIT_AUTHOR_EMAIL: "echo@localhost", GIT_COMMITTER_NAME: "Echo", GIT_COMMITTER_EMAIL: "echo@localhost", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function initRepo(cwd: string) {
  await git(cwd, ["init", "-q"]);
}

async function toplevel(cwd: string) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

async function privateIndex(cwd: string) {
  const gitDir = path.resolve(cwd, await git(cwd, ["rev-parse", "--git-dir"]));
  return path.join(gitDir, "echo-index");
}

/** Snapshot the working tree (respecting .gitignore) as a commit; returns its sha. */
export async function checkpoint(cwd: string, label: string, ref?: string): Promise<string> {
  const top = await toplevel(cwd);
  const idx = await privateIndex(cwd);
  const env = { GIT_INDEX_FILE: idx };
  if (existsSync(idx)) rmSync(idx);
  await git(top, ["add", "-A"], env);
  const tree = await git(top, ["write-tree"], env);
  const sha = await git(top, ["commit-tree", tree, "-m", `echo checkpoint: ${label}`], env);
  if (ref) await git(top, ["update-ref", `refs/echo/${ref}`, sha]);
  return sha;
}

/** Unified diff between a checkpoint and the current working tree. */
export async function diffSince(cwd: string, sha: string): Promise<string> {
  const top = await toplevel(cwd);
  const nowSha = await checkpoint(cwd, "diff");
  return git(top, ["diff", "--no-color", sha, nowSha]);
}

export async function diffStat(cwd: string, sha: string): Promise<string> {
  const top = await toplevel(cwd);
  const nowSha = await checkpoint(cwd, "diff");
  return git(top, ["diff", "--stat", sha, nowSha]);
}

/** Put the working tree back to a checkpoint: restore its files and remove files added since. */
export async function revertTo(cwd: string, sha: string): Promise<string[]> {
  const top = await toplevel(cwd);
  const nowSha = await checkpoint(cwd, "before revert");
  const added = (await git(top, ["diff", "--name-only", "--diff-filter=A", sha, nowSha])).split("\n").filter(Boolean);
  for (const f of added) rmSync(path.join(top, f), { force: true });
  const idx = await privateIndex(cwd);
  const env = { GIT_INDEX_FILE: idx };
  await git(top, ["read-tree", sha], env);
  await git(top, ["checkout-index", "-a", "-f"], env);
  return added;
}
