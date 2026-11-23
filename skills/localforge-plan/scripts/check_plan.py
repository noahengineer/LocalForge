#!/usr/bin/env python3
"""Check a LocalForge plan (markdown) against the milestone budget.

Usage: python3 check_plan.py plan.md [--json]

For every "### Milestone ..." section it takes the first fenced code block (the prompt) and reports:
words (limit 250), "Done when" checks (limit 2, 3 tolerated), placeholders the user would have to
edit, checks phrased as optional/skippable, and whether the prompt ticks PLAN.md.
Exit code 1 if any milestone breaks a hard rule (words > 250, checks > 3, placeholders, skippable checks).
"""
import json
import re
import sys

PLACEHOLDER = re.compile(r"PASTE_|YOUR_[A-Z_]+_HERE|<your [^>]+>|TODO: fill", re.I)
SKIPPY = re.compile(r"\b(skip (this|it|the) check|if it fails,? skip|optional check|if (playwright|it) reports)\b", re.I)


def milestones(text: str):
    # Split on milestone headings; keep the heading text.
    parts = re.split(r"^#{2,4}\s+(Milestone[^\n]*)$", text, flags=re.M)
    for i in range(1, len(parts), 2):
        heading, body = parts[i].strip(), parts[i + 1]
        m = re.search(r"```[a-zA-Z]*\n(.*?)```", body, flags=re.S)
        yield heading, (m.group(1) if m else "")


def analyse(prompt: str):
    words = len(prompt.split())
    done = re.search(r"Done when:?\s*\n(.*?)(?:\n\s*\n|\nFinish|\Z)", prompt, flags=re.S)
    checks = len(re.findall(r"^\s*[-*]\s+", done.group(1), flags=re.M)) if done else 0
    return {
        "words": words,
        "checks": checks,
        "placeholders": PLACEHOLDER.findall(prompt),
        "skippable": bool(SKIPPY.search(prompt)),
        "ticks_plan": "PLAN.md" in prompt,
        "has_done_when": bool(done),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    text = open(sys.argv[1], encoding="utf-8").read()
    rows = [(h, analyse(p)) for h, p in milestones(text)]
    bad = 0
    if "--json" in sys.argv:
        print(json.dumps([{"milestone": h, **r} for h, r in rows], indent=2))
    else:
        for h, r in rows:
            problems = []
            if r["words"] > 250:
                problems.append(f"{r['words']} words (>250)")
            if not r["has_done_when"]:
                problems.append("no 'Done when'")
            elif r["checks"] > 3:
                problems.append(f"{r['checks']} checks (>3)")
            if r["placeholders"]:
                problems.append(f"placeholders {r['placeholders']}")
            if r["skippable"]:
                problems.append("optional/skippable check")
            if not r["ticks_plan"]:
                problems.append("does not tick PLAN.md")
            bad += bool(problems)
            status = "OK " if not problems else "FIX"
            print(f"{status} {h[:60]:<60} {r['words']:>4}w {r['checks']} checks  {'; '.join(problems)}")
        print(f"\n{len(rows)} milestones, {bad} need fixing")
    hard = any(r["words"] > 250 or r["checks"] > 3 or r["placeholders"] or r["skippable"] or not r["has_done_when"] for _, r in rows)
    return 1 if hard or not rows else 0


if __name__ == "__main__":
    sys.exit(main())
