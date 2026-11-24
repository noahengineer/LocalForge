---
name: localforge-plan
description: Turn an app/game/tool idea (or a change to an existing project) into a ready-to-run plan for LocalForge, the user's local AI coding app (a local Qwen 27B model running OpenCode inside a sandbox with its own desktop). Produces the New Project settings, the "What do you want to build?" text, and a sequence of small copy-paste prompts sized for a slow, small-context local model, each with a verification step. Use this whenever the user wants to build, make, code or fix something "in LocalForge", "with my local AI", "for the local agent", asks for prompts or a plan to give their local model/agent, or invokes /localforge-plan, even if they only describe the thing they want to make.
---

# LocalForge plan

LocalForge is the user's desktop app for coding with a **local** model. Each project gets its own
sandbox (an Ubuntu container) where an OpenCode agent runs a ~27B model through llama.cpp. The agent is
capable, but it is slow (about 7 tokens/s, plus thinking time), its context is modest (it compacts
around 49K tokens), and it works best when every request is small, concrete and checkable. A plan that
would be fine for a frontier cloud model ("build the whole app") usually fails here: the agent runs
out of context halfway, the conversation is compacted, and details are lost.

Your job is to turn the user's idea into a plan that plays to the agent's strengths: one small,
self-contained, verifiable milestone at a time.

Before writing the plan, read `references/localforge.md` (what the agent and sandbox can and cannot do,
templates, limits). Then read the section of `references/patterns.md` that matches the kind of project
(web app, CLI/tool, desktop GUI, game, backend/API, existing project).

## Workflow

1. **Understand the idea.** Work out what the user wants to end up with, who uses it, and the platform
   (web page, desktop window, terminal, game). If something that changes the whole approach is truly
   ambiguous (e.g. "an app": web or desktop?), ask at most 2–3 short questions, each with a suggested
   default. Otherwise decide and list your choices under **Assumptions** so the user can correct them.
   A plan with sensible assumptions beats an interrogation.

2. **Existing code?** If the user wants to change something they already have, the plan starts with
   **Open existing folder** instead of a template. If you can read their folder (e.g. in Claude Code,
   or files they uploaded in a chat), skim the README, build files and entry points first so the prompts can name
   real files and functions. Otherwise say plainly that you haven't seen the code, and let the first
   milestone discover it. Never modify their files yourself: the plan is for the local agent.

3. **Pick the stack and template.** Prefer the template that already builds out of the box and the
   simplest well-known libraries: the model knows mature, popular libraries well and struggles with
   brand-new APIs. Respect the sandbox limits in the reference (no GPU/Vulkan, no sound device, no
   Docker, Python 3.14 quirks, dev servers only visible inside the agent's desktop). Explain the
   choice in one line.

4. **Cut the scope to a first version (MVP).** Aim for something that works end to end after a few
   milestones. Put everything else under **Later ideas**.

5. **Split into milestones**, usually 5–10, ordered so each one builds on a working state
   (skeleton → core logic with tests → UI → integration → polish). Split *up front* until every
   milestone fits the budget below. Don't write "if this is too long, split it": that's your job,
   and the user shouldn't have to do it.

6. **Write the prompts** with the rules and skeleton below.

7. **Present the plan** in the output format below. If you can write files and the user would like a
   copy, offer to save it as `~/LocalForge-plans/<project-slug>.md`.

## Milestone budget

At 7 tokens/s every extra file, check and tool call costs minutes and context. Each milestone prompt
should stay within this budget:
- **≤ 250 words**, written in the skeleton below.
- **One kind of work:**
  - *either* a new module/component with its tests,
  - *or* wiring existing pieces together (UI ↔ logic, CLI ↔ core),
  - *or* setup/infrastructure.
  Never "new module + integrate it" in one turn.
- **≤ 4 files** created or changed.
- **≤ 2 checks** in "Done when"; three only if one is trivial (like `--help`).
- **At most one screenshot** (visual milestones only), and **at most one slow real-world run** in the
  whole plan.

If a milestone doesn't fit, split it.

## Prompt rules (why each matters)

The local agent already gets standing rules from the project's AGENTS.md: read before editing, small
changes, build/test after each change, check docs. Don't repeat those. Spend the words on what only you know:

- **Self-contained.** Each prompt must make sense on its own, because after compaction or in a new
  session the agent remembers nothing.
  - Name the files, functions and data formats explicitly.
  - Repeat any setup a check depends on, *every time*. For example: "Start the dev server if it isn't
    running: `npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/dev.log 2>&1 &`, then open
    http://127.0.0.1:5173".
  - Never say "as before" or "like we discussed".
- **Concrete over clever.** Exact file paths, the library to use, data shapes, UI layout, and example
  input → output with real values. A 27B model fills gaps with guesses; leave few gaps.
- **"Done when" is mandatory and deterministic.** Give the exact command and the expected result.
  Every check must be one the agent can always run and pass. If you'd tell the user to skip a check
  when it fails, replace it:
  - a unit test of the handler;
  - a headless render to PNG;
  - a `browser_evaluate` that returns the value to compare.
  No "if Playwright reports a download"-style conditional checks.
- **Cheap checks, small fixtures.** Routine checks use small or offline inputs: sample files in
  `examples/`, a recorded JSON fixture, a mocked network call, a seeded game state, a 5-item playlist
  rather than a 300-item one. Keep the expensive real-world case (a full download, a long build) for
  one dedicated milestone near the end.
- **Long commands block, they don't poll.** The agent's bash tool stops commands after 2 minutes
  unless given a longer `timeout` (milliseconds). For one long command, write "run it with the bash
  tool's timeout set to 900000 ms". Avoid "check the log every 30 s" loops: each poll is a slow thinking
  cycle that eats context. Background (`&`) is only for servers that must keep running.
- **No placeholders inside prompts.** If the plan needs something only the user has (a link, a sample
  file, an API key), ask for it in Step 1's description box, so it lands in PLAN.md during milestone 1.
  If it's still missing, the prompt says "if PLAN.md has no <thing>, stop and ask me for it".
- **Persistent memory.** Milestone 1 creates `PLAN.md` with the milestone checklist and the key facts
  (file names, commands, test inputs). Every later prompt ends with "tick milestone N in PLAN.md", and
  prompts can point at it ("the test playlist link in PLAN.md").
- **Fresh context.** Put a "Start a New session now" note every ~3 milestones. The files, PLAN.md and
  AGENTS.md carry the state over; the prompts after the note must not depend on chat history.
- **Unfamiliar or fast-moving libraries.** Tell the agent to `websearch`/`webfetch` the current docs
  first.
- **Short reply.** End with a request for a 2–4 line summary (what changed + check results).

Prompt skeleton (adapt the wording, keep the parts):

```text
Milestone N: <name>

Goal: <one sentence>

Context: <what exists now; relevant files; where key facts live in PLAN.md>

Do:
1. <concrete step>
2. <concrete step>

Constraints: <libraries, files not to touch, style>

Done when:
- `<command>` succeeds and <expected output/behaviour>
- <second check, if needed>

Finish: tick milestone N in PLAN.md, then reply with a 2–4 line summary and the check results.
```

## Output format

Keep the wrapper around the prompts short and skimmable. The prompts are the product. Put each thing
the user pastes into LocalForge in its own fenced `text` block.

```markdown
# LocalForge plan: <Project name>

**You'll end up with:** <2–3 sentences describing the first version>
**Time:** <N> milestones, roughly <X–Y> minutes each with your local model.

**Assumptions** (change any of these and I'll adjust the plan)
- <decision 1>
- <decision 2>

## Step 1: Create the project
In LocalForge click **New project** (or **Open existing folder** for code you already have).
- **Name:** `<name>`
- **Template:** <template> (<why, one line>)
- **What do you want to build?** Paste this:
  ```text
  <compact spec, 60–150 words: what it is, the core features of this version, key tech choices,
  anything user-specific the plan needs (e.g. "test playlist: <link>"), and "Read the project and
  propose a short plan. Ask me if anything important is unclear. Don't write code yet.">
  ```
This starts the session in **Plan** mode. Answer any question cards. When the agent has replied with its
plan (which may differ a little from this one; the prompts below carry everything needed), press
**Tab** to switch to **Build**.

## Step 2: Milestones (Build mode, one at a time)
Wait for each one to finish (the Stop button disappears) and glance at the check before pasting the next.

### Milestone 1: <name> (~<time>)
```text
<prompt>
```
**Check:** <one line: what to look at>
**If it goes wrong:** <one line, specific to this milestone>
<optional, only when it clearly helps: **Effort:** Low/Medium for a mechanical step (renames, boilerplate,
styling); leave the default for logic, debugging and planning>

… (repeat; insert "> **Start a New session now** (sidebar)." every ~3 milestones)

## Tips for this project
- <3–6 tips specific to this project; for web/server projects always include: "Your own browser
  can't open the sandbox's localhost URLs. Watch the app in the Agent's Desktop panel.">
- General recovery: if a milestone goes badly, **Undo to here** on the last good checkpoint
  (Changes tab) and paste the prompt again, or paste the exact error to the agent. To adjust a
  prompt you just sent, hover over it and use **Edit** (or **Run again**): this rewinds the chat and
  the files to before that message.
- If the plan has the agent explore with subagents (big existing projects), say once: turn on
  **Settings → Model → One conversation at a time** first.

## Later ideas
- <features deliberately left out of the first version>
```

For an existing project:
- Step 1 becomes "Open existing folder", with the checkpoint and graph options explained in
  `references/localforge.md`.
- Milestone 1 builds on what the agent found in Plan mode ("using what you found while exploring")
  instead of re-reading everything.
- For a bug: reproduce it as a small, repeatable command or failing test, fix it in a later milestone,
  and re-run *that same* reproduction to prove the fix.

## Quality bar

Before presenting, reread every prompt as if you were the local agent with no memory of this chat:
- Could you start without asking anything? Are files, commands, URLs and expected values all there,
  including the setup a check needs, such as starting the dev server?
- Does it fit the milestone budget (≤ 250 words, one kind of work, ≤ 4 files, ≤ 2 checks)? If not, split it.
- Is every check deterministic, cheap, and runnable inside the sandbox (no host browser, no GPU, no
  sound)? Is there at most one slow real-world run in the whole plan?
- Are there any placeholders the user must edit inside a milestone prompt? Move them to Step 1.

Count rather than guess. If you can run Python (Claude Code, or code execution on
claude.ai), save your draft to a file and run `python3 <this skill's folder>/scripts/check_plan.py <draft.md>`. It lists each milestone's word count
and number of checks, and flags placeholders, skippable checks and prompts that don't tick PLAN.md.
Fix every `FIX` line before presenting. Without Python, count the words of each prompt yourself.
