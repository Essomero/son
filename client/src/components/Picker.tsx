/**
 * Custom picker replacing every native <select>. Two variants:
 *   - "list": grouped-by-provider options with a search box (brains, STT)
 *   - "grid": voice avatar cards (TTS)
 * Keyboard: arrows move, Enter picks, Esc closes. Click outside closes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import type { Choice, ModelOption } from "../lib/types";
import { groupByProvider, optionLabel } from "../lib/settings";
import { VoiceAvatar } from "./Avatar";
import { voiceMeta } from "../lib/voices";

interface PickerProps {
  options: ModelOption[];
  value: Choice | null;
  onChange: (c: Choice) => void;
  variant?: "list" | "grid";
  placeholder?: string;
}

export function Picker({ options, value, onChange, variant = "list", placeholder }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // The cursor is a keyboard-navigation marker — keep it invisible until the
  // user actually navigates with arrows, so opening a picker doesn't look
  // like the first option got selected.
  const [keyboardNav, setKeyboardNav] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter(
      (o) =>
        o.id.toLowerCase().includes(q) ||
        o.label?.toLowerCase().includes(q) ||
        o.provider.toLowerCase().includes(q),
    );
  }, [options, query]);

  const groups = useMemo(() => groupByProvider(flat), [flat]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setCursor(0);
      setQuery("");
      setKeyboardNav(false);
      // Focus the search; if the panel opened below the modal's fold (e.g.
      // the last field on a short screen) scroll it into view.
      window.setTimeout(() => {
        searchRef.current?.focus();
        popRef.current?.scrollIntoView({ block: "nearest" });
      }, 0);
    }
  }, [open]);

  // Keep the cursor row visible in the popover list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-cursor='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const pick = useCallback(
    (o: ModelOption) => {
      onChange({ provider: o.provider, id: o.id, ...(o.voice ? { voice: o.voice } : {}) });
      setOpen(false);
    },
    [onChange],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setKeyboardNav(true);
      setCursor((c) => Math.min(c + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setKeyboardNav(true);
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && open && flat[cursor]) {
      e.preventDefault();
      setKeyboardNav(true);
      pick(flat[cursor]);
    }
  };

  const selected = value ? options.find((o) => o.provider === value.provider && o.id === value.id) : null;
  const isGrid = variant === "grid";

  return (
    <div className={`picker${isGrid ? " picker-grid" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        onKeyDown={onKeyDown}
      >
        {isGrid && selected ? (
          <span className="picker-trigger-voice">
            <VoiceAvatar choice={{ provider: selected.provider, id: selected.id }} size={26} />
            <span className="picker-trigger-voice-name">{voiceMeta(selected.id).name}</span>
          </span>
        ) : (
          <span className="picker-trigger-label">
            {selected ? optionLabel(selected) : (placeholder ?? "Choose…")}
            {selected && <span className="picker-provider">{selected.provider}</span>}
          </span>
        )}
        <ChevronDown size={15} className="picker-chevron" aria-hidden />
      </button>

      {open && (
        <div
          className={`picker-pop${keyboardNav ? " keyboard-nav" : ""}`}
          ref={popRef}
          role="listbox"
          onKeyDown={onKeyDown}
        >
          <div className="picker-search">
            <Search size={13} aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
            />
          </div>
          <div className="picker-groups" ref={listRef}>
            {groups.length === 0 && <div className="picker-empty">No models match “{query}”.</div>}
            {groups.map(([provider, list]) => (
              <div className="picker-group" key={provider}>
                <div className="picker-group-label">{provider}</div>
                {isGrid ? (
                  <div className="picker-grid-list">
                    {list.map((o) => (
                      <VoiceOption
                        key={o.id}
                        o={o}
                        selected={value?.id === o.id && value.provider === o.provider}
                        cursor={flat.indexOf(o) === cursor}
                        onPick={() => pick(o)}
                      />
                    ))}
                  </div>
                ) : (
                  list.map((o) => {
                    const rowSelected = value?.id === o.id && value.provider === o.provider;
                    return (
                      <button
                        type="button"
                        key={o.id}
                        className={`picker-option${rowSelected ? " selected" : ""}`}
                        data-cursor={flat.indexOf(o) === cursor}
                        onClick={() => pick(o)}
                        role="option"
                        aria-selected={rowSelected}
                      >
                        <span className="picker-option-label">{optionLabel(o)}</span>
                        {rowSelected && <Check size={14} aria-hidden />}
                      </button>
                    );
                  })
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VoiceOption({
  o,
  selected,
  cursor,
  onPick,
}: {
  o: ModelOption;
  selected: boolean;
  cursor: boolean;
  onPick: () => void;
}) {
  const meta = voiceMeta(o.id);
  const glyph = meta.isKokoro ? meta.flag : "🛰️";
  return (
    <button
      type="button"
      className={`picker-voice${selected ? " selected" : ""}`}
      data-cursor={cursor}
      onClick={onPick}
      role="option"
      aria-selected={selected}
      title={o.id}
    >
      <span className="picker-voice-avatar">
        <VoiceAvatar choice={{ provider: o.provider, id: o.id }} size={40} />
        {selected && <Check size={12} className="picker-voice-check" aria-hidden />}
      </span>
      <span className="picker-voice-name">{meta.name}</span>
      <span className="picker-voice-sub">
        {glyph} {meta.accent ? `${meta.accent} · ${meta.gender}` : o.provider}
      </span>
    </button>
  );
}
