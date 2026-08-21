import { useEffect, useRef, useState, type ReactNode } from "react";

/** One-shot toast with auto-hide; renders wherever the caller puts it. */

export interface FlashMsg {
  text: string;
  err?: boolean;
}

export function useFlash() {
  const [msg, setMsg] = useState<FlashMsg | null>(null);
  const t = useRef<number | null>(null);

  const flash = (text: string, err = false) => {
    setMsg({ text, err });
    if (t.current !== null) clearTimeout(t.current);
    t.current = window.setTimeout(() => setMsg(null), 2400);
  };

  useEffect(() => () => {
    if (t.current !== null) clearTimeout(t.current);
  }, []);

  const el: ReactNode = msg ? (
    <div className={`flash show${msg.err ? " err" : ""}`} role="status">
      {msg.text}
    </div>
  ) : null;
  return { flash, flashEl: el };
}
