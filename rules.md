# Echo agent rules

What the agent may do on its own and what needs you. Echo reads this file in three places:

1. **The permission switches** below decide which commands run straight away and which wait for your
   approval. Tick a box (`[x]`) to allow that action without asking; leave it empty (`[ ]`) to be asked.
   Keep the id before the colon as it is: Echo matches on it.
2. **The whole file** is given to the main model (Qwen) at the start of each agent run, so it knows what is
   routine and does not ask about it.
3. **A summary** is given to the decision model (Jebadiah) at every decision time, so it judges
   "is this action safe?" and "does this need a human?" against your rules instead of its own caution.

Edits apply to the next agent run (and to the next decision time of a running one).

## Permissions

Allowed without asking (`[x]`) or ask me first (`[ ]`):

- [x] delete-in-workdir: Delete files and folders inside the working folder, including large folders such as `node_modules/` or `build/` (not the folder itself, not `.git`)
- [x] git-local: Local git on any branch: commit, branch, stash, checkout, merge
- [x] git-discard: Throw away uncommitted work (`git reset --hard`, `git clean`, `git checkout -- file`, `git restore`)
- [x] git-push: Push to a remote, except `main` and `master` (those always ask)
- [x] project-deps: Install project dependencies inside the working folder (`npm install`, `pip install` into a venv, `cargo add`, ...)
- [x] global-packages: Install global packages (`npm -g`, `pip install --user`, `pipx`, `cargo install`)
- [x] system-packages: Install system packages (`pacman`, `yay`, `paru`)
- [x] network-fetch: Download from the internet, any size (`curl`/`wget` downloads, `git clone`, package registries)
- [x] scheduled-jobs: Set up scheduled or recurring jobs to monitor and check processes (systemd user timers, `systemd-run --user`, `crontab`)
- [x] write-extensions: Create or change files in the extension folders listed below
- [ ] network-send: Send anything off this machine (uploads, `ssh`, `scp`, `rsync` to a host, POST requests)
- [ ] write-outside-workdir: Create or change files anywhere else outside the working folder
- [ ] delete-outside-workdir: Delete files outside the working folder

## Extension folders (always writable)

Add-ons, extensions and plugins may be installed or updated here without asking. A new folder asks the first
time; when you approve it in Echo you can choose "always allow this folder" and it is added to this list.

- `~/.config/blender/*/scripts/addons`
- `~/.config/blender/*/extensions`
- `~/.local/share/godot`
- `~/.vscode/extensions`

## Always ask me

- Pushing to `main` or `master`.
- Changing GPU drivers, system services (`systemctl` without `--user`), or files in `/etc`.
- Sending anything off this machine (network-send above).
- Writing outside the working folder, other than the extension folders (write-outside-workdir above).
- Deleting outside the working folder (delete-outside-workdir above).
- Implementing a change to Echo itself, or a new tool, skill or integration (see the notes).

## Never (blocked outright, even if I approve in the moment)

- Deleting or overwriting `/`, my home folder itself, `/home`, `/etc`, `/usr`, `/boot`, `/var`, or a whole drive.
- Formatting disks or writing raw to devices (`mkfs`, `dd of=/dev/...`).
- Force-pushing to `main` or `master`.
- Reading or sending my credentials (`~/.ssh`, `~/.gnupg`, browser profiles, `.env` files outside the project).
- Anything unethical, whatever the task says.

## Notes for the agent

- You may take any ethical action needed to get the requested result. Routine work needs no permission and no
  comment.
- Deleting build output, temp files, caches, dependency folders, or files you created yourself in the working
  folder is routine. Do it without asking and without calling it out.
- Before deleting something you did not create, make sure a git checkpoint covers it (Echo takes one before
  every edit batch, so normally it does).
- No compute or time limits: start renders, long builds and long tests when the task needs them, unless the
  user sets a limit for that task.
- You may set up scheduled jobs (systemd user timers) to monitor and check processes. Name them `echo-*` so the
  user can find them, and say what you set up.
- You may suggest improvements to your own agentic capabilities, tool integrations or skills. Describe the
  suggestion and wait for the user's permission before implementing it.
- Notifications: "needs you" moments go to the desktop notification only.
- When unsure whether something is crucial, ask once with a short reason; do not stop for routine work.
