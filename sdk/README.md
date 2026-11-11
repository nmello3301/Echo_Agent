# Echo SDK

Drive Echo's agent from scripts and the terminal: start runs, stream what the agent does, answer its approval
requests by policy or in code, send follow-ups, diff and revert. It also runs the **self-work loop**, where the agent
changes Echo itself in a working copy that you review before merging.

No dependencies: Node 22.18+ runs `index.ts` and `cli.ts` as they are, on the host (Windows or Linux) or in the
container. It talks to Echo over HTTP at `$ECHO_URL` (default `http://127.0.0.1:7777`).

## Command line

```
node sdk/cli.ts status                                    # model, engines, dev instance, live runs
node sdk/cli.ts run --cwd /projects/thing "add a CLI flag for verbose output"
node sdk/cli.ts run --cwd /projects/thing --chat "..."    # keep talking to it after each turn
node sdk/cli.ts follow <run-id> --chat                    # pick up a live run (from the UI or another terminal)
node sdk/cli.ts send <run-id> "now add a test for it"
node sdk/cli.ts diff <run-id>
```

`--cwd` is the folder as Echo sees it: in Docker that is `/projects/...` (your `PROJECTS_DIR`). `npm run sdk -- ...`
works too. `node sdk/cli.ts help` lists every option.

**Approvals.** A command that rules.md says needs approval pauses the run. `--approve ask` (the default in a terminal)
asks you there; `ui` leaves it for the web UI's Agent tab; `no` refuses; `yes` approves everything, and approved
commands run outside the sandbox, so use it only for tasks you trust. `--hitl` does the same for "needs you" questions
from decision time (`ask`, `continue`, `stop`, `ui`).

## Self-work: Echo improving Echo

```
node sdk/cli.ts self init          # clone this repo to <PROJECTS_DIR>/echo and link it to the live install
node sdk/cli.ts self run "research low-latency speech-to-text options and add a live chat mode"
node sdk/cli.ts self dev start     # run the copy; open http://dev.localhost:7777
node sdk/cli.ts self diff          # what the agent changed
node sdk/cli.ts self branch        # bring it back here as a branch: review with git diff, then merge
node sdk/cli.ts self branch echo-self/live-chat --pr   # same, then push it to GitHub and print the pull request link
node sdk/cli.ts self sync          # after merging, fast-forward the copy to continue from there
```

What happens:

- **A working copy, never the live tree.** `self init` clones the last commit of this repo into the projects
  folder (the agent's workspace) and links its `node_modules`, `models`, Python venvs and llama.cpp to the live
  install, so it runs at once without downloading anything. The copy is a normal git repository; the agent commits
  its verified steps there.
- **The agent knows the codebase.** `AGENTS.md` (repo root) is loaded into every run in the copy: a map of the code,
  how the pieces connect, measured model speeds and the conventions. That saves the exploring a local model
  otherwise spends its context on.
- **Tools for working on itself.** A run in an Echo working copy gets three more tools:
  - `echo_verify`: typecheck (server, web, SDK), tests and Python syntax, in the sandbox, reporting only failures
    (~2 s).
  - `echo_dev`: run the copy as a **dev instance** beside the live Echo. It is sandboxed (it can write only inside
    the copy), uses the live Echo's model, decision model and notes search (a second 27B would not fit in VRAM), and
    runs its own UI, TTS and any new service on ports + 1000. You see it at **http://dev.localhost:7777**; the live
    Echo stays at http://127.0.0.1:7777.
  - `echo_dev_request`: call the dev instance and time it: time to headers, first bytes and done, the arrival time of
    each server-sent event, audio length. It can save a response to a file and send a file, to chain TTS output into
    an STT test.
- **You merge.** `self branch` commits what is left in the copy onto a new branch there and fetches it into this
  repo; your checkout is not touched. Review it with `git diff HEAD...<branch>`, merge it, then rebuild Echo
  (`docker compose up -d --build`). With `--pr` it also pushes the branch to `origin` and prints the GitHub link that
  opens the pull request (no `gh` needed); merge it there, `git pull`, and rebuild. Running `self branch <same name>`
  again adds the copy's newer work to that branch (and with `--pr` pushes it, updating the pull request).
- **New models go into the copy.** The copy's `models/` holds one link per live model folder; a model its code
  downloads (a new `models/<name>`) lands in the copy. After the merge, the live Echo downloads it on first use.

The copy's path on this machine and inside Echo come from `.env` (`PROJECTS_DIR`, `PROJECTS_MOUNT`); override them
with `--dir` and `--mount` (or `ECHO_SELF_DIR` and `ECHO_SELF_MOUNT`).

## In code

```ts
import { Echo } from "./sdk/index.ts";

const echo = new Echo(); // or new Echo({ url: "http://127.0.0.1:7777" })

const { run, result } = await echo.task({
  cwd: "/projects/echo",
  task: "Measure time to first audio of the Read tab's TTS for a 20-word sentence, 5 runs",
  effort: "low",
  stepBudget: 12,                                   // tool calls between decision times
  instructions: "Report numbers in a table.",       // added to the system prompt for this run
  onEvent: (e) => e.kind === "tool_start" && console.log("→", e.name),
  onApproval: (req) => req.action.startsWith("npm "), // true / false / undefined (leave it for the UI)
  onHitl: () => "continue",
});
console.log(result.status, result.text);           // idle, plus the agent's last message

const next = await run.send("Now try it with the Pocket TTS voice");
console.log(next.text, next.toolCalls.length, next.durationMs);
console.log(await run.diff());
```

- `echo.start(opts)` returns a `Run` without waiting; `run.turn(handlers)` follows the current turn until it
  settles (`idle`, `paused`, `stopped` or `error`) and returns a `TurnResult`.
- `paused`: the run's model was unloaded (the Monitor's Unload, or another main model loaded in its place) while it
  worked. `run.resume()` (CLI: `node sdk/cli.ts resume <run>`) or `run.send(text)` loads the model and carries on.
- `run.events({ after })` is the raw stream: stored events (numbered by `seq`) after `after`, then live ones,
  including `text_delta` and `thinking_delta` as the model writes. It reconnects from the last `seq` if the
  connection drops.
- `echo.self.link / verify / dev.start / dev.stop / dev.logs` are the self-work calls; paths are as Echo sees them.

Event kinds: `task`, `user`, `note`, `status`, `phase`, `message` (`text`, `thinking`), `text_delta`,
`thinking_delta`, `tool_start` (`name`, `args`), `tool_end` (`result`, `isError`, `ms`), `todo`, `checkpoint`,
`decision`, `approval`, `approval_result`, `hitl`, `hitl_reply`, `revert`, `error`.

## HTTP API

The SDK uses these endpoints, also usable directly:

| Endpoint | |
| --- | --- |
| `POST /api/agent/runs` | `{cwd, task, effort?, model?, instructions?, stepBudget?}` → the run's summary |
| `GET /api/agent/runs/:id/events?after=N` | SSE: stored events after seq N, then live ones (`event: event`), `ping` every 15 s |
| `POST /api/agent/runs/:id/message` · `/answer` · `/resume` · `/stop` · `/revert` | follow-up, approval/reply, carry on after a pause, stop, revert |
| `POST /api/models/unload` | unload the main model: runs working on it pause → `{id, name, reason, paused, requests}` |
| `GET /api/agent/runs/:id` · `/diff` | summary and stored events; changes since the start |
| `POST /api/self/link` · `/api/self/verify` | `{dir}`: link a working copy; check it |
| `GET /api/self/dev` · `POST /api/self/dev/start` · `/stop` · `GET /api/self/dev/logs` | the dev instance |
