import type { Choice, ContextSource, Models, Role } from "./types";

/**
 * Thin REST client for the Son server, used by the side panel (never by a
 * content script).
 *
 * Page reads need the manifest's host entries (scripting fires on tab events
 * with no user gesture, which activeTab can't cover). Server fetches from an
 * extension page skip CORS for hosts the manifest allows, so the server needs
 * no CORS middleware and no chrome-extension:// allowlist — but POSTs still
 * carry an Origin, so the server's origin guard applies. When SON_TOKEN is set
 * server-side, pass it as Settings.serverToken (entered once in the panel's
 * settings); it travels as `Authorization: Bearer`.
 */
export class SonApi {
  constructor(
    readonly base: string,
    readonly token: string = "",
  ) {}

  private headers(extra?: HeadersInit): HeadersInit | undefined {
    if (!this.token) return extra;
    const merged = new Headers(extra);
    merged.set("Authorization", `Bearer ${this.token}`);
    return merged;
  }

  private get root(): string {
    return this.base.replace(/\/+$/, "");
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.root + path, {
      ...init,
      headers: this.headers(init?.headers),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return (await res.json()) as T;
  }

  /** Live model roster, key-gated server-side. null = server unreachable.
   *  Slow on a cold cache (every provider is probed), so it is never the thing
   *  the UI polls. */
  async models(): Promise<Models | null> {
    try {
      return await this.json<Models>("/models", { signal: AbortSignal.timeout(15000) });
    } catch {
      return null;
    }
  }

  /** Punctuation/formatting pass for transcripts this browser produced (browser
   *  Web Speech). Server-side STT is cleaned inside the pipeline; text that
   *  arrives via send-text never enters it. Returns "" when cleanup is disabled
   *  (the server 503s without STT_CLEANUP_MODEL) or fails — the caller sends the
   *  raw text rather than stalling a turn. 10 s, not 4: a cold-loaded local
   *  model needs ~9 s on CPU. */
  async cleanup(text: string): Promise<string> {
    try {
      const data = await this.json<{ text?: unknown }>("/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10000),
      });
      return typeof data.text === "string" ? data.text.trim() : "";
    } catch (err) {
      console.warn("[son] transcript cleanup failed:", err);
      return "";
    }
  }

  /** Local-model warmup state: label → "downloading" | "ready" | "failed: …".
   *  Doubles as the panel's reachability probe — it is the cheapest route on the
   *  server, so "is the bot there" and "is it fetching anything" cost one call.
   *  `ok: false` means the request itself failed, which is the only honest
   *  "offline" the panel can report. */
  async warming(): Promise<{ ok: boolean; warming: Record<string, string> }> {
    try {
      const data = await this.json<{ warming?: Record<string, string> }>("/warming", {
        signal: AbortSignal.timeout(4000),
      });
      return { ok: true, warming: data.warming ?? {} };
    } catch {
      return { ok: false, warming: {} };
    }
  }

  /** Roles = the server's instructions/*.md roster, served from source so a
   *  client that never loads the web bundle still gets the list. */
  async roles(): Promise<Role[]> {
    try {
      return await this.json<Role[]>("/roles", { cache: "no-store" });
    } catch {
      return [];
    }
  }

  /** Stored transcript for a session id — what a reopened panel replays so the
   *  conversation doesn't look restarted while the brain still remembers it. */
  async session(id: string): Promise<{ messages: { role: string; text: string }[] }> {
    return await this.json<{ messages: { role: string; text: string }[] }>(
      `/sessions/${encodeURIComponent(id)}`,
    );
  }

  /** Attach page state to a live session — the panel's deltas.
   *
   *  Only changed parts are sent (an omitted part means "unchanged", which is
   *  what keeps an unchanged page from being re-sent at all), and `detach`
   *  carries the explicit removals: the chip's × on a source. The server attaches
   *  each block to the conversation once and replaces it only when it changes. */
  async pushPageContext(
    sessionId: string,
    payload: {
      url: string;
      title: string;
      selection?: string;
      page?: string;
      detach?: ContextSource[];
    },
  ): Promise<{ page: number; selection: number }> {
    return await this.json<{ page: number; selection: number }>("/page-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        url: payload.url,
        title: payload.title,
        selection: payload.selection ?? "",
        page: payload.page ?? "",
        detach: payload.detach ?? [],
      }),
    });
  }

  /** One-shot TTS (the server's /speak): WAV bytes for the panel to play.
   *  Used by "Read aloud", which never touches the LLM. */
  async speak(text: string, voice?: Choice): Promise<Blob> {
    const res = await fetch(this.root + "/speak", {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text, voice: voice ? { provider: voice.provider, id: voice.id, voice: voice.voice } : undefined }),
    });
    if (!res.ok) {
      throw new Error(`/speak failed: HTTP ${res.status}${res.status === 503 ? " (voice provider unavailable)" : ""}`);
    }
    return await res.blob();
  }
}
