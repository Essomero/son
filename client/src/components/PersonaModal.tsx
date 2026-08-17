/**
 * The "Add persona" modal: create a role from a markdown file of instructions
 * — load a .md from disk, or paste one in. name/description auto-fill from
 * the file's YAML frontmatter (the same fields gen_roles.py reads); the rest
 * of the content rides /start as instruction_content, so nothing is written
 * to the repo — the persona lives in this browser only.
 */

import { useRef, useState } from "react";
import { Upload } from "lucide-react";

import type { Role } from "../lib/types";
import { parseFrontmatter, personaFile } from "../lib/customRoles";
import { Markdown } from "./Markdown";

export function PersonaModal({
  existingFiles,
  onSave,
  onClose,
}: {
  /** File names already taken (built-in roles + other personas) — the new
   *  persona's pseudo-filename must not collide with them. */
  existingFiles: string[];
  onSave: (r: Role) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // A persona with no instructions degrades silently to the default role
  // (the server treats empty content as absent), so both fields are needed.
  const canSave = name.trim().length > 0 && content.trim().length > 0;

  /** Content always; name/description only while still empty, so anything
   *  the user typed wins over the file's frontmatter. */
  const applyText = (text: string) => {
    setContent(text);
    const fm = parseFrontmatter(text);
    setName((prev) => prev.trim() || fm.name);
    setDescription((prev) => prev.trim() || fm.description);
    setMode("write");
  };

  const applyFile = (file: File) => {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) return;
    const reader = new FileReader();
    reader.onload = () => applyText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const save = () => {
    onSave({
      file: personaFile(name.trim(), existingFiles),
      name: name.trim(),
      description: description.trim(),
      content: content.trim(),
    });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Add persona">
        <div className="modal-head">
          <h2 className="modal-title">Add a persona</h2>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) applyFile(f);
              e.target.value = ""; // allow re-picking the same file
            }}
          />
          <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={14} aria-hidden />
            Load .md file
          </button>
        </div>
        <p className="modal-sub">
          A persona is just instructions — bring a markdown file or paste one in. It lives in this
          browser and works like any built-in role.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="persona-name">
            Name
          </label>
          <input
            id="persona-name"
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Study buddy"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="persona-desc">
            Description
          </label>
          <input
            id="persona-desc"
            className="text-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Shown on the role card"
          />
        </div>

        <div className="field">
          <label className="field-label" id="persona-content-label">
            Instructions
          </label>
          <div className="reader-tabs" role="tablist" aria-labelledby="persona-content-label" data-active={mode}>
            <div className="reader-tabs-thumb" aria-hidden />
            <button
              type="button"
              role="tab"
              aria-selected={mode === "write"}
              className={`tab-btn${mode === "write" ? " active" : ""}`}
              onClick={() => setMode("write")}
            >
              Write
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "preview"}
              className={`tab-btn${mode === "preview" ? " active" : ""}`}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
          </div>

          {mode === "write" ? (
            <textarea
              className={`persona-content${dragging ? " dragging" : ""}`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onPaste={(e) => {
                // Intercept so pasted frontmatter can prefill name/description
                // (state won't be current inside the textarea's own handler).
                const pasted = e.clipboardData.getData("text");
                if (!pasted) return;
                e.preventDefault();
                const ta = e.currentTarget;
                applyText(content.slice(0, ta.selectionStart) + pasted + content.slice(ta.selectionEnd));
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) applyFile(f);
              }}
              placeholder={
                "Paste a markdown instruction file, or drop one here…\n\n---\nname: Study buddy\ndescription: Quizzes you on your notes.\n---\n\nYou are Son in the role of a study buddy…"
              }
              aria-label="Persona instructions"
            />
          ) : (
            <div className="reader-preview persona-preview">
              {content.trim() ? (
                <Markdown>{content}</Markdown>
              ) : (
                <p className="empty">Nothing to preview yet — paste or load a file.</p>
              )}
            </div>
          )}
          <p className="field-hint">
            A leading <code>---</code> block with <code>name:</code> and <code>description:</code>{" "}
            fills the fields above; the rest of the file becomes the instructions.
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={!canSave}>
            Save persona
          </button>
        </div>
      </div>
    </div>
  );
}
