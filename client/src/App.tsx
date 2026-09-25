/**
 * Son — a personal real-time voice agent. React client for the Pipecat
 * runner: pick a role, connect over WebRTC, talk or type. Past sessions live
 * in the left rail (collapsible) and resume in place.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useSonSession } from "./hooks/useSonSession";
import { useSessions } from "./hooks/useSessions";
import { useAudioAnalyzer } from "./hooks/useAudioAnalyzer";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { SessionsPanel } from "./components/SessionsPanel";
import { Transcript, ComposerBar } from "./components/Transcript";
import { SettingsModal } from "./components/SettingsModal";
import { PersonaModal } from "./components/PersonaModal";
import { Reader } from "./components/Reader";
import { Dictate } from "./components/Dictate";
import type { Role } from "./lib/types";
import { FALLBACK_MODELS, resolveChoice } from "./lib/settings";
import { sessionIdFromPath } from "./lib/chatRoute";

const PANEL_KEY = "son.panel";

export default function App() {
  const s = useSonSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== "0");
  const [view, setView] = useState<"chat" | "reader">("chat");
  /** Which side of the reader page: text → speech, or speech → text. */
  const [readerMode, setReaderMode] = useState<"read" | "speak">("read");

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, panelOpen ? "1" : "0");
  }, [panelOpen]);

  const { subscribe } = useAudioAnalyzer({
    micTrack: s.micTrack,
    botAudio: s.botAudioRef,
    active: s.phase === "connected",
    micPulse: s.micPulse,
  });

  const models = s.models ?? FALLBACK_MODELS;
  // Same resolution as the pickers: saved choice → server default → first
  // roster item. The roster is in arbitrary API order, so never take [0].
  const voiceChoice = useMemo(
    () => resolveChoice("tts", models.tts, s.settings) ?? { provider: "kokoro", id: "af_heart" },
    [models, s.settings],
  );

  // Live preview for the active row (same truncation the server uses).
  const lastMsg = s.messages[s.messages.length - 1]?.text ?? null;
  const activePreview = lastMsg ? lastMsg.split(/\s+/).join(" ").slice(0, 80) : null;

  const sessions = useSessions({
    activeId: s.sessionId,
    activePreview,
    activeCount: s.messages.length,
    refetchKey: s.phase, // connect creates the row; disconnect bumps it
  });

  // Restore the URL's chat on load — /s/<id> means "this conversation is
  // open", so a reload (or a shared link) reopens it instead of home. Runs
  // once, once the sessions list has arrived.
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current) return;
    const id = sessionIdFromPath(location.pathname);
    if (!id || !sessions.loaded) return;
    didRestore.current = true;
    const meta = sessions.list.find((m) => m.id === id);
    if (meta) {
      void s.resumeSession(meta);
    } else {
      history.replaceState(null, "", "/"); // session gone — drop the stale path
    }
  }, [sessions.loaded, sessions.list, s.resumeSession]);

  // Back/Forward: follow the URL to whichever chat it names.
  useEffect(() => {
    const onPop = () => {
      const id = sessionIdFromPath(location.pathname);
      if (!id) {
        void s.newSession();
        return;
      }
      const meta = sessions.list.find((m) => m.id === id);
      if (meta) {
        void s.resumeSession(meta);
      } else {
        history.replaceState(null, "", "/"); // session gone — drop the stale path
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [sessions.list, s.resumeSession, s.newSession]);

  const inChat = s.phase === "connected" || s.phase === "disconnected";

  /** Home: a fresh conversation, whichever page is showing. The rail's Chat
   *  entry and its wordmark both land here — inside a live chat, "Chat" has to
   *  mean a *new* one, or the click does nothing at all. The finished
   *  conversation keeps its row in the rail (sqlite), so nothing is lost. */
  const goHome = (): void => {
    setView("chat");
    void s.newSession();
  };

  return (
    <div className="app">
      <audio ref={s.botAudioRef} hidden onPlay={s.handleAudioPlay} onPause={s.handleAudioPause} />

      <div className="body">
        <SessionsPanel
          open={panelOpen}
          sessions={sessions.list}
          activeId={s.sessionId}
          view={view}
          readerMode={readerMode}
          onNewChat={goHome}
          onReaderMode={(mode) => {
            setReaderMode(mode);
            setView("reader");
          }}
          onToggle={() => setPanelOpen((v) => !v)}
          onOpenSettings={() => setSettingsOpen(true)}
          onResume={(m) => {
            setView("chat"); // picking a conversation means looking at it, not the reader
            void s.resumeSession(m);
          }}
          onRename={(id, name) => void sessions.rename(id, name)}
          onDelete={(id) => void sessions.remove(id)}
        />

        {/* Right of the rail: the stage column — the header, then the scroller.
            The header is a sibling of the scroller rather than an overlay on
            it, so it cannot scroll away and needs no background of its own
            (which is what made it a black band over the page's glow). */}
        <div className="stage-col">
          {/* The header is the chat's chrome — status, role chip, New/End. Read
              and Speak are standalone pages with no session of their own, so
              none of it means anything there: the rail is the frame instead. */}
          {view === "chat" && (
            <Header
              phase={s.phase}
              status={s.status}
              speaking={s.speaking}
              role={s.role}
              roles={s.roles}
              onSelectRole={s.selectRole}
              onNewSession={goHome}
              onEndSession={() => void s.disconnect()}
            />
          )}

          {/* The main area is the scroller — not the document (which took the
              header and the rail away with it) and not the inner column (which
              left the gutters dead to the wheel). The rail keeps its own
              scroll, and the header sits above this box, not in it. */}
          <div className="main">
            <main className="stage">
              {view === "reader" ? (
                readerMode === "speak" ? (
                  <Dictate />
                ) : (
                  <Reader
                    models={models}
                    settings={s.settings}
                    onChangeVoice={(c) => s.updateSettings({ ...s.settings, tts: c })}
                    onChangeSettings={(patch) => s.updateSettings({ ...s.settings, ...patch })}
                  />
                )
              ) : inChat ? (
                <>
                  <Transcript
                    messages={s.messages}
                    role={s.role}
                    voiceChoice={voiceChoice}
                    activeBotId={s.activeBotId}
                    subscribe={subscribe}
                    phase={s.phase}
                    status={s.status}
                  />
                  {s.phase === "connected" ? (
                    <ComposerBar
                      phase={s.phase}
                      muted={s.muted}
                      micDisabled={false}
                      onToggleMute={() => void s.toggleMute()}
                      subscribe={subscribe}
                      onSend={s.sendText}
                    />
                  ) : (
                    <div className="ended-bar">
                      <span className="ended-text">Session ended — the conversation stays here.</span>
                      <button type="button" className="btn ghost" onClick={() => void s.connect()}>
                        Talk again
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <Hero
                  roles={s.roles}
                  customRoles={s.customRoles}
                  selected={s.role}
                  phase={s.phase}
                  onSelect={s.selectRole}
                  onConnect={() => void s.connect()}
                  onAddCustom={() => setPersonaOpen(true)}
                  onRemoveCustom={s.removeCustomRole}
                />
              )}
            </main>
          </div>
        </div>
      </div>

      {personaOpen && (
        <PersonaModal
          existingFiles={[...s.roles.map((r) => r.file), ...s.customRoles.map((r) => r.file)]}
          onSave={(r: Role) => {
            s.addCustomRole(r);
            setPersonaOpen(false);
          }}
          onClose={() => setPersonaOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          models={models}
          modelsLive={s.models !== null}
          modelsLoading={s.modelsLoading}
          onReloadModels={() => void s.refreshModels()}
          settings={s.settings}
          onChange={s.updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
