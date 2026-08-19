/**
 * Tiny themed dropdown for small fixed option lists (the Export panel's
 * format/bitrate). Native <select>s don't match the theme, and the model
 * Picker (Picker.tsx) is built for rosters with search + grouping — this is
 * just the same chrome for a plain option list. Reuses the picker CSS
 * classes; keyboard: arrows move, Enter picks, Esc closes, click outside
 * closes.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface Option {
  value: string;
  label: string;
}

export function OptionPicker({
  options,
  value,
  onChange,
  label,
}: {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  /** Visible + aria label for the trigger. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  // The cursor is a keyboard-navigation marker — keep it invisible until the
  // user actually navigates with arrows (same trick as the model Picker).
  const [keyboardNav, setKeyboardNav] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Land the cursor on the current selection when the list opens.
  useEffect(() => {
    if (open) setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setKeyboardNav(true);
      setCursor((c) => Math.min(c + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setKeyboardNav(true);
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && open && options[cursor]) {
      e.preventDefault();
      setKeyboardNav(true);
      pick(options[cursor].value);
    }
  };

  return (
    <div className="picker opt-picker" ref={rootRef}>
      <button
        type="button"
        className="picker-trigger opt-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        <span className="picker-trigger-label">{selected?.label ?? label}</span>
        <ChevronDown size={14} className="picker-chevron" aria-hidden />
      </button>
      {open && (
        <div
          className={`picker-pop opt-picker-pop${keyboardNav ? " keyboard-nav" : ""}`}
          role="listbox"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {options.map((o, i) => {
            const rowSelected = o.value === value;
            return (
              <button
                type="button"
                key={o.value}
                className={`picker-option${rowSelected ? " selected" : ""}`}
                data-cursor={i === cursor}
                onClick={() => pick(o.value)}
                role="option"
                aria-selected={rowSelected}
              >
                <span className="picker-option-label">{o.label}</span>
                {rowSelected && <Check size={14} aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
