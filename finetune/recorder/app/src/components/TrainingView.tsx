import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Batch } from "../lib/api";
import { fmtTape } from "../lib/format";
import { useFlash } from "../hooks/useFlash";

/** Training launcher: per-batch include toggles, then the exact GCP command
 *  to run — copied, never executed from the app. */

export function TrainingView() {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [outName, setOutName] = useState("whisper-small-son-soft");
  const [hasNoise, setHasNoise] = useState(false);
  const { flash, flashEl } = useFlash();

  const load = useCallback(async () => {
    try {
      setBatches(await api.batches());
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .noise()
      .then((t) => setHasNoise(t.length > 0))
      .catch(() => setHasNoise(false));
  }, [load]);

  const toggleInclude = async (b: Batch, v: boolean) => {
    try {
      await api.patchBatch(b.id, { include_in_training: v });
      void load();
    } catch (e) {
      flash(String(e), true);
    }
  };

  const included = useMemo(
    () => (batches ?? []).filter((b) => !b.archived && b.include_in_training),
    [batches],
  );
  const active = useMemo(
    () => (batches ?? []).filter((b) => !b.archived),
    [batches],
  );
  const allIncluded =
    active.length > 0 && included.length === active.length;

  const totalClips = included.reduce((s, b) => s + b.stats.done, 0);
  const totalTape = included.reduce((s, b) => s + b.stats.tape_s, 0);

  const command = useMemo(() => {
    const parts: string[] = [];
    parts.push(`SON_OUT_NAME="${outName.trim() || "whisper-small-son-soft"}"`);
    if (!allIncluded)
      parts.push(`SON_BATCHES="${included.map((b) => b.id).join(",")}"`);
    parts.push("bash finetune/gcp/train_on_gcp.sh");
    return parts.join(" ");
  }, [outName, included, allIncluded]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      flash("Copied — run it from the repo root.");
    } catch {
      flash("Copy failed — select the command and copy manually.", true);
    }
  };

  return (
    <main className="wrap">
      <header className="pagehead">
        <div>
          <h1>Training</h1>
          <p className="sub">
            Pick the batches to fine-tune on, then kick off the GCP run — the
            command is yours to run, the app never shells out.
          </p>
        </div>
      </header>

      {err && <div className="note err">{err} — is the server running?</div>}

      <section className="grid">
        {active.map((b) => (
          <article className={`card batch${b.include_in_training ? "" : " off"}`} key={b.id}>
            <div className="catline">
              <span className={`cat${b.kind === "quiet" ? " quiet" : ""}`}>{b.kind}</span>
              <span className="tag">
                {b.stats.done} clips · {fmtTape(b.stats.tape_s)}
              </span>
            </div>
            <h2>{b.name}</h2>
            <label className="toggle big">
              <input
                type="checkbox"
                checked={b.include_in_training}
                onChange={(e) => void toggleInclude(b, e.target.checked)}
              />
              <span>include in training</span>
            </label>
          </article>
        ))}
      </section>

      <section className="launcher">
        <div className="strip">
          <div className="title">
            Run the fine-tune
            <span className="legend">
              {included.length === 0
                ? "no batches included yet"
                : `${included.length} batch${included.length === 1 ? "" : "es"} · ` +
                  `${totalClips} clips · ${fmtTape(totalTape)} of audio`}
            </span>
          </div>
        </div>
        {!hasNoise && (
          <div className="note warn">
            No room tone recorded — training augments with silence anyway, but
            a real recording of your room produces a tighter noise floor.
            Record one from any booth (Record silence).
          </div>
        )}
        <label className="field">
          <span>model name</span>
          <input
            value={outName}
            onChange={(e) => setOutName(e.target.value)}
            placeholder="whisper-small-son-soft"
          />
        </label>
        <pre className="cmd">{command}</pre>
        <div className="controls">
          <button className="btn keep" onClick={() => void copy()} disabled={included.length === 0}>
            copy command
          </button>
          <span className="hint">
            Runs whisper-small.en fine-tune on a preemptible T4 (~2–3 h) and
            pulls the model back — watch progress in your terminal.
          </span>
        </div>
      </section>
      {flashEl}
    </main>
  );
}
