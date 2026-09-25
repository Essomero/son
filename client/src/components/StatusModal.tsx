/**
 * The status panel: which server the client is talking to, what it answers, and
 * what it can do right now — the same view of it the CLI's `son status` gives
 * you, built only from routes that cost nothing to ask (`/models` is already
 * fetched for the pickers; `/warming` reads an in-memory dict).
 *
 * It lives behind the rail's own button rather than in ⚙, so it is a click away
 * from every page — including Read and Speak, which render no header.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import type { Models } from "../lib/types";
import { BOT_BASE, WARMING_URL } from "../lib/son";

/** ok — answering; warn — answering but degraded, or expected but silent;
 *  off — deliberately not running. */
type RowState = "ok" | "warn" | "off";

function Row({ state, name, note }: { state: RowState; name: string; note: string }) {
  return (
    <div className="status-row">
      <span className={`status-dot ${state}`} aria-hidden />
      <span className="status-name">{name}</span>
      <span className="status-note">{note}</span>
    </div>
  );
}

export function StatusModal({
  models,
  modelsLive,
  modelsLoading,
  cleanup,
  sessionCount,
  onReloadModels,
  onClose,
}: {
  models: Models;
  modelsLive: boolean;
  modelsLoading: boolean;
  /** The server's cleanup stage is on (from the same /models call). */
  cleanup: boolean;
  sessionCount: number;
  onReloadModels: () => void;
  onClose: () => void;
}) {
  const [warming, setWarming] = useState<Record<string, string> | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      const res = await fetch(WARMING_URL, { signal: AbortSignal.timeout(6000) });
      const data = (await res.json()) as { warming?: Record<string, string> };
      setWarming(data.warming ?? {});
    } catch {
      setWarming(null); // unreachable is already said by the server row
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const busy = checking || modelsLoading;
  const roster = `llm ${models.llm?.length ?? 0} · stt ${models.stt?.length ?? 0} · tts ${models.tts?.length ?? 0}`;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Server status">
        <div className="modal-head">
          <h2 className="modal-title">Server status</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              onReloadModels();
              void check();
            }}
            disabled={busy}
            title="Check again"
            aria-label="Check again"
          >
            <RefreshCw size={15} className={busy ? "spin" : ""} />
          </button>
        </div>
        <p className="modal-sub">What the client is talking to, and what it answers.</p>

        <Row
          state={modelsLive ? "ok" : "warn"}
          name={BOT_BASE}
          note={modelsLive ? "answering — the live model roster is in use" : "no live roster — the built-in fallback list is in use"}
        />
        <Row
          state={!modelsLive ? "warn" : cleanup ? "ok" : "off"}
          name="transcript cleanup"
          note={
            !modelsLive
              ? "unknown until the roster loads"
              : cleanup
                ? "on — tidies dictation and STT finals"
                : "off — set STT_CLEANUP_MODEL"
          }
        />
        <Row
          state={modelsLive ? "ok" : "warn"}
          name="model rosters"
          note={`${roster} · ${sessionCount} conversation${sessionCount === 1 ? "" : "s"}`}
        />
        {warming
          ? Object.entries(warming).map(([name, state]) => (
              <Row key={name} state={state === "ready" ? "ok" : "warn"} name={name} note={state} />
            ))
          : (
            <Row state="warn" name="local models" note="no answer from /warming" />
          )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
