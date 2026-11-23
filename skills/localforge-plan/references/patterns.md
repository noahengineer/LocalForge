# Milestone patterns by project type

Read the section that matches the project. Each section lists a good milestone order and the checks
that work inside the sandbox. Example prompts at the end show the level of detail to aim for.

## Contents
- Web app (React/Vite)
- CLI / tool / script
- Desktop GUI app
- Game
- Backend / API
- Existing project (feature or bug fix)
- Example prompts

## Web app (React/Vite template)
Order:
1. PLAN.md + app shell/layout with placeholder sections.
2. Data model + state, kept in `localStorage` unless a server is truly needed, with a small pure-logic
   module tested with vitest (`npm i -D vitest`; add `"test": "vitest run"`).
3. One feature (or screen) per milestone.
4. Polish/styling.
5. Production build check.

Checks:
- `npm run build` and `npm run lint` pass.
- Dev server running in the background:
  `npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/dev.log 2>&1 &` (only start it if it isn't
  already running).
- Then `playwright_browser_navigate http://127.0.0.1:5173` and `browser_snapshot`, confirming that
  specific text, buttons and values are present. Use `browser_take_screenshot` only for visual/layout
  milestones.
- Interactions: tell the agent exactly what to click or type, and what the page must then show.
- Repeat the dev-server line in *every* milestone that checks the page ("start it if it isn't
  running"). A new session doesn't know it exists.
- Downloads/exports (CSV, JSON, images): Playwright MCP has no download inbox. Put the file content in
  a pure function (`buildCsv(entries)`) with unit tests, then in the browser check the wiring with
  `browser_evaluate`. For example, wrap `URL.createObjectURL` to capture the Blob, click Export, and
  return `await blob.text()` for comparison.
- Fill date inputs with the ISO format (`2025-03-14`). Beware of `toISOString()` shifting dates
  across time zones in date-only logic.

Notes:
- Charts: a mature library (Chart.js via react-chartjs-2, or Recharts), with a docs lookup first.
- Keep CSS simple (plain CSS modules); no UI framework unless the user asks.

## CLI / tool / script (Python, Rust, Node, C++)
Order:
1. PLAN.md + argument parsing with `--help`.
2. Core logic as pure functions, with unit tests.
3. Each command or option.
4. Error handling and messages.
5. README usage section.

Checks:
- Exact commands with exact expected output, e.g.
  `.venv/bin/python -m convert 42 km mi` prints `42 km = 26.10 mi`.
- Tests pass.
- Error cases: a bad input prints a clear message and exits with code 1.

Notes:
- Put sample input files in `examples/` so the checks can use them.
- Tools that hit the network (APIs, scrapers, downloaders): keep routine checks offline or tiny (a
  recorded JSON response in `tests/fixtures/`, a mocked session, a 3–5 item real example). Do one
  full real-world run, once, in a late milestone, with the bash tool's `timeout` raised (e.g.
  900000 ms) rather than polling a log.

## Desktop GUI app (Electron, tkinter, PySide6/Qt, …)
Order:
1. PLAN.md + an empty window that opens.
2. The main layout.
3. Wire up one feature per milestone; keep the logic in a separate, testable module.
4. Persistence (a JSON file in the app's data folder).
5. Packaging, if wanted.

Checks:
- Logic tests.
- Launch with `computer_launch_app` (Electron: `npm start`, which already passes `--no-sandbox` in the
  template).
- Then `computer_screenshot` and describe what must be visible.
- For interaction: `computer_click` on the named control, then screenshot again.
- Limit to 1–2 screenshots per milestone.

Notes:
- tkinter is the quickest choice for simple tools, but in the sandbox it needs
  `sudo apt-get install -y python3-tk` first.
- Qt (PySide6) gives nicer UIs (pip install).
- Electron if the user wants web tech.

## Game
Pick by the user's taste:
- **Python + pygame-ce:** easiest. `.venv/bin/pip install pygame-ce` (plain `pygame` has no wheel for
  Python 3.14 and fails to install; pygame-ce is a drop-in, still `import pygame`). Set
  `os.environ.setdefault("SDL_AUDIODRIVER", "dummy")` only when no audio device is available (or
  always in the sandbox via the run command). `pygame.init()` itself is fine; just never let
  `pygame.mixer` failures crash the game.
- **Browser canvas** (React template or plain Vite): easy to verify with Playwright.
- **C++ + raylib:** `"dependencies": ["raylib"]` in `vcpkg.json`. Needs a build per check, and the first
  vcpkg build takes several minutes.
- Rendering is software OpenGL (fine for 2D/light 3D). There is no sound device: audio must be optional
  or dummy.

Order:
1. PLAN.md + window/canvas with a game loop drawing the background and a moving placeholder.
2. Pure game-state module (positions, rules, collisions, scoring) with unit tests. No rendering code,
   so it is testable.
3. Rendering of the state.
4. Input.
5. Game over / restart / score.
6. High scores saved to a JSON file.
7. Polish: menus, simple generated sound effects behind an "audio available" check.

Checks:
- Rules via unit tests; they are deterministic: pass a seed for randomness.
- Live-window checks (focus, key presses on a real window) are flaky in a VNC desktop. Prefer unit
  tests that feed input events to the update function, plus one headless render for visuals. Use
  `launch_app` + `computer_screenshot` only for the final "it opens and looks right" milestone.
- Rendering: add a `--screenshot out.png --frames N` mode (or, for canvas, a Playwright screenshot) so
  the agent can verify visuals without playing interactively. It can `read` the PNG to see it.
- Input: simulate key presses in tests (pygame events), or with `computer_key` after `launch_app`.

## Backend / API (Node template, or Python FastAPI)
Order:
1. PLAN.md + routes skeleton returning stub JSON.
2. Data layer: SQLite via Node 26's built-in `node:sqlite`, or Python's `sqlite3` (no native install
   scripts needed).
3. One endpoint group per milestone, with tests.
4. Validation and errors.
5. A simple HTML page or OpenAPI docs, if wanted.

Checks:
- `npm test` / pytest.
- `curl -s http://127.0.0.1:3000/<route>` against a server running in the background, with the
  expected JSON shown in the prompt.

## Existing project (feature or bug fix)
Order:
1. Plan-mode exploration (via Step 1's description box): how to build/run/test it, the main files,
   and the risky areas. Milestone 1 (Build) then writes those findings into PLAN.md and the "Project
   commands" of AGENTS.md ("using what you found while exploring"), without re-reading everything.
2. Get it building/running in the sandbox (install missing deps with apt/pip/npm). Don't change
   features yet.
3. For a bug: reproduce it as a small, repeatable check (a failing test, or a command with a small
   input that triggers it) and save that command in PLAN.md. Then fix it in a separate milestone and
   re-run *the same* check to prove the fix. If reproducing needs a slow real-world run (a huge
   input), do that once, then turn what you learn into a small offline test (e.g. a fixture with a
   bad entry).
4. For a feature: add it in small slices, keeping existing behaviour working (run the existing tests
   every milestone).

Checks: the project's own build/test commands, plus the specific reproduction command.

Notes:
- Old AI-generated code often lacks tests and has hard-coded paths. Add a small smoke test early so
  later changes can be checked.
- If the folder has its own `CLAUDE.md`/`AGENTS.md` with conventions, the agent follows it; mention it
  in the prompts if it matters.

## Example prompts

### Good (game, milestone 2)
```text
Milestone 2: Snake game logic with tests

Goal: a pure game-state module for Snake, fully covered by tests. No pygame in this file.

Context: The pygame window from milestone 1 is in snake/main.py. Create snake/logic.py and tests/test_logic.py.

Do:
1. In snake/logic.py, add a GameState dataclass: grid size 20x20, snake as a list of (x, y) cells (head first),
   direction ("up"/"down"/"left"/"right"), food (x, y), score int, alive bool, and an optional random seed.
2. Add functions: new_game(seed=None), change_direction(state, d) (ignore 180° reversals), step(state)
   (move; eating food grows the snake, +1 score and places new food on a free cell; hitting a wall or itself sets alive=False).
3. Write unittest tests in tests/test_logic.py for: moving, growing after food, wall death, self collision, reversal ignored.

Constraints: standard library only; keep functions pure (return new state or mutate only `state`).

Done when:
- `.venv/bin/python -m unittest discover -s tests -v` passes all tests.

Finish: tick milestone 2 in PLAN.md, then reply with a 2–4 line summary and the test result line.
```

### Too vague (avoid)
```text
Make the snake game work with good graphics and high scores and a menu.
```
That is four milestones in one, with no files named and no way to check, so the local model will run
out of context or stop half done.
