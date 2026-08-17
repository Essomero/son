#!/usr/bin/env python3
"""Generate client/roles.json from instruction files.

Each instruction file may start with YAML frontmatter:

    ---
    name: Study Buddy
    description: Quizzes you on any topic.
    ---

A file without frontmatter gets a default name (filename stem) and no
description. Run after adding a new role:  uv run scripts/gen_roles.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSTRUCTIONS_DIR = ROOT / "instructions"
OUT = ROOT / "client" / "roles.json"


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Return (frontmatter dict, body text) for a YAML-frontmatter block."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, text
    meta = {}
    for line in lines[1:end]:
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip().strip('"').strip("'")
    return meta, "\n".join(lines[end + 1 :]).lstrip()


def main() -> int:
    roles = []
    for path in sorted(INSTRUCTIONS_DIR.glob("*.md")):
        meta, _ = parse_frontmatter(path.read_text())
        roles.append(
            {
                "file": path.name,
                "name": meta.get("name", path.stem),
                "description": meta.get("description", ""),
            }
        )
    if not roles:
        print("No instruction files found", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(roles, indent=2) + "\n")
    print(f"Wrote {len(roles)} role(s) to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
