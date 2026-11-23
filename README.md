# LocalForge

A desktop app for coding with a **local** LLM. One click creates a fully set-up project inside its own
rootless Podman sandbox. The agent ([OpenCode](https://opencode.ai), running headless inside the
sandbox) can build, test, browse the web and drive **its own Linux desktop**, with no risk to your PC.
Live model stats come straight from llama.cpp.

```
┌──────────── LocalForge (Electron + React) ────────────┐
│ sidebar · chat (streaming, thinking, tool cards)      │
│ top bar: model · context meter · sandbox CPU/RAM      │      host 127.0.0.1
│ right panel: Desktop (noVNC) · Files · Changes ·      │
│              Terminal · Hardware                      │
└───────┬────────────────────────────┬──────────────────┘
        │ OpenCode SDK (HTTP+SSE)    │ stats events
        ▼                            │
┌─ podman container per project ─┐   │   ┌──────────────────────┐   ┌──────────────┐
│ opencode serve  :4096 ─────────┼───┼──►│ LocalForge stats     │──►│ llama-server │
│ XFCE + TigerVNC + noVNC :6080  │   └───│ proxy 127.0.0.1:8081 │   │ 127.0.0.1    │
│ computer-use MCP, Playwright   │       └──────────────────────┘   │ :8080 (CUDA) │
│ MCP, graphify, toolchains      │                                  └──────────────┘
│ /workspace = ~/AIProjects/<p>  │
└────────────────────────────────┘
```

## Launching

LocalForge is installed as `~/Applications/LocalForge.AppImage`, with a launcher entry
(`~/.local/share/applications/dev.localforge.LocalForge.desktop`), so it shows up in the KDE
application launcher as **LocalForge** (category Development).

* **First run:** LocalForge builds its sandbox image (Ubuntu 26.04 with XFCE, compilers, Node, Python,
  Rust, vcpkg, OpenCode, graphify, Playwright + Chromium). This takes about 10 minutes and progress is
  shown in the app. The image tag is a hash of the sandbox files, so later runs reuse it and an app
  update that changes the sandbox rebuilds it automatically.
* **Requirements:** llama-server running as the systemd user service `llama.service` (see below),
  rootless Podman with pasta, and an NVIDIA GPU for the Hardware panel (`nvidia-smi`). No sudo needed.
* To run from source instead: `npm install && npm run dev`.

### Using it

* **New project:** give it a name, pick a template (Empty, C++ CMake+vcpkg, Vite React TS, Node
  backend, Python, Rust, Electron), and optionally describe what you want to build. LocalForge then:
  1. creates `~/AIProjects/<name>` and scaffolds the template (it builds out of the box);
  2. writes `AGENTS.md` (global rules plus the template's build/test/run commands), runs `git init`
     and makes the initial commit;
  3. starts the sandbox and writes the OpenCode config (the provider is the stats proxy; the
     computer-use and Playwright MCP servers and Exa web search are enabled);
  4. runs `graphify install --platform opencode` and builds the code graph, then opens a session.
     If you gave a description, the session starts in **Plan** mode with it.
* **Open existing folder** (sidebar, or the second tab of New project): works on a project you
  already have, in place. Nothing is copied or moved; the folder is mounted as `/workspace` in its
  own sandbox. Before anything changes, LocalForge shows what it found: the stack (npm, CMake, Cargo,
  Python, Make…, with guessed build/test/run commands), the git state, and whether the folder has its
  own `AGENTS.md`/`CLAUDE.md`.
  * **Instructions:** your `AGENTS.md`/`CLAUDE.md` is kept as is, and LocalForge's rules go into the
    sandbox only. If there is none, an `AGENTS.md` is added.
  * **Git checkpoints (optional, on by default):**
    * A non-git folder gets `git init` plus a commit of the current files.
    * In an existing repo, uncommitted work is first committed as a snapshot, so Undo can always get
      back to exactly what you imported.
    * Undo never goes into the repo's older history.
    * `graphify-out/` and dependency folders are kept out of git through `.git/info/exclude`; your
      `.gitignore` is never touched.
  * **Refused folders:** your home folder, its parents, system folders and `~/.dotfolders` cannot be
    used, because the agent would see your keys and files.
  * **Removing:** removing an imported project never deletes its folder.
* **Chat:**
  * **Enter** sends and **Shift+Enter** adds a new line.
  * **Tab** toggles **Plan / Build**. Plan is read-only: the agent plans and asks before editing.
  * **@** mentions project files; you can paste images.
  * Messages typed while the agent works are **queued** and sent when it finishes.
  * **Stop** (or Esc) aborts the agent and cancels the generation on the GPU.
* **Checkpoints:** after every completed agent turn LocalForge commits the project (inside the
  sandbox). In **Changes** you see the diff since the last checkpoint, and **Undo to here** restores
  the files and rewinds the conversation to that point.
* **Agent's Desktop:** the sandbox's XFCE desktop. GUI apps the agent launches, and the Playwright
  browser, appear here. **View only** is the default; **Take control** lets you use the mouse and
  keyboard.
* **Terminal:** a bash shell inside the sandbox (`/workspace`).
* **Reset sandbox** (↻ in the top bar): deletes and recreates the container from the current image.
  Project files and chat sessions are kept; anything installed inside the container is lost.

## Live model stats

The stats proxy (127.0.0.1:8081) forwards every request and response between OpenCode and llama-server
unchanged. On streamed requests it adds llama.cpp's `timings_per_token` and `return_progress`, the same
switches llama.cpp's own web UI uses. It then reads the llama.cpp fields from the stream: `timings`,
`prompt_progress` and `reasoning_content`. Each container's OpenCode talks to
`http://127.0.0.1:8081/p/<project>/v1`; OpenCode's `x-opencode-session-id` header ties every request
to its chat session.

* **Thinking block:** expanded while the model reasons and collapsed when the answer starts. The
  header shows the thinking duration and token count.
* **Live status line:**
  * the phase (processing prompt / thinking / writing / calling tool);
  * a prompt-processing bar with % and ETA, using the llama.cpp web UI formula
    `(processed − cache)/(total − cache)` and extrapolated between llama-server's per-batch updates;
  * live tokens/s, tokens generated and elapsed time.
* **Message footer:** prompt tokens (cached), thinking tokens, output tokens, prompt t/s,
  generation t/s, time to first token and total time. Click it for llama-server's raw `timings`.
  Speeds are llama-server's own `prompt_per_second` / `predicted_per_second`.
* **Context meter:** prompt + generated tokens of the session's last request, against the 65,536
  limit. It turns amber at 75% and red at 90%. The tick marks where OpenCode compacts the
  conversation, and a "compacted" badge appears when it does.
* **Hardware panel:**
  * GPU VRAM, utilisation, temperature and power (from `nvidia-smi`), plus host and sandbox CPU/RAM;
  * 5-minute graphs of tokens/s and VRAM;
  * session and project totals (tokens, generation time, average t/s, LLM calls, tool calls).
* **Settings → Stats:** each element can be switched off, and there is a compact/detailed mode.

`npm run verify:stats` checks that these numbers match llama-server's own log and `/metrics`.

## Settings

Settings are stored in `~/.config/LocalForge/settings.json` and are all editable in the app.

| Setting | Default | Notes |
|---|---|---|
| llama-server endpoint | `http://127.0.0.1:8080` | Sandboxes never reach it directly, only through the proxy. |
| systemd unit | `llama.service` | Start/Restart/Stop buttons call `systemctl --user`; log viewer included. |
| Model | from llama.service | Pick any downloaded GGUF model or download one from Hugging Face; uses a systemd drop-in, "Restore original" undoes it. |
| Context / output limit | 65536 / 16384 | Written into each sandbox's OpenCode config. |
| Stats proxy port | 8081 | Changing it requires *Reset sandbox* on existing projects. |
| CPU / memory limit | half the cores (max 8) / 16 GB | Applied live with `podman update`. |
| Require approval | off | When on, edits, shell, web and desktop control ask first (Allow once / Always / Deny). |
| Checkpoint after every turn | on | |
| Desktop click coordinates | screenshot pixels | Alternative: relative 0–1000, as in Qwen-VL grounding. |
| Podman storage root | podman default | On this machine: `/mnt/Dev-Gaming/localforge-containers` (`/home` was 90% full). |
| Stop sandboxes on quit | on | |
| Stats toggles, compact/detailed, theme | all on, detailed, dark | |

## Sandbox and security model

* One rootless Podman container per project. Only the project folder is mounted, at `/workspace`,
  plus a named volume for OpenCode's own state (sessions, undo snapshots). There is no host home,
  no podman/docker socket and there are no host devices.
* `--userns=keep-id`: the agent is `dev` (uid 1000) and its files belong to you on the host. Root
  inside the container maps to an unprivileged subordinate uid.
* Networking is pasta with `-T 8081`: inside the container only `127.0.0.1:8081` (the stats proxy) is
  forwarded to the host's loopback. llama-server and every other loopback-only host service are
  unreachable. The sandbox has normal internet access.
* OpenCode (basic auth, random per-container password) and noVNC are published on `127.0.0.1` only.
* All git operations on projects (checkpoints, diffs, undo) run inside the sandbox, so a malicious
  `.git/hooks` or `core.fsmonitor` never runs on the host. The Files panel refuses symlinks that
  point outside the project.
* CPU, memory and pid limits come from Settings.

## Troubleshooting

| Problem | What to do |
|---|---|
| Top bar says llama-server is down | Click Start or Restart, or check `systemctl --user status llama.service` / `journalctl --user -u llama.service -n 100` (also under Settings → Model → Show log). |
| "Stats proxy could not listen on 127.0.0.1:8081" | Another LocalForge, or another program, holds the port: `ss -ltnp \| grep 8081`. Close it or change the port in Settings. |
| Sandbox fails to start | The error card includes OpenCode's log. Container logs live inside the sandbox at `/tmp/localforge/logs/*.log`. Inspect with `podman --root /mnt/Dev-Gaming/localforge-containers/storage --runroot /run/user/1000/localforge-containers ps -a` (omit the flags if you cleared the storage-root setting). Use **Reset sandbox** to rebuild it. |
| Image build fails | Settings → Sandbox → Build now shows the podman build log. Needs internet access (Ubuntu, nodejs.org, rustup, GitHub, npm, PyPI). |
| Agent is slow | The 16.5 GB Q4_K_M model does not fit fully in 16 GB of VRAM: 48 of 66 layers run on the GPU, so generation runs at ~7–8 t/s and prompt processing at ~550 t/s. The first prompt of a session processes OpenCode's ~15K-token system prompt (≈30 s); after that, prompt caching makes turns fast. |
| Screenshots take ~15 s to reach the model | The vision projector runs on the CPU, to keep VRAM for model layers (see DECISIONS.md, D2). |
| Clicking the AppImage directly asks to "integrate" | That is AppImageLauncher. Use the KDE launcher entry, which sets `APPIMAGELAUNCHER_DISABLE=1`. |
| Wrong or no icon in the task manager | Run `npm run install-app` again (it rewrites the `.desktop` file and icons), then `kbuildsycoca6`. |
| `node` fails with `libsimdjson.so.37` | The system nodejs package is half-upgraded. `sudo pacman -Syu` fixes it; LocalForge development uses the user-local Node in `~/.local/bin` (see DECISIONS.md, D3). |

Uninstall: `node scripts/install-app.mjs --uninstall`. To remove the sandboxes, delete the projects in
the app (or remove the containers, volumes and images with the podman command above).

## Development

```sh
npm install            # also downloads the Electron binary (postinstall)
npm run dev            # electron-vite dev server + app
npm test               # unit tests (vitest)
npm run typecheck      # tsc (TypeScript 7)
npm run dist           # build + package release/LocalForge-<ver>-x86_64.AppImage
npm run install-app    # install the AppImage + launcher entry for this user
npm run e2e:backend    # end-to-end test through the backend (needs llama-server + podman)
npm run e2e:ui         # drives the packaged app with Playwright-for-Electron (add --dev for out/)
npm run verify:stats   # compares UI stats with llama-server's own log and /metrics
```

Layout:

| Path | Contents |
|---|---|
| `src/main/backend/` | The backend: stats proxy, sandbox manager, OpenCode connection, projects, checkpoints, hardware monitor. |
| `src/main/index.ts` | Electron main process and IPC. |
| `src/renderer/` | The React UI. |
| `sandbox/` | The Containerfile, the in-container supervisor and launch scripts, and the computer-use MCP server. |
| `resources/templates/` | The project templates. |
| `e2e/` | The end-to-end and verification scripts. |

See `DECISIONS.md` for every design decision and `PROGRESS.md` for status.

## Verification status

All of these were run on this machine against the real llama-server, Podman and the installed AppImage:

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 62/62 pass: stats proxy (byte-exact forwarding, abort propagation, 502), SSE parser, request tracker on recorded llama-server streams, stats linking, OpenCode config, sandbox security arguments, all 7 templates, git checkpoints (incl. hooks never run), file confinement, parsers. |
| Backend E2E (`npm run e2e:backend`) | 19/19 pass. The agent built and ran a CMake hello world (`Hello, World!`); the screenshot tool returned a real 1280×800 PNG and the model named all five desktop icons; web search and fetch worked from the sandbox; the host home folder is invisible; no podman/docker socket; llama-server reachable only via the proxy. |
| Templates (`e2e/templates-verify.ts`) | 16/16 steps pass: every template builds, tests and runs out of the box in its sandbox. |
| UI E2E on the packaged app (`npm run e2e:ui`) | 32/32 pass. Created a project via the dialog and saw streaming text, the live Thinking block, tool cards, the live status line and prompt progress. Message queueing, @file mentions, image paste (the model answered "red"), Stop (aborted in about 0.6 s, GPU slots freed), the Plan-mode question card (answered by clicking), the Agent's Desktop (noVNC canvas with real content), Hardware, Changes, Terminal and the Plan toggle all worked. Screenshots are in `e2e/output/ui/`. |
| Stats (`npm run verify:stats`) | 13/13 pass on a ~24K-token uncached prompt. Prompt tokens, cached tokens, output tokens, prompt t/s, generation t/s and prompt/eval times shown in the UI equal llama-server's own log lines and `/metrics` deltas. The context meter equals llama-server's KV `n_tokens` + the final token. The progress bar moved through 15 server updates, and the Hardware panel showed live GPU data. Report: `e2e/output/stats/report.md`. |
| Feature scripts (`scripts/*-test.ts`) | Undo to checkpoint; Reset sandbox (files and sessions kept, image upgraded); computer-use clicking (the model double-clicked the Terminal icon at (54, 288) and it opened); a description starts the session in Plan mode (the agent asked clarifying questions and changed no files). |
| Launcher | Started from the KDE `.desktop` entry: runs natively on Wayland, and AppImageLauncher is bypassed. Quitting stops the sandboxes. |

## Limitations

* **Speed is bounded by the hardware.** The Q4_K_M model is larger than the GPU's free VRAM, so 18 of 66 layers run on the CPU, giving about 6–8 tokens/s. With reasoning effort "high", a typical agent turn takes 20 s to several minutes.
* Images (screenshots, pasted images) take about 15 s extra to encode, because the vision projector runs on the CPU (DECISIONS.md, D2).
* Pasta is not a firewall: host services listening on `0.0.0.0` (not just `127.0.0.1`) remain reachable from sandboxes through the host's address.
* Only one stats proxy can listen on the port, so run one LocalForge instance at a time (the app enforces a single window).
* The sandbox has internet access. That is by design (web search, package installs), but it means the agent can download anything.
* Checkpoints are only created when a turn changed files. "Undo" rewinds the conversation with OpenCode's revert; the hidden turns are deleted when you send the next message.

## License

MIT. See [LICENSE](LICENSE).
