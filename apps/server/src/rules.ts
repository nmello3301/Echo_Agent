import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./config.ts";

export type Category =
  | "delete-in-workdir" | "git-local" | "git-discard" | "git-push" | "project-deps" | "global-packages"
  | "network-fetch" | "network-send" | "write-outside-workdir" | "delete-outside-workdir"
  | "system-packages" | "scheduled-jobs" | "write-extensions";

/** What a command needs: run it (category allowed or harmless), ask you, or refuse. */
export interface Verdict {
  kind: "allow" | "ask" | "never";
  category?: Category | "always-ask";
  why: string;
  network?: boolean;     // needs network inside the sandbox
  unsandboxed?: boolean; // must run outside the sandbox (system packages, user timers)
}

export interface Rules {
  text: string;               // rules.md without the questions section, for the main model
  summary: string;            // a short version for the decision model
  allow: Map<string, boolean>;
  extensionDirs: string[];  // patterns from "## Extension folders", ~ expanded, * = one path segment
}

const RULES_FILE = process.env.ECHO_RULES ?? path.join(ROOT, "rules.md");

export function loadRules(file = RULES_FILE): Rules {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {}
  const allow = new Map<string, boolean>();
  const allowed: string[] = [];
  const ask: string[] = [];
  for (const m of raw.matchAll(/^\s*-\s*\[([ xX])\]\s*([\w-]+):\s*(.+)$/gm)) {
    const on = m[1].toLowerCase() === "x";
    allow.set(m[2], on);
    (on ? allowed : ask).push(m[3].replace(/\s*\(.*\)\s*$/, "").trim());
  }
  const extensionDirs: string[] = [];
  const ext = /^## Extension folders[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(raw)?.[1] ?? "";
  for (const m of ext.matchAll(/^\s*-\s*`([^`]+)`/gm)) extensionDirs.push(m[1].replace(/^~(?=\/|$)/, os.homedir()).replace(/\/+$/, ""));
  const text = raw.split(/^---\s*$/m)[0].replace(/^## Questions for you[\s\S]*$/m, "").trim();
  const summary = [
    `Allowed without asking: ${allowed.join("; ") || "nothing"}.`,
    `Needs the user's approval (Echo asks them separately): ${ask.join("; ")}; pushing main or master; system services and /etc.`,
    "Never: deleting system or home folders, formatting disks, force-pushing main, reading credentials.",
    "Deleting build output, caches or files the agent created inside the working folder is routine.",
  ].join("\n");
  return { text, summary, allow, extensionDirs };
}

function patternRegex(pattern: string) {
  const esc = pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
  return new RegExp(`^${esc}(/|$)`);
}

/** The extension folder that contains p, if any. */
export function inExtensionDir(p: string, rules: Rules): boolean {
  return rules.extensionDirs.some((d) => patternRegex(d).test(p));
}

/** Existing folders matching the extension patterns (bound writable into the sandbox). */
export function extensionDirsOnDisk(rules: Rules): string[] {
  const out: string[] = [];
  const walk = (base: string, parts: string[]) => {
    if (!parts.length) {
      if (existsSync(base)) out.push(base);
      return;
    }
    const [head, ...rest] = parts;
    if (head === "*") {
      try {
        for (const d of readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) walk(path.join(base, d.name), rest);
      } catch {}
    } else walk(path.join(base, head), rest);
  };
  for (const d of rules.extensionDirs) walk("/", d.split("/").filter(Boolean));
  return out;
}

/** Add a folder to the "## Extension folders" list in rules.md. */
export function rememberExtensionDir(dir: string, file = RULES_FILE) {
  const raw = readFileSync(file, "utf8");
  const home = os.homedir();
  const shown = dir.startsWith(home + "/") ? `~${dir.slice(home.length)}` : dir;
  if (raw.includes(`\`${shown}\``)) return;
  const lines = raw.split("\n");
  const head = lines.findIndex((l) => l.startsWith("## Extension folders"));
  if (head < 0) throw new Error("rules.md has no \"## Extension folders\" section");
  let last = head;
  for (let i = head + 1; i < lines.length && !lines[i].startsWith("## "); i++) if (/^\s*-\s*`/.test(lines[i])) last = i;
  lines.splice(last === head ? head + 2 : last + 1, 0, `- \`${shown}\``);
  writeFileSync(file, lines.join("\n"));
}

function currentBranch(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const HOME = os.homedir();
const CRUCIAL = ["/", HOME, "/home", "/etc", "/usr", "/boot", "/var", "/bin", "/lib", "/lib64", "/sbin", "/opt", "/root", "/srv"];
const SECRETS = [".ssh", ".gnupg", ".mozilla", ".config/chromium", ".config/BraveSoftware", ".password-store"];

function expand(p: string, cwd: string): string {
  let s = p.replace(/^["']|["']$/g, "");
  if (s === "~" || s.startsWith("~/")) s = HOME + s.slice(1);
  s = s.replace(/^\$HOME|^\$\{HOME\}/, HOME);
  return path.resolve(cwd, s);
}

const inside = (p: string, dir: string) => p.startsWith(dir + path.sep);

/** Split a shell line into simple commands (good enough for policy; the sandbox is the real boundary). */
function commands(line: string): string[][] {
  return line
    .split(/&&|\|\||;|\||\n/)
    .map((c) => c.trim().split(/\s+/).filter(Boolean))
    .filter((c) => c.length);
}

export function classify(line: string, cwd: string, rules: Rules): Verdict {
  const cmdLine = line.trim();
  const decide = (category: Category, why: string, network = false): Verdict =>
    ({ kind: rules.allow.get(category) ? "allow" : "ask", category, why, network });
  const verdicts: Verdict[] = [];
  let dir = cwd;

  // credentials, anywhere in the line
  for (const s of SECRETS) if (cmdLine.includes(`${HOME}/${s}`) || cmdLine.includes(`~/${s}`)) return { kind: "never", why: `touches credentials (~/${s})` };

  for (let words of commands(cmdLine)) {
    while (words[0] && /^\w+=/.test(words[0])) words = words.slice(1); // VAR=x cmd
    const [cmd, ...args] = words;
    if (!cmd) continue;
    if (cmd === "cd" && args[0]) {
      dir = expand(args[0], dir);
      continue;
    }
    const pkgInstall = (c: string, a: string[]) =>
      (/^(pacman|yay|paru)$/.test(c) && a.some((x) => /^-S[a-z]*$|^-U$/.test(x)) && !a.some((x) => /^-R/.test(x))) ||
      (/^(apt|apt-get|dnf|flatpak|snap)$/.test(c) && a[0] === "install");
    if (cmd === "sudo" || cmd === "doas") {
      const [c2, ...a2] = args.filter((x) => !x.startsWith("-"));
      if (c2 && pkgInstall(c2, args.slice(args.indexOf(c2) + 1))) {
        verdicts.push({ ...decide("system-packages", "installs system packages", true), unsandboxed: true });
        continue;
      }
      void a2;
      return { kind: "ask", category: "always-ask", why: "runs as root" };
    }
    if (/^(pacman|yay|paru|apt|apt-get|dnf|snap|flatpak)$/.test(cmd)) {
      if (pkgInstall(cmd, args)) {
        verdicts.push({ ...decide("system-packages", "installs system packages", true), unsandboxed: true });
        continue;
      }
      return { kind: "ask", category: "always-ask", why: "changes system packages" };
    }
    if (cmd === "systemctl" || cmd === "systemd-run" || cmd === "crontab" || cmd === "journalctl") {
      if (cmd === "journalctl" && !args.includes("--vacuum-size") && !args.some((a) => a.startsWith("--vacuum"))) continue;
      if (cmd === "crontab" || args.includes("--user")) {
        verdicts.push({ ...decide("scheduled-jobs", "sets up a scheduled job"), unsandboxed: true });
        continue;
      }
      return { kind: "ask", category: "always-ask", why: "changes system services" };
    }
    if (/^mkfs/.test(cmd) || (cmd === "dd" && args.some((a) => a.startsWith("of=/dev/")))) return { kind: "never", why: "writes to a disk device" };

    if (/^(rm|rmdir|unlink|shred)$/.test(cmd)) {
      const targets = args.filter((a) => !a.startsWith("-"));
      for (const t of targets) {
        const p = expand(t, dir);
        if (CRUCIAL.includes(p.replace(/\/\*?$/, "") || "/") || t === "/*" || t === "~/*") return { kind: "never", why: `would delete ${p}` };
        if (p === cwd || p === path.join(cwd, ".git") || inside(p, path.join(cwd, ".git"))) return { kind: "ask", category: "delete-outside-workdir", why: "deletes the working folder or its git history" };
        verdicts.push(inside(p, cwd) ? decide("delete-in-workdir", "deletes files in the working folder") : decide("delete-outside-workdir", `deletes ${p}`));
      }
      continue;
    }

    if (cmd === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub === "push") {
        const force = args.some((a) => a === "-f" || a.startsWith("--force"));
        const named = args.filter((a) => !a.startsWith("-")).slice(2); // git push <remote> <refspec...>
        const toMain = named.length ? named.some((a) => /(^|:)(main|master)$/.test(a)) : /^(main|master)$/.test(currentBranch(dir));
        if (force && toMain) return { kind: "never", why: "force-pushes main/master" };
        if (toMain) {
          verdicts.push({ kind: "ask", category: "always-ask", why: "pushes to main/master", network: true });
          continue;
        }
        verdicts.push(decide("git-push", force ? "force-pushes to a remote" : "pushes to a remote", true));
      } else if (sub === "reset" && args.includes("--hard")) verdicts.push(decide("git-discard", "discards uncommitted work"));
      else if (sub === "clean" || sub === "restore" || (sub === "checkout" && args.includes("--"))) verdicts.push(decide("git-discard", "discards uncommitted work"));
      else if (sub === "clone" || sub === "fetch" || sub === "pull") verdicts.push(decide("network-fetch", "downloads from a remote", true));
      else if (["commit", "branch", "stash", "checkout", "switch", "merge", "rebase", "tag", "add", "mv", "rm"].includes(sub ?? "")) verdicts.push(decide("git-local", "changes local git state"));
      continue;
    }

    if (/^(npm|pnpm|yarn|bun)$/.test(cmd)) {
      const global = args.some((a) => a === "-g" || a === "--global");
      if (/^(i|install|add|ci|update|up)$/.test(args[0] ?? "")) verdicts.push(global ? decide("global-packages", "installs global packages", true) : decide("project-deps", "installs project dependencies", true));
      continue;
    }
    if (/^(pip|pip3|uv|poetry|cargo|go|pipx)$/.test(cmd) || (cmd.startsWith("python") && args[0] === "-m" && args[1] === "pip")) {
      const a = cmd.startsWith("python") ? args.slice(2) : args;
      const installing = /^(install|add|sync|get)$/.test(a[0] ?? "") || (a[0] === "pip" && a[1] === "install");
      if (!installing) continue;
      const global = cmd === "pipx" || a.includes("--user") || (cmd === "cargo" && a[0] === "install") || a.includes("--break-system-packages");
      verdicts.push(global ? decide("global-packages", "installs packages outside the project", true) : decide("project-deps", "installs project dependencies", true));
      continue;
    }

    if (/^(scp|ssh|nc|ncat|sftp|ftp)$/.test(cmd)) {
      verdicts.push(decide("network-send", "connects to another machine", true));
      continue;
    }
    if (cmd === "rsync" && args.some((a) => /^[\w.-]+@?[\w.-]*:/.test(a))) {
      verdicts.push(decide("network-send", "copies to another machine", true));
      continue;
    }
    if (cmd === "curl" || cmd === "wget") {
      const sends = args.some((a) => /^(-d|--data.*|-F|--form|-T|--upload-file|--post-.*)$/.test(a)) || /-X\s*(POST|PUT|PATCH|DELETE)/i.test(cmdLine);
      verdicts.push(sends ? decide("network-send", "sends data off the machine", true) : decide("network-fetch", "downloads from the internet", true));
      continue;
    }

    // plain redirections or tools writing outside the working folder
    for (const [i, a] of args.entries()) {
      if (a === ">" || a === ">>") continue;
      const m = /^>>?(.+)$/.exec(a);
      const afterRedirect = args[i - 1] === ">" || args[i - 1] === ">>";
      const target = m?.[1] ?? (afterRedirect ? a : undefined) ??
        (["tee", "cp", "mv", "touch", "mkdir", "ln"].includes(cmd) && !a.startsWith("-") ? a : undefined);
      if (!target || target.startsWith("&")) continue;
      const p = expand(target, dir);
      if (CRUCIAL.includes(p)) return { kind: "never", why: `would overwrite ${p}` };
      if (!inside(p, cwd) && p !== cwd && !p.startsWith("/tmp/") && !p.startsWith("/dev/null")) {
        if (inExtensionDir(p, rules)) {
          verdicts.push(decide("write-extensions", `writes ${p} (extension folder)`));
          continue;
        }
        if ((cmd === "cp" || cmd === "ln") && !afterRedirect && !m) {
          // only the destination (last argument) is written
          if (a !== args[args.length - 1]) continue;
        }
        verdicts.push(decide("write-outside-workdir", `writes ${p}`));
      }
    }
  }

  // the strictest verdict wins; network if any part needs it
  const network = verdicts.some((v) => v.network);
  const unsandboxed = verdicts.some((v) => v.unsandboxed);
  const asking = verdicts.find((v) => v.kind === "ask");
  if (asking) return { ...asking, network, unsandboxed };
  return { kind: "allow", category: verdicts[0]?.category, why: verdicts[0]?.why ?? "routine", network, unsandboxed };
}

export function pathVerdict(target: string, cwd: string, rules: Rules): Verdict {
  if (CRUCIAL.includes(target)) return { kind: "never", why: `would overwrite ${target}` };
  for (const s of SECRETS) if (target.startsWith(`${HOME}/${s}`)) return { kind: "never", why: `touches credentials (~/${s})` };
  if (inside(target, cwd)) return { kind: "allow", why: "inside the working folder" };
  if (inExtensionDir(target, rules)) return { kind: rules.allow.get("write-extensions") ? "allow" : "ask", category: "write-extensions", why: `writes ${target} (extension folder)` };
  return { kind: rules.allow.get("write-outside-workdir") ? "allow" : "ask", category: "write-outside-workdir", why: `writes ${target} outside the working folder` };
}
