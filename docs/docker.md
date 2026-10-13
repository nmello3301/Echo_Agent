# Running Echo in Docker

Echo runs the same way on any Linux or Windows machine with an NVIDIA GPU: one `docker compose up` starts Echo,
web search (SearXNG) and Hugin. Models and data stay in folders next to the repo, outside git and outside the
image, so each device downloads its models once and keeps them across updates.

## What each device needs

| | Linux | Windows |
| --- | --- | --- |
| GPU | NVIDIA, driver 580 or newer (CUDA 13) | NVIDIA, a current Game Ready/Studio driver |
| Docker | Docker Engine + Compose v2, your user in the `docker` group | Docker Desktop with the WSL2 backend |
| GPU in containers | NVIDIA Container Toolkit (`nvidia-container-toolkit`) | built into Docker Desktop + WSL2 |
| Disk | ~15 GB for the images, plus the models (18 GB for the 27B, 68 GB for Flash-Next) | same |
| RAM | 32 GB minimum, 64 GB for Flash-Next (Strata) | same, and give WSL2 enough memory (`.wslconfig`) |

Check the GPU works in Docker before anything else:
`docker run --rm --gpus all ubuntu:24.04 nvidia-smi`

## First time on a device

```
git clone --recursive <your repo url> Echo
cd Echo
./setup.sh            # Linux
.\setup.ps1           # Windows (PowerShell)
docker compose up -d --build
```

Then open **http://127.0.0.1:7777**.

1. **Models tab:** download the models you want. They go to `./models`.
2. **Flash-Next (Strata):** press **Build** once on each device. The engine compiles for that device's GPU and
   is kept in the `strata` Docker volume.

`setup.sh` / `setup.ps1` write `.env`:
- the Hugin token and password, reusing an existing native Hugin's on Linux;
- the folder the agent may work in;
- your user id, so files the container writes stay yours;
- your time zone.

## The agent's folder

The agent can read and write only `~/Projects` (Windows: `%USERPROFILE%\Projects`), plus Echo's own `data/`.
- **Linux:** the folder appears at the same path inside the container, so `/home/you/Projects/game` works as
  the Agent tab's working folder.
- **Windows:** it appears as `/projects`, so use `/projects/game`.

To give the agent a different folder, change `PROJECTS_DIR` (and `PROJECTS_MOUNT` on Linux) in `.env`, then run
`docker compose up -d`.

Inside the container the agent can't install system packages on your machine, use your desktop apps (Blender,
Godot), or send desktop notifications. The rest works as it does natively, including the bubblewrap sandbox
from `rules.md`.

## Everyday commands

```
docker compose up -d            # start (also after a reboot, unless you stopped it)
docker compose down             # stop everything
docker compose logs -f echo     # Echo's log (engine logs are in data/logs/)
docker compose restart echo     # after editing echo.yaml / models.yaml / rules.md with an editor that replaces the file
git pull && docker compose up -d --build   # update
```

## Per-device settings

- **Strata on a small GPU:** `models.yaml` has `context: 24576` and
  `setup_args: [--kv, q4_0, --draft-vocab, en]` for this 6 GB laptop.
- **12 GB or more of VRAM:** use `context: 32768` (or more) and remove `setup_args`, then press Build again.
- **Ports:** `ECHO_PORT`, `HUGIN_PORT` and `NTFY_PORT` in `.env`.

## Native and Docker on the same machine

Run one or the other: `./echo down` before `docker compose up`, and `docker compose down` before `./echo up`.
They share `./models` and `./data`, so chats, notes and downloaded models carry over. The native install keeps its
own Strata build in `vendor/Strata`; the Docker one builds its own in the `strata` volume.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `error getting credentials - err: exec: "docker-credential-desktop"` | `~/.docker/config.json` still has `"credsStore": "desktop"` from an old Docker Desktop: remove that line. |
| `could not select device driver "nvidia"` | Linux: install `nvidia-container-toolkit` and restart Docker. Windows: update the NVIDIA driver and Docker Desktop. |
| Strata says "out of memory" | Another program uses the GPU (`nvidia-smi`). Close it, or lower `context` in `models.yaml` and Build again. |
| Agent's bash or Python tool fails with "bwrap: ... Operation not permitted" | Keep the `security_opt` lines in `docker-compose.yml`; set `agent.sandbox: false` in `echo.yaml` only as a last resort. |
