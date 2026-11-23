# LocalForge: what the agent and sandbox can do

Facts about the user's setup. Use them to choose the stack and to write prompts that work there.

## Contents
1. The model
2. The agent (OpenCode) and its tools
3. The sandbox (what is installed, what is not)
4. Seeing and testing what was built
5. Templates
6. Opening an existing folder
7. App features the plan can rely on

## 1. The model
- Qwen3.8-27B (4-bit) on llama.cpp, on the user's RTX 4060 Ti 16 GB. Part of the model runs on the
  CPU, so expect about **6–8 tokens/s** for generation and **400–580 tokens/s** for reading prompts.
- It reasons ("thinks") before acting, and that thinking also costs time.
- It is multimodal: it can see screenshots and images the user pastes (each image ≈ 1000 tokens,
  about 15 s to encode).
- A typical turn with several tool calls takes **3–10 minutes**; a big turn can take 20+.
- **Context:** 65,536 tokens. About 15K go to the agent's system prompt and tool definitions. OpenCode
  automatically **compacts** (summarises) the conversation at ~49K tokens, and details get lost. Reading
  a 400-line file costs ~4–6K tokens; a screenshot ~1000. That's why milestones must be small and
  prompts self-contained.
- Strong at mainstream languages and popular, mature libraries. Weaker on very new APIs: tell it to look
  up current docs (`websearch`/`webfetch`) for anything recent or niche.

## 2. The agent (OpenCode) and its tools
Modes: **Plan** (read-only; explores and proposes, may ask multiple-choice questions as cards) and
**Build** (makes changes). Tab switches between them. A project description given at creation starts
the session in Plan mode.

Tools the agent has:
- Files and shell: `read`, `write`, `edit`, `glob`, `grep`, `list`, `bash`. `bash` stops a command after 2
  minutes unless given a longer `timeout` (in ms; verified in OpenCode's source), so a long build or
  download should be one call with e.g. `timeout: 900000`. Servers that must keep running go in the
  background (`&`).
- Web: `websearch` (Exa), `webfetch` (reads a URL).
- Planning: `todowrite`, `task` (subagents), `question` (Plan mode only).
- Its own desktop (`computer_*`): `screenshot`, `click`, `double_click`, `move`, `type`, `key`, `scroll`,
  `launch_app` (start a GUI program in the background), `wait`. Coordinates are screenshot pixels on a
  1280×800 screen. Tested: it reliably finds and double-clicks desktop icons.
- Browser (`playwright_*`): `browser_navigate`, `browser_snapshot` (text accessibility tree: cheap and
  precise), `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`,
  `browser_take_screenshot`, `browser_console_messages`, `browser_evaluate`, `browser_wait_for`. The
  browser is headed on the agent's desktop, so the user can watch.
- `graphify query "<question>"` (via bash): a code knowledge graph, useful in larger or unfamiliar
  codebases.

Every project has an AGENTS.md with standing rules (read before editing, small focused changes, build/test
after each change, retry failed tool calls, check docs, verify GUIs with screenshots and web apps with
Playwright). Prompts don't need to repeat them.

## 3. The sandbox
Ubuntu 26.04 container. The project folder is mounted at `/workspace`. The agent is user `dev` with
passwordless `sudo`, so it can `apt-get install` anything. Internet access is available.

Installed: gcc 15, clang 21, CMake 4.2, Ninja, gdb, vcpkg (`$VCPKG_ROOT`), Node 26 + npm 11, Python 3.14
(+ venv, pip, pipx), Rust 1.100 (cargo, clippy, rustfmt), git, ImageMagick, xdotool, Chromium (via
Playwright), XFCE desktop.

Not available, or needs care:
- **No GPU, CUDA or Vulkan.** OpenGL 4.5 works through software rendering (llvmpipe): 2D games and light
  3D are fine, heavy 3D is slow. No machine learning on a GPU.
- **No sound device.** Games and apps using audio must not crash without one: SDL/pygame with
  `SDL_AUDIODRIVER=dummy`, or wrap mixer init in a try/except.
- **Python is 3.14.** `pip install pygame` fails (no wheel). Use **`pygame-ce`** instead (`pip install
  pygame-ce`, still `import pygame`; verified). PySide6 installs fine. **tkinter is not installed**:
  `sudo apt-get install -y python3-tk` first.
- **No Docker or Podman inside the sandbox.** Use the services directly (e.g. SQLite instead of a Postgres
  container; `sudo apt-get install postgresql` works if really needed).
- **Not preinstalled:** Go, Java, .NET, Flutter, Android SDK. All installable with apt or official
  scripts, but each adds time. Prefer what's installed unless the user insists.
- **npm 11 does not run package install scripts by default.** Packages that compile native code at
  install time (e.g. `better-sqlite3`, `bcrypt`, `sharp` on some setups) may need
  `npm install-scripts approve <pkg>` then a reinstall. Prefer pure-JS alternatives when there's a choice.
- CPU and RAM are limited (by default half the host cores, max 8, and 16 GB).

## 4. Seeing and testing what was built
- **Web dev servers are only reachable inside the sandbox.** The user's normal browser cannot open
  `localhost:5173`. The agent tests with Playwright, and the user watches in the **Agent's Desktop** panel
  (Chromium on the desktop, also launchable with `computer_launch_app "chromium http://127.0.0.1:5173"`).
  Servers must run in the background, e.g. `npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/dev.log 2>&1 &`.
- **GUI apps** (Electron, tkinter, Qt, pygame, raylib…) are started with `computer_launch_app`, then
  checked with `computer_screenshot`. Electron needs `--no-sandbox` inside the container.
- **Cheap self-checks:**
  - unit tests;
  - CLI output compared with expected text;
  - `curl` for APIs;
  - `browser_snapshot` for web pages;
  - for games/graphics, a headless "render N frames and save a PNG" mode, which the agent can open with
    `read` and look at.
- The project files live on the user's PC at `~/AIProjects/<name>` (or wherever an imported folder is).
  The user can open them directly or run the result outside the sandbox later.

## 5. Templates (all build out of the box)
| Template | What you get | Commands |
|---|---|---|
| Empty | README + git, choose the stack later | none |
| C++ (CMake + vcpkg) | C++20, CMake presets, Ninja, vcpkg manifest (add deps to `vcpkg.json`), CTest; prints "Hello, World!" | `cmake --preset default && cmake --build --preset default`, `ctest --preset default`, `./build/<name>` |
| Vite + React + TypeScript | official create-vite react-ts (Vite 8, React 19, TS 7, oxlint) | `npm run build`, `npm run lint`, `npm run dev -- --host 0.0.0.0 --port 5173` |
| Node backend | dependency-free ESM HTTP server (`src/app.js`, `src/server.js`, `/health`), `node --test` | `npm test`, `npm start` (port 3000) |
| Python | package folder named after the project, `.venv`, unittest | `.venv/bin/python -m unittest discover -s tests -v`, `.venv/bin/python -m <package>` |
| Rust | Cargo binary crate (edition 2024) with a unit test | `cargo build`, `cargo test`, `cargo run` |
| Electron app | Electron 45 main/preload/renderer, `node --test` smoke test | `npm test`, `npm start` (runs on the agent's desktop) |

Choosing:
- **Web UIs, dashboards, browser games:** Vite + React + TS. Plain canvas games can also live there.
- **Python scripts, data tools, pygame-ce games, PySide6/tkinter GUIs:** Python.
- **Native performance or raylib/SDL games in C/C++:** C++ (raylib and SDL2 are in vcpkg).
- **APIs and small servers:** Node backend.
- **CLI tools:** Rust or Python.
- **Desktop apps with web tech:** Electron.
- **Anything else:** Empty.

## 6. Opening an existing folder
"Open existing folder" (sidebar) uses a folder in place; nothing is copied. The dialog shows the
detected stack, the git state, and whether the project has its own `AGENTS.md`/`CLAUDE.md`, which is
kept, with LocalForge's rules added inside the sandbox only.
- **Git checkpoints (on by default):** a non-git folder gets `git init`, and uncommitted work in a repo
  is committed as a snapshot first, so Undo can return to the imported state. Undo never goes into older
  history.
- **Knowledge graph (on by default):** helps the agent navigate unfamiliar code.
- **Optional "What do you want to do with it?" box:** starts the session in Plan mode.
- Refused folders: the home folder, system folders and `~/.dotfolders`.

For existing code the first milestone should be exploration: the agent reads the README and build files,
runs the build/tests, and records the real commands in AGENTS.md. Only then come changes. For bugs, have
it reproduce the bug first (ideally as a failing test).

## 7. App features the plan can rely on
- **Checkpoints:** a git commit after every completed agent turn. The **Changes** tab shows the diff and
  has **Undo to here**, which restores files and rewinds the chat. The cleanest recovery from a bad
  turn is to undo, then send a narrower prompt.
- **New session** (sidebar): a fresh context for the same project.
- **Context meter** (top bar): turns amber at 75% (compaction is near) and red at 90%.
- **Queue:** messages typed while the agent works are sent when it finishes. Fine for a quick
  follow-up, but checking each milestone first is better.
- **Stop** (or Esc) aborts the agent immediately.
- **@file** in the chat box attaches a project file; **pasting an image** sends it to the model (e.g. a
  UI sketch or a screenshot of a bug).
- Right-panel tabs:
  - **Agent's Desktop** (watch or take control);
  - **Files**;
  - **Changes**;
  - **Terminal** (a shell in the sandbox);
  - **Hardware** (tokens/s, VRAM).
