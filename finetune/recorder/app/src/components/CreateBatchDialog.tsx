import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BatchMeta } from "../lib/api";

/** New-batch form: name, kind (normal/quiet/other), description, max take
 *  length, and the prompt source — clone the reading list or paste your own
 *  script (blank lines separate paragraphs; each paragraph becomes a prompt). */

interface CreateBatchDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (b: BatchMeta) => void;
}

const KINDS: { id: string; label: string; blurb: string }[] = [
  { id: "normal", label: "normal", blurb: "same voice, same room — the baseline" },
  { id: "quiet", label: "quiet", blurb: "lower volume, closer mic — soft speech" },
  { id: "other", label: "other", blurb: "anything else — far mic, phone, accents" },
];

export function CreateBatchDialog({ open, onClose, onCreated }: CreateBatchDialogProps) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("normal");
  const [description, setDescription] = useState("");
  const [maxDuration, setMaxDuration] = useState(30);
  const [source, setSource] = useState<"reading_list" | "custom">("reading_list");
  const [customText, setCustomText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const reset = () => {
    setName("");
    setKind("normal");
    setDescription("");
    setMaxDuration(30);
    setSource("reading_list");
    setCustomText("");
    setErr(null);
    setBusy(false);
  };

  // Live prompt count: paragraphs are blank-line-separated, whitespace-joined.
  const promptCount = useMemo(() => {
    if (source !== "custom") return null;
    return customText
      .split(/\n\s*\n/)
      .map((p) => p.split(/\s+/).filter(Boolean).join(" "))
      .filter(Boolean).length;
  }, [source, customText]);

  const submit = async () => {
    if (!name.trim()) {
      setErr("Give the batch a name.");
      return;
    }
    if (source === "custom" && !customText.trim()) {
      setErr("Paste the script — blank lines separate prompts.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createBatch({
        name: name.trim(),
        kind,
        description: description.trim(),
        max_duration: maxDuration,
        prompt_source: source,
        custom_text: source === "custom" ? customText : undefined,
      });
      reset();
      onCreated(res.batch);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dlg}
      className="dlg wide"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="dlghead">
        <span className="cat">new batch</span>
        <button className="btn x" onClick={onClose} aria-label="close">
          ✕
        </button>
      </div>

      <label className="field">
        <span>name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. quiet"
          autoFocus
        />
      </label>

      <div className="field">
        <span>kind</span>
        <div className="pills">
          {KINDS.map((k) => (
            <button
              key={k.id}
              className={`pill${kind === k.id ? " on" : ""}${k.id === "quiet" ? " quiet" : ""}`}
              onClick={() => setKind(k.id)}
            >
              {k.label}
              <small>{k.blurb}</small>
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span>description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="what makes this pass different"
        />
      </label>

      <div className="field">
        <span>max take length</span>
        <div className="pills slim">
          {[30, 60, 90].map((s) => (
            <button
              key={s}
              className={`pill${maxDuration === s ? " on" : ""}`}
              onClick={() => setMaxDuration(s)}
            >
              {s}s
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>script</span>
        <div className="pills slim">
          <button
            className={`pill${source === "reading_list" ? " on" : ""}`}
            onClick={() => setSource("reading_list")}
          >
            clone reading list
          </button>
          <button
            className={`pill${source === "custom" ? " on" : ""}`}
            onClick={() => setSource("custom")}
          >
            paste my own
          </button>
        </div>
        {source === "reading_list" && (
          <small className="hint">
            Same script as batch-1 — the reading_list.jsonl template. Best for
            comparing conditions across passes.
          </small>
        )}
        {source === "custom" && (
          <>
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={7}
              placeholder={"Paragraph 1 — read as one prompt.\n\nParagraph 2 — still\na single prompt, lines joined."}
            />
            <small className="hint">
              {promptCount === 0
                ? "Blank lines separate paragraphs — each becomes one prompt."
                : `${promptCount} prompt${promptCount === 1 ? "" : "s"} — each gets its own take cell.`}
            </small>
          </>
        )}
      </div>

      {err && <div className="note err">{err}</div>}

      <div className="controls">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          cancel
        </button>
        <button className="btn keep" onClick={() => void submit()} disabled={busy}>
          {busy ? "creating…" : "create batch"}
        </button>
      </div>
    </dialog>
  );
}
