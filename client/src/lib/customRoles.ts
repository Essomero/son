/**
 * Custom personas: roles you create from a markdown file of instructions,
 * stored in the browser (localStorage, like settings). They look like
 * built-in roles everywhere (cards, sessions, resume) but carry their
 * content — the file name is a pseudo-filename (`custom-<slug>.md`) used
 * for session naming and resume lookup; the content rides along in the
 * /start request as instruction_content.
 */

import type { Role } from "./types";

const CUSTOM_KEY = "son.customRoles";

/** Mini mirror of scripts/gen_roles.py: a leading YAML block yields
 *  name/description; everything after it is the body. */
export function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  const meta: Record<string, string> = {};
  const lines = text.split("\n");
  let end = -1;
  if (text.startsWith("---")) {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const idx = line.indexOf(":");
        if (idx >= 0) {
          meta[line.slice(0, idx).trim()] = line
            .slice(idx + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
        }
      }
    }
  }
  const body = end > 0 ? lines.slice(end + 1).join("\n").trimStart() : text;
  return { name: meta["name"] ?? "", description: meta["description"] ?? "", body };
}

export function loadCustomRoles(): Role[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const roles = JSON.parse(raw) as Role[];
    return roles.filter((r) => typeof r?.file === "string" && typeof r?.content === "string");
  } catch {
    return [];
  }
}

export function saveCustomRoles(roles: Role[]): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(roles));
  } catch {
    /* storage full/blocked — persona simply won't persist */
  }
}

/** "Study Guide" → "custom-study-guide.md"; dedupes against taken files. */
export function personaFile(name: string, existing: string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "persona";
  let file = `custom-${slug}.md`;
  const taken = new Set(existing);
  for (let i = 2; taken.has(file); i++) file = `custom-${slug}-${i}.md`;
  return file;
}
