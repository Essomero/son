/**
 * The sessions rail: fetch /sessions, keep the active row live (preview and
 * message count patch locally while a conversation runs), and mutate via
 * PATCH/DELETE. A refetch happens whenever `refetchKey` changes — the App
 * passes the connection phase, so a fresh session row appears right after
 * connect and the order refreshes after a disconnect bumps updated_at.
 */

import { useCallback, useEffect, useState } from "react";

import type { SessionMeta } from "../lib/types";
import { SESSIONS_URL } from "../lib/son";

export function useSessions({
  activeId,
  activePreview,
  activeCount,
  refetchKey,
}: {
  activeId: string | null;
  activePreview: string | null;
  activeCount: number;
  refetchKey: string;
}) {
  const [list, setList] = useState<SessionMeta[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(SESSIONS_URL);
      if (res.ok) {
        setList((await res.json()) as SessionMeta[]);
        setLoaded(true);
      }
    } catch (e) {
      console.warn("[Son] /sessions unreachable:", e);
    }
  }, []);

  // Mount + every phase change (connect creates the row, disconnect bumps it).
  useEffect(() => {
    void refresh();
  }, [refresh, refetchKey]);

  // Patch the active row live — preview/count without a mid-conversation
  // refetch. (updated_at stays server-owned; refresh reorders on disconnect.)
  useEffect(() => {
    if (!activeId || activePreview == null) return;
    setList((prev) =>
      prev.map((m) =>
        m.id === activeId ? { ...m, preview: activePreview, message_count: activeCount } : m,
      ),
    );
  }, [activeId, activePreview, activeCount]);

  const rename = useCallback(
    async (id: string, name: string) => {
      try {
        const res = await fetch(`${SESSIONS_URL}/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (res.ok) setList((prev) => prev.map((m) => (m.id === id ? { ...m, name } : m)));
        else void refresh();
      } catch (e) {
        console.warn("[Son] rename failed:", e);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`${SESSIONS_URL}/${id}`, { method: "DELETE" });
        if (res.ok) setList((prev) => prev.filter((m) => m.id !== id));
        else void refresh();
      } catch (e) {
        console.warn("[Son] delete failed:", e);
      }
    },
    [refresh],
  );

  return { list, loaded, refresh, rename, remove };
}
