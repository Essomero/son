/**
 * The conversation: transcript bubbles + the composer row.
 *
 * - bot rows: voice avatar (with a live ring on the currently-speaking
 *   message) + role name + markdown bubble
 * - user rows: right-aligned amber-tinted bubble, "You"
 * - auto-scrolls while you're near the bottom; stops if you scroll up
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";

import type { Choice, Msg, Phase, Role } from "../lib/types";
import type { LevelSubscriber } from "../hooks/useAudioAnalyzer";
import { drawRing } from "../lib/ring";
import { Markdown } from "./Markdown";
import { MicButton } from "./MicButton";
import { VoiceAvatar } from "./Avatar";

const BOT_RING = { size: 64, radius: 27, thickness: 1.8, minBar: 1.5, maxBar: 11, color: "#ef9f43", alpha: 0.9 };

export function Transcript({
  messages,
  role,
  voiceChoice,
  activeBotId,
  subscribe,
  phase,
  status,
}: {
  messages: Msg[];
  role: Role | null;
  voiceChoice: Choice;
  activeBotId: string | null;
  subscribe: (kind: "bot", cb: LevelSubscriber) => () => void;
  phase: Phase;
  status: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // The web-speech cleanup hides the raw final behind a loading bubble; size
  // that bubble to this session's average user utterance (~7.5px per char at
  // 14.5px type) so the cleaned text lands without a layout jump. Fresh
  // sessions fall back to a typical utterance length.
  const avgUtterance = useMemo(() => {
    const lens = messages
      .filter((m) => m.role === "user" && m.final && m.base)
      .map((m) => m.base.length);
    if (!lens.length) return 64;
    return lens.reduce((a, b) => a + b, 0) / lens.length;
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll} aria-live="polite">
      {messages.length === 0 ? (
        <div className="transcript-empty">
          {phase === "connected" ? "Say hello — or type a message below." : status}
        </div>
      ) : (
        messages.map((m) =>
          m.role === "user" ? (
            <div className="row user" key={m.id}>
              <div className="row-body">
                <span className="row-name">You</span>
                <div className="bubble">
                  {m.pending && !m.final ? (
                    <span
                      className="bubble-loading"
                      aria-label="Normalizing your speech…"
                      style={{ minWidth: `${Math.min(Math.max(avgUtterance * 7.5, 90), 300)}px` }}
                    >
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                  ) : (
                    <Markdown>{m.text}</Markdown>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="row bot" key={m.id}>
              <div className="row-avatar">
                <VoiceAvatar choice={voiceChoice} size={40} />
                {m.id === activeBotId && (
                  <BotRingCanvas subscribe={subscribe} />
                )}
              </div>
              <div className="row-body">
                <span className="row-name">{role?.name ?? "Son"}</span>
                <div className="bubble">
                  <Markdown>{m.text}</Markdown>
                </div>
              </div>
            </div>
          ),
        )
      )}
    </div>
  );
}

/** The speaking ring behind the active bot message's avatar, fed by the bot
 *  audio analyser. Mounted only while the message is the active one. */
function BotRingCanvas({ subscribe }: { subscribe: (kind: "bot", cb: LevelSubscriber) => () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    return subscribe("bot", ({ bars }) => {
      if (ref.current) drawRing(ref.current, BOT_RING, bars);
    });
  }, [subscribe]);
  return <canvas ref={ref} className="bot-ring" aria-hidden />;
}

export function ComposerBar({
  phase,
  muted,
  micDisabled,
  onToggleMute,
  subscribe,
  onSend,
}: {
  phase: Phase;
  muted: boolean;
  micDisabled: boolean;
  onToggleMute: () => void;
  subscribe: (kind: "mic", cb: LevelSubscriber) => () => void;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the input as soon as a session connects.
  useEffect(() => {
    if (phase === "connected") areaRef.current?.focus();
  }, [phase]);

  // Grow the input with its content, up to the CSS cap (170px) — beyond
  // that it scrolls in place instead of hiding everything behind one line.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 170)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
    setMode("write");
    areaRef.current?.focus();
  };

  const previewing = mode === "preview";

  return (
    <div className="composer-bar">
      <div className={`composer${previewing ? " previewing" : ""}`}>
        <div className="composer-modes" role="tablist" aria-label="Input mode">
          <button
            type="button"
            role="tab"
            aria-selected={!previewing}
            className={`composer-mode${!previewing ? " active" : ""}`}
            onClick={() => setMode("write")}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={previewing}
            className={`composer-mode${previewing ? " active" : ""}`}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
        </div>
        {previewing ? (
          <div className="composer-preview">
            {draft.trim() ? (
              <Markdown>{draft}</Markdown>
            ) : (
              <span className="composer-preview-empty">Nothing to preview yet.</span>
            )}
          </div>
        ) : (
          <textarea
            ref={areaRef}
            className="composer-input"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline (for pasted
              // markdown you want to review before sending).
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type or paste a message… (Markdown supported)"
            aria-label="Message"
          />
        )}
        <button
          type="button"
          className="send-btn"
          onClick={send}
          disabled={!draft.trim()}
          title="Send (Enter)"
          aria-label="Send message"
        >
          <Send size={17} />
        </button>
      </div>
      <MicButton subscribe={subscribe} muted={muted} disabled={micDisabled} onToggle={onToggleMute} />
    </div>
  );
}
