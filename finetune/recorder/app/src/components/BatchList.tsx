import { useCallback, useEffect, useState } from "react";
import { api, type Batch } from "../lib/api";
import { fmtTape } from "../lib/format";
import { useFlash } from "../hooks/useFlash";
import { CreateBatchDialog } from "./CreateBatchDialog";

/** Studio landing view: the batch registry as cards — create, open, toggle
 *  training inclusion, archive. Archived batches sink below the active list
 *  and can be restored. */

export function BatchList({ onOpen }: { onOpen: (bid: string) => void }) {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
  }, [load]);

  const toggleInclude = async (b: Batch, v: boolean) => {
    try {
      await api.patchBatch(b.id, { include_in_training: v });
      void load();
    } catch (e) {
      flash(String(e), true);
    }
  };

  const archive = async (b: Batch) => {
    if (
      !window.confirm(
        `Archive "${b.name}"? Its recordings stay on disk, but it drops out ` +
          `of training and the active list. You can restore it later.`,
      )
    )
      return;
    try {
      await api.archiveBatch(b.id);
      void load();
    } catch (e) {
      flash(String(e), true);
    }
  };

  const restore = async (b: Batch) => {
    try {
      await api.patchBatch(b.id, { archived: false });
      void load();
    } catch (e) {
      flash(String(e), true);
    }
  };

  const active = (batches ?? []).filter((b) => !b.archived);
  const archived = (batches ?? []).filter((b) => b.archived);

  return (
    <main className="wrap">
      <header className="pagehead">
        <div>
          <h1>Batches</h1>
          <p className="sub">
            Each batch is one pass of recordings — same script, different
            voice conditions (quiet, far, phone…), or a different script
            entirely.
          </p>
        </div>
        <button className="btn keep" onClick={() => setCreating(true)}>
          + new batch
        </button>
      </header>

      {err && (
        <div className="note err">
          {err} — is the server running? <code>python finetune/recorder/server.py</code>
        </div>
      )}

      <section className="grid">
        {active.map((b) => (
          <article className={`card batch${b.include_in_training ? "" : " off"}`} key={b.id}>
            <div className="catline">
              <span className={`cat${b.kind === "quiet" ? " quiet" : ""}`}>{b.kind}</span>
              {b.prompt_source === "reading_list" && <span className="tag">reading list</span>}
              {b.prompt_source === "custom" && <span className="tag">custom script</span>}
              {!b.include_in_training && <span className="tag">excluded</span>}
            </div>
            <h2>{b.name}</h2>
            {b.description && <p className="desc">{b.description}</p>}
            <p className="meta">
              {b.stats.done}/{b.stats.prompts} takes · {fmtTape(b.stats.tape_s)} on
              tape · max {b.max_duration}s
            </p>
            <div className="bar">
              <div
                className="fill"
                style={{
                  width: `${
                    b.stats.prompts ? Math.round((b.stats.done / b.stats.prompts) * 100) : 0
                  }%`,
                }}
              />
            </div>
            <div className="actions">
              <label className="toggle" title="include this batch in the next training run">
                <input
                  type="checkbox"
                  checked={b.include_in_training}
                  onChange={(e) => void toggleInclude(b, e.target.checked)}
                />
                <span>in training</span>
              </label>
              <button className="btn" onClick={() => onOpen(b.id)}>
                open booth
              </button>
              <button className="btn ghost" onClick={() => void archive(b)}>
                archive
              </button>
            </div>
          </article>
        ))}
        {active.length === 0 && !err && (
          <div className="note">
            No batches yet — create one. It clones the reading list, or you
            can paste your own script.
          </div>
        )}
      </section>

      {archived.length > 0 && (
        <section className="archived">
          <h3>Archived</h3>
          {archived.map((b) => (
            <div className="row" key={b.id}>
              <span className={`cat${b.kind === "quiet" ? " quiet" : ""}`}>{b.kind}</span>
              <span className="name">{b.name}</span>
              <span className="meta">
                {b.stats.done}/{b.stats.prompts} takes
              </span>
              <button className="btn ghost" onClick={() => void restore(b)}>
                restore
              </button>
            </div>
          ))}
        </section>
      )}

      <CreateBatchDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(b) => {
          setCreating(false);
          void load();
          onOpen(b.id);
        }}
      />
      {flashEl}
    </main>
  );
}
