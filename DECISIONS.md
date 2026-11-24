# LocalForge: decisions log

Each entry: what was decided, why, and how to reverse it if needed.

## Host setup

### D1. llama.service: quote the JSON argument for systemd
The existing unit failed on every start with
`--chat-template-kwargs: parse error ... last read: '{r'`. systemd treats bare `"..."` inside an
argument as quoting and strips the quotes, so llama-server received `{reasoning_effort:high}`.
Fixed by single-quoting the whole JSON: `--chat-template-kwargs '{"reasoning_effort":"high"}'`.
Also added the missing `--metrics` flag, `After=network.target` and `RestartSec=5`.
The original unit is unchanged otherwise. (Note: the model's chat template maps `high` to `xhigh`,
which is valid; levels it accepts are `low`, `medium`, `xhigh`.)

### D2. Vision projector: loaded, but kept in system RAM (`--no-mmproj-offload`), context stays 64K
`-hf` already auto-downloads and loads `mmproj-BF16.gguf` (confirmed in the log:
`loaded multimodal model ... mmproj-BF16.gguf`). The Q4_K_M weights alone are 16.56 GB (15.4 GiB),
more than the ~14.9 GiB of VRAM that is free with the desktop running, so the model can never be
fully GPU-resident on this card; llama.cpp's default `--fit on` places as many layers on the GPU
as fit and keeps the rest in RAM. With the projector on the GPU, `--fit` reserves its 1161 MiB
worst case, which pushes more layers to the CPU.

Measured on this machine (5.3K-token prompt, 200-token generation, same flags otherwise):

| config | layers on GPU | prompt t/s | gen t/s |
|---|---|---|---|
| spec as written (projector on GPU, 64K) | 43/66 | 518 | 7.36 |
| **projector in RAM, 64K (chosen)** | **48/66** | **577** | **8.39** |
| projector on GPU, 48K | 45/66 | 540 | 7.81 |
| projector in RAM, 48K | 50/66 | 604 | 8.85 |
| no projector at all, 64K | 48/66 | 576 | 8.39 |

Keeping the projector in RAM gives the same text speed as having no projector, keeps the full 64K
context, and still lets the model see images: a 1280x800 screenshot is encoded in ~14 s on the CPU
and was described accurately. Lowering projector precision was not possible: the repo only ships
BF16/F16 projectors (same size). VRAM use with the chosen config: ~14.9 GiB of 16 GiB, no OOM.
To revert: remove `--no-mmproj-offload` from `~/.config/systemd/user/llama.service`.

### D3. Node.js: user-local official build instead of the broken system package
`/usr/bin/node` (nodejs 26.13.1) fails with `libsimdjson.so.37: cannot open shared object file`
(partial upgrade: simdjson 5.1.1 only ships `.so.36`). Fixing it needs `sudo pacman -Syu`, which
is out of scope. Installed the official Node v26.13.1 LTS tarball (SHA256 verified) to
`~/.local/opt/node-v26.13.1-linux-x64` and symlinked `node`, `npm`, `npx`, `corepack` into
`~/.local/bin` (already first on PATH). The packaged app does not need Node at runtime (Electron
bundles its own). To revert: delete those four symlinks after running `sudo pacman -Syu`.

## Sandbox

### D4. LocalForge's podman storage lives on the big disk (setting, default = podman default)
`/home` was 90% full (33 GB free); the sandbox image is ~6 GB and each project container adds its
own writable layer and caches. The app has a "Podman storage root" setting (default empty = podman's
normal `~/.local/share/containers`); on this machine it is set to
`/mnt/Dev-Gaming/localforge-containers` (where other tool data such as android-sdk already lives).
All podman calls go through one wrapper that adds `--root/--runroot`. The user's global podman
config is untouched. To inspect: `podman --root /mnt/Dev-Gaming/localforge-containers/storage
--runroot /run/user/1000/localforge-containers ps -a`.

### D5. Ubuntu 26.04 LTS base, TigerVNC + XFCE + noVNC, supervisord
Most recent LTS; the whole image (incl. Playwright 1.66's `install-deps`) builds and runs on it
(GCC 15.2, clang 21, CMake 4.2, Python 3.14, Rust 1.100). TigerVNC's `Xvnc` (VNC on the container's
loopback only, no password) + `websockify` for noVNC; XFCE with compositing, screensaver and
blanking off, solid background. supervisord (as the unprivileged user) runs Xvnc, XFCE, websockify
and `opencode serve`. Node is the official v26.13.1 tarball (Ubuntu's nodejs is too old for
Playwright MCP); Rust via rustup; vcpkg cloned + bootstrapped; OpenCode `opencode-ai@1.19.6` via
npm (pinned); graphify `graphifyy==0.9.115` via pipx; Playwright MCP 0.0.86 with the Chromium build
matching its bundled Playwright. Image tag = content hash of `sandbox/` so app updates rebuild it.

### D6. Networking: pasta `-T <proxyPort>` instead of host-loopback mapping
`--network pasta:-T,8081` forwards only the container's 127.0.0.1:8081 to the host's
127.0.0.1:8081 (the stats proxy). Verified from inside the container: the proxy is reachable,
llama-server on 127.0.0.1:8080 and `host.containers.internal:8080` are not, internet works.
`--map-host-loopback` would have exposed every loopback-only host service. Limitation: pasta is
not a firewall, so host services listening on 0.0.0.0 stay reachable via the host's IP. OpenCode
and noVNC are published with `-p 127.0.0.1::<port>` (random host ports, loopback only); OpenCode
uses basic auth with a random per-container password.

### D7. `--userns=keep-id:uid=1000,gid=1000`, agent user `dev` with passwordless sudo
Files the agent creates in /workspace belong to the host user; root inside the container maps to
an unprivileged subordinate uid. Ubuntu's built-in uid-1000 user is replaced by `dev`.

### D8. What is mounted
Only the project folder (`/workspace`). OpenCode's own state (sessions, undo snapshots) is a named
podman volume (`localforge-<id>-opencode`), not a host folder, so chats survive "Reset sandbox".
The OpenCode config is written *into* the container (`podman exec`, then the in-container
supervisor restarts OpenCode) rather than bind-mounted, so nothing else from the host is mounted.

### D9. Limits
Default CPU limit = half the host cores (max 8), memory 16 GB (swap capped at the same), pids 8192,
`/dev/shm` 2 GB for Chromium. Because `nproc` still shows all host cores in a container,
`CMAKE_BUILD_PARALLEL_LEVEL`, `CARGO_BUILD_JOBS`, `VCPKG_MAX_CONCURRENCY` and `MAKEFLAGS` are set
to the CPU limit. Changing limits in Settings applies them live (`podman update`).

## Agent (OpenCode)

### D10. `"tools": true` -> per-model `tool_call: true`
In OpenCode 1.19.6 the top-level `tools` key is a deprecated `{name: boolean}` map that is
converted into permission rules (a literal `"tools": true` fails schema validation, and a map
would silently override approval settings). Tool calling is enabled with the model's
`tool_call: true`. `"limit": {"context": 65536, "output": 16384}` is set on the model as asked.
Web search: `OPENCODE_ENABLE_EXA=1` is set in the sandbox environment (OpenCode's `websearch`
tool uses Exa's hosted MCP endpoint, no key needed); `webfetch` is built in.

### D11. Permissions: targeted auto-approve rules, Plan mode pinned read-only
OpenCode merges the user's `permission` block *after* each agent's own rules, so a global
`"permission": "allow"` would also let Plan mode edit files. Auto-approve therefore only relaxes
the defaults that would prompt (`external_directory`, `doom_loop`, `read` of `.env`), and
`agent.plan.permission.edit` is pinned to deny (except `.opencode/plans/*.md`). With "Require
approval" on, edit/bash/webfetch/websearch/task and all MCP tools (`computer_*`, `playwright_*`)
ask; the UI shows Allow once / Always / Deny. OpenCode's `question` tool is answered in the UI.

### D12. Sampling and titles
The model is configured with `temperature: false`, so OpenCode sends no sampling parameters and
the llama-server flags (`--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0`) apply. OpenCode's title
agent is disabled (it would start a second concurrent generation on the GPU); LocalForge titles
sessions from the first message instead. The llama-server model id (contains `/` and `:`) is
mapped to a clean OpenCode model key, with the real id in the model's `id` field.

### D13. Computer use
A small MCP server (`sandbox/computer-use-mcp`, TypeScript MCP SDK 1.32 + zod 4) wraps xdotool and
ImageMagick: screenshot (PNG image content), click, double_click, move, type, key, scroll,
launch_app, wait. The desktop is 1280x800, which is also the screenshot size (~1000 image tokens),
so coordinates are screenshot pixels; a setting switches to relative 0-1000 coordinates (Qwen-VL
grounding style). OpenCode forwards MCP images to the model as attachments because the model is
declared with `modalities.input: ["text","image"]`. Playwright MCP runs headed on the same desktop
(`--browser chromium` = bundled Chromium), so the user can watch it in the Agent's Desktop panel.
Verified experimentally (`scripts/click-test.ts`): asked to open the desktop's Terminal icon, the
model took a screenshot, double-clicked at (54, 288) (the icon is at about (59, 283)) and a terminal
window opened, so pixel coordinates stay the default.

### D14. graphify
At project creation `graphify install --platform opencode` (skill + plugin) and
`graphify update .` (AST-only graph, no LLM/API key) run in the sandbox; the skill is reinstalled
after a sandbox reset. `graphify-out/` is gitignored so checkpoints stay clean. graphify's
OpenCode plugin prefixes the agent's first bash command with an `echo "[graphify] ..." &&` hint;
the UI hides that prefix in tool cards.

## Stats

### D15. How the proxy gets llama.cpp's data
Same approach as llama.cpp's web UI (now `ui/apps/chat` in the llama.cpp repo): streamed requests
get `timings_per_token: true` and `return_progress: true` (added by the proxy only if the client
did not set them). Response bytes are forwarded unchanged; the proxy parses a copy. Progress =
`(processed - cache) / (total - cache)`, ETA = `time_ms * (todo/done - 1)` (shown after 500 ms),
interpolated smoothly between llama-server's per-batch (2048-token) progress chunks. Requests are
attributed to the project by the URL prefix `/p/<projectId>/v1` and to the chat session by
OpenCode's `x-opencode-session-id` header; each request is linked to its OpenCode assistant
message by exact token match (OpenCode: input + cache.read = prompt_tokens, output =
completion_tokens). Client disconnect (Stop) aborts the upstream request so the GPU stops.

### D16. Which numbers are shown
Speeds are llama-server's own `prompt_per_second` / `predicted_per_second` (identical to its log
lines; the web UI's `n/ms` reads slightly higher because llama-server excludes the first token).
llama.cpp does not report reasoning tokens separately, so the proxy counts generated tokens while
`reasoning_content` streams. Context used = prompt + generated tokens of the session's last request
(= llama-server's `n_tokens` at slot release + the final sampled token, which is never decoded
into the KV cache). OpenCode auto-compacts at `context - min(output, 32000)` = 49,152 tokens; the
meter shows that threshold.

## App

### D17. Terminal via OpenCode's PTY API (no native node-pty)
OpenCode's server has a PTY API (`POST /pty`, `connect-token` with header `x-opencode-ticket: 1`,
websocket `/pty/:id/connect?ticket=`). The main process relays it to xterm.js over IPC, so the
terminal runs inside the sandbox and no native module needs rebuilding for Electron.

### D18. Git safety, checkpoints and undo
After project creation every git command runs *inside* the sandbox. Running the host's git on a
repository the agent controls would execute its hooks and config (`core.hooksPath`,
`core.fsmonitor`, filters) on the host. Checkpoints use `-c core.hooksPath=/dev/null --no-verify`
and are only made when files changed. Their commit messages carry the session/message ids.
"Undo to checkpoint" = OpenCode `session.revert` to the next turn's user message (hides later
turns, restores via its snapshots) + `git reset --hard <commit> && git clean -fd` (ignored build
dirs kept). The Changes diff uses a throwaway index so the agent's staging area is untouched.

### D19. Templates
React = the official current `create-vite` react-ts template (Vite 8, React 19, TypeScript 7,
oxlint). C++ = CMake presets + Ninja + vcpkg manifest (no deps) + CTest. Node = dependency-free
ESM HTTP service + `node --test`. Python = package + `.venv` + unittest. Rust = Cargo (edition
2024). Electron = Electron 45 main/preload/renderer, started with `--no-sandbox` in the container.
All build/test out of the box in the sandbox (verified for C++ in the E2E test).

### D20. Toolchain
electron-vite 6 + Vite 8 + React 19 + Tailwind 4 + TypeScript 7 (the native compiler; what
create-vite ships). The main process is ESM; the preload is CJS because sandboxed preloads cannot
be ESM. Renderer: contextIsolation, sandbox, no nodeIntegration, allowlisted IPC methods.
typescript-eslint is not used (it does not support TS 7 yet).

### D21. Packaging and launcher
AppImage (electron-builder 26, AppImage toolset 1.0.3 without FUSE2), installed as
`~/Applications/LocalForge.AppImage`. The `.desktop` file is named after the Wayland app_id
(`dev.localforge.LocalForge`, from `desktopName`), so KDE matches the window to the launcher icon.
AppImageLauncher is installed on this machine and would intercept the AppImage (moving and renaming
it), so the launcher entry starts it with `APPIMAGELAUNCHER_DISABLE=1`.

### D22. Look and feel
Warm neutral dark theme, serif headings, rounded cards and a chat-centred layout in the spirit of
the Claude Code desktop app, but with LocalForge's own ember accent and anvil logo. No Anthropic
names, logos or the Claude mark. A light theme is available.

### D23. Lifecycle
On launch the most recent project's sandbox is started. Sandboxes stop when the app quits (setting).
New sessions are created on demand. A prompt sent while the agent works is queued in the UI and
sent when the session becomes idle.

## Importing existing projects (added after the first delivery)

### D24. "Open existing folder": in place, non-destructive, sandbox-safe
* **In place:** the folder is bind-mounted as `/workspace`; nothing is copied or moved, and removing
  the project never deletes it, even if a caller asks to (enforced in the backend).
* **Refused folders:**
  * `/`, the home folder and its parents, system folders, and dotfolders directly in home;
  * any folder containing `.ssh`/`.gnupg`/`.aws`/…;
  * paths podman cannot mount (`:`).
  Mounting any of these would hand the agent the user's keys and files.
* **Inspection is read-only and never runs git on the host.** Branch and HEAD are read from `.git`
  files: a repository the agent once controlled could carry hooks or `core.fsmonitor` that execute
  code. All git work happens in the sandbox.
* **Instructions:** if the folder has `AGENTS.md`/`CLAUDE.md`, it is left untouched (OpenCode loads
  the first of these per project) and LocalForge's rules go into the sandbox's global
  `~/.config/opencode/AGENTS.md`, which OpenCode loads in addition (verified: the agent followed both).
  Otherwise an `AGENTS.md` is written, with detected (unverified) commands and a request to confirm
  them.
* **Checkpoints are optional (on by default).**
  * Non-git folders get `git init` and an initial commit.
  * An existing repo's uncommitted work is committed as a snapshot. Without that, Undo's
    `git reset --hard` / `git clean` could destroy work that existed before the import.
  * Each project records a `baseCommit`; Undo only offers LocalForge checkpoints back to that base,
    never the repository's older history (new projects use their initial commit).
  * Excludes go to `.git/info/exclude`, never the user's `.gitignore`. Always excluded:
    `graphify-out/`, `.playwright-mcp/` and dependency folders (`node_modules/`, `.venv/`,
    `__pycache__`, `*.pyc`); these only affect untracked files. New repos also exclude build output.
  * Worktrees/submodules (a `.git` file) cannot use checkpoints, because their repository data is
    outside the mount. Folders inside a bigger repository get a separate repository if checkpoints
    are switched on.
* **Git identity:** every sandbox gets the host user's git name/email as its global git config, so
  checkpoints and the agent's own commits work in repositories without a configured identity.

## Model switching and chat scrolling (added after delivery)

### D25. Switching models without editing the user's unit file
Settings → Model lists the GGUF models already downloaded (llama.cpp's Hugging Face cache and
`~/models`) and can look up any Hugging Face repo's quantizations with their sizes. Switching writes a
systemd drop-in `~/.config/systemd/user/llama.service.d/localforge-model.conf` that replaces ExecStart
with the user's own command line, changing only the model arguments (`-hf org/repo:QUANT`, or
`-m file.gguf` plus a sibling `--mmproj`), then reloads systemd and restarts the unit. A new model is
downloaded by llama-server itself on start (its log is shown in Settings). "Restore original"
deletes the drop-in, so `llama.service` itself is never modified (verified: checksum unchanged after
a real switch and restore). When llama-server answers again, running sandboxes get a fresh OpenCode
config (model id, vision on/off).

### D26. Chat follows the stream only while you're at the bottom
Any upward scroll (wheel, keys, scrollbar) stops auto-follow at once. Previously one wheel tick stayed
inside an 80 px "near bottom" zone and was snapped back. Reaching the very bottom again resumes it, and
a "Jump to latest" button appears while you're reading further up.
When switching to a model other than the original, chat-template options from the unit
(`--chat-template-kwargs`, `--chat-template`, `--chat-template-file`) are left out of the drop-in. They
belong to the original model's template: for example, `reasoning_effort: "high"` is valid for Qwen3.8-27B
but raises a Jinja error in the Unleashed variant's template, which only accepts xhigh/medium/low.
Each other model uses its own template defaults. Switching back to the original restores the unit's
flags unchanged.

### D27. Retry and edit a sent message
Each of your messages has hover buttons for **Run again** and **Edit**. Both rewind to just before
that message, then send it again, unchanged or with the new text (attachments and the Plan/Build
mode are kept). The rewind uses OpenCode's `session.revert`, and the next prompt removes the
reverted messages. With git checkpoints on, the files are reset to the parent of the first
checkpoint made by that message or a later one, or to HEAD to drop an interrupted turn's
uncommitted changes. A confirmation says how many later messages will be removed. Verified by
`e2e/rerun-e2e.ts`: a file created by the answer disappears after Edit, and the old answer is gone.
`scripts/install-app.mjs` now copies to a temp file and renames, so reinstalling never breaks a
running LocalForge.

### D28. Reasoning effort setting
Settings → Model → Reasoning effort offers "Model default", the levels the loaded model's chat
template accepts (llama-server reports them in `/props` → `chat_template_caps.reasoning_effort_levels`,
e.g. low/medium/xhigh for Qwen3.8-27B), and "Off". The stats proxy adds a top-level `reasoning_effort`
to each chat request. llama-server passes it to the template, where it overrides the unit's
`--chat-template-kwargs` (server-common.cpp), and `none` disables thinking. Because it is per request,
it needs no restart. A saved level the current model doesn't accept is not sent, so switching models
can't trigger the "Unexpected reasoning effort" template error. Verified live through the proxy:
low → shorter system instruction and less thinking; none → no reasoning; an unsupported "high" →
ignored, HTTP 200.
Update: the control moved out of Settings into the chat composer, beside Build/Plan. It is a
"🧠 <level>" pill that opens a slider: Off, then the model's levels from least to most effort.
"Model default" places the thumb on the template's own default, parsed from
`reasoning_effort|default('…')` in `/props` → `chat_template`.

### D29. Resizable, collapsible panels and a model switcher in the composer
- The project sidebar and the right panel have drag handles. Double-clicking a handle, or dragging
  the panel well below its minimum, collapses it; buttons (top bar / sidebar header / the panel
  toggle) bring it back at its previous width. Sizes and open/closed state are a per-window
  convenience kept in localStorage.
- The chat always keeps at least 380 px. When the window is too small for the saved widths, the
  right panel gives way first, then the sidebar; the saved widths return when there is room again.
- Drags listen on the window behind a full-screen overlay, which appears only once the pointer
  moves, so double-click still works. An earlier pointer-capture version lost the release over the
  noVNC panel and left the overlay blocking the UI.
- The composer has a model pill (downloaded models, one click to switch with a confirmation that
  warns when the agent is busy; "Download other models…" opens Settings) next to the effort pill.
  Popups render in a portal above everything, clamped to the window.
- Verified by `e2e/layout-e2e.ts`, which runs an isolated instance with its own config/data dirs,
  proxy port 18081 and a fake failing `podman`. It can run next to a LocalForge that is in use.

### D30. One conversation at a time (llama-server -np 1)
llama-server's default is 4 slots sharing one KV pool of the context size (65,536). Two parallel
subagents at 39,258 and 27,663 tokens together exceeded it, and both failed with "Context size has
been exceeded" (the log shows `failed to find free space in the KV cache` after llama.cpp had
already cleared idle slots, via `try_clear_idle_slots` in server-context.cpp). OpenCode treats each
conversation as having the full 64K, so it can't avoid this.
Settings → Model → "One conversation at a time" adds `-np 1` to LocalForge's drop-in: every
conversation gets the full context, and others queue in llama-server. Idle conversations go to
llama-server's RAM prompt cache (`--cache-ram`, 8 GiB default; the machine has ~44 GB free), and the
OpenCode provider has no request timeout, so a queued subagent just waits. The setting defaults to on
and is applied on the next model switch, or right away from the toggle (which restarts llama-server).

### D31. Thinking box scrolling, and what counts as "the user scrolled up"
The reasoning box auto-followed new text unconditionally. It now follows only while you're at the
bottom (within 40 px), like the chat. In both, only real user input stops following: the wheel
turning up, the ArrowUp/PageUp/Home keys, or dragging the scrollbar up (the pointer held on the
area). Previously any upward scrollTop change counted, so a smooth-scroll animation still running
when auto-follow jumped to new text could switch following off by itself.

### D32. Map tab (graphify's code map)
The right panel has a **Map** tab that shows `graphify-out/graph.html`, graphify's interactive
vis-network map. graphify already builds it at project creation and import. "Build/Update map" runs
`graphify update .` in the sandbox: it parses the code, so no LLM and no tokens.
The page is generated from agent-controlled files, so it is treated as untrusted. It is served by a
private `lf-graph://` protocol with its own CSP: inline code plus the bundled library only, no network
(`default-src 'none'`). It runs in a `sandbox="allow-scripts"` iframe that can't reach the app, and
it must be a regular file really inside the project (a symlink pointing elsewhere is refused).
graphify's page loads vis-network 9.1.6 from unpkg.com; that tag is rewritten to a bundled copy
(dependency `vis-network@9.1.6`), so the map works offline. The renderer CSP allows only
`frame-src lf-graph:`. Verified by `e2e/graph-e2e.ts` on the dev build and the packaged AppImage.
LocalForge also adds a collapse button for graphify's side panel (#sidebar). The sandboxed page can't
store anything, so the open/closed state is passed in the URL hash and reported back with
postMessage; the Map tab remembers it.

### D33. Tasks box
The agent's task list (OpenCode's `todowrite` todos) is pinned at the top of the side panel, above
the tabs, so it stays visible whichever tab is open. It loads with the session (`session.todo`) and
updates live from `todo.updated` events. It shows done/total (cancelled tasks aren't counted) with a
progress bar, and the in-progress task is highlighted. It collapses to one line showing the current
task (remembered), and is hidden when the session has no tasks. Verified by `e2e/tasks-e2e.ts`
(isolated instance, events sent the way the backend forwards OpenCode's).

### D34. API models (Venice, OpenRouter, OpenAI, any OpenAI-compatible API)
Online models can be used next to the local one, chosen per chat in the composer's model menu
(Settings → API models to add an API, its key and its models). Design choices:
* **The key never enters a sandbox.** OpenCode keeps talking to the stats proxy; API models are
  listed in its config under the same provider with ids `lf-api/<provider>/<model>`. The proxy
  sees that prefix, swaps in the real model id, adds `Authorization` and sends the request to the
  provider. Only models added in Settings are accepted (404 otherwise; 401 without a key), so the
  agent can't pick another model on the user's bill. Session/project headers are not passed on.
* **Keys** are in `~/.config/LocalForge/api-keys.json` (mode 600), encrypted with Electron
  safeStorage (KWallet/GNOME Keyring) when available, otherwise plain text, which the UI says.
  The renderer only learns whether a key is saved.
* **Switching model doesn't touch the OpenCode config.** Rewriting it restarts OpenCode (which
  would interrupt a running agent), so the choice goes with each message (`model` in
  `promptAsync`). Subagents inherit it: OpenCode's task tool uses `agent.model ?? <parent
  message's model>` (checked in the 1.19.6 binary). Adding/removing API models does rewrite it.
* API requests get no llama.cpp stats fields and no reasoning-effort rewrite (the effort pill is
  hidden); `stream_options.include_usage` is added so token counts still show. For Venice,
  `venice_parameters.include_venice_system_prompt: false`, since the agent has its own.
* Model lists are read from the provider's `/models` (OpenAI, Venice `model_spec`, OpenRouter
  fields understood); models that report no tool calling are marked, as the agent needs tools.
Verified by `tests/apiModels.test.ts` and `e2e/api-models-e2e.ts` (isolated instance against a
fake API: key handling, model list, picking, proxy routing, removal).

### D35. Todo reminder in the proxy

The local model wrote its todo list once and only marked items done at the very end (seen in a
real session: 9 items, about 100 tool calls, then one update with everything completed), so the
Tasks box never moved. The stats proxy now adds a short `<system-reminder>` to the end of the last
tool result when the agent has an unfinished list and has made 8 tool calls since it last called
`todowrite`, then again every 8 calls. It is only in that one request: nothing is stored in the
session, and the cached prompt prefix is unchanged. Subagents (no `todowrite` tool), finished lists
and turns that start with a user message are left alone. Applies to API models too. A matching
rule was added to the AGENTS.md rules for new projects; the reminder also covers existing ones.
