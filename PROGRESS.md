# LocalForge: progress

## Status
- [x] Host survey (llama.service broken, node broken, /home 90% full)
- [x] Fix llama.service (quoting, --metrics), benchmark vision projector placement (D1, D2)
- [x] User-local Node LTS (D3)
- [x] Research current docs: llama.cpp web UI, OpenCode 1.19.6 source + OpenAPI, podman/pasta, Playwright MCP, Electron toolchain, noVNC
- [x] Sandbox image (Ubuntu 26.04, XFCE/TigerVNC/noVNC, toolchains, OpenCode, graphify, Playwright MCP, computer-use MCP)
- [x] Verified sandbox networking/isolation: only 127.0.0.1:8081 (proxy) reachable on host loopback, internet OK, keep-id uid mapping, CPU/RAM limits
- [x] Stats proxy (SSE tee, prompt progress, per-session attribution via x-opencode-session-id)
- [x] OpenCode in sandbox -> proxy -> llama-server verified end-to-end (bash tool ran in /workspace as dev)
- [x] Backend: settings, podman, image builder, sandbox manager, OpenCode SDK v2 connection, PTY bridge, templates, AGENTS.md, project creation, checkpoints, stats store, files
- [x] Project creation verified (C++ template builds/tests/runs in sandbox, graph built, initial commit)
- [x] Electron main + preload (allowlisted IPC, sandboxed CJS preload)
- [x] UI: sidebar, chat (streaming markdown, thinking, tool cards, live status, footers, queue, @files, image paste, Plan/Build), right panel (Desktop/Files/Changes/Terminal/Hardware), top bar, dialogs
- [x] Unit tests: 62 passing (stats proxy, tracker, SSE, stats linking, config, sandbox args, templates, checkpoints, files, parsers)
- [x] Backend E2E script (e2e/backend-e2e.ts)
- [x] Package AppImage, install to ~/Applications, .desktop entry + icons
- [x] Playwright-for-Electron UI test (e2e/ui-e2e.ts)
- [x] Final runs, all green on 2026-11-23:
  - unit tests 62/62; typecheck clean
  - backend E2E 19/19 (hello world, screenshot + description, web search/fetch, home isolation)
  - templates 16/16 steps (all 7 templates build/test/run in the sandbox)
  - UI E2E on the installed AppImage 32/32
  - stats verification 13/13 (UI == llama-server log and /metrics)
  - undo / reset / click / plan-mode scripts OK
  - launch from the KDE launcher entry OK
- [x] README.md

## Added after delivery
- [x] "Open existing folder" (import in place): inspection, safety checks, instructions handling, optional checkpoints with snapshot + base commit, graph; unit tests (78 total) and e2e/import-e2e.ts (19/19 on the installed app)

## Fixed during verification
- systemd quoting of the JSON argument in llama.service (D1)
- volume mount made ~/.local root-owned -> pre-created in the image
- zustand selector returning a fresh [] -> infinite render loop
- graphify's echo prefix shown in bash tool cards -> hidden
- checkpoints no longer taken when subagent sessions go idle
- prompt progress bar could step back 1% between server updates -> monotonic
- C++ template prints the classic "Hello, World!"
- XFCE background black on 26.04 -> solid slate; VNC canvas top-aligned

## Notes
- Sandbox image tag = content hash of `sandbox/` (rebuilds automatically when the app's sandbox files change).
- LocalForge's podman storage on this machine: `/mnt/Dev-Gaming/localforge-containers` (see D-entries).
- Dev helpers: `scripts/run-proxy.ts`, `scripts/oc-smoke.ts`, `scripts/try-create.ts`, `scripts/remove-project.ts`.
