/**
 * Son — a personal real-time voice agent. React client for the Pipecat
 * runner: pick a role, connect over WebRTC, talk or type. Past sessions live
 * in the left rail (collapsible) and resume in place.
 */

import { useEffect, useMemo, useState } from "react";

import { useSonSession } from "./hooks/useSonSession";
import { useSessions } from "./hooks/useSessions";
import { useAudioAnalyzer } from "./hooks/useAudioAnalyzer";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { SessionsPanel } from "./components/SessionsPanel";
import { Transcript, ComposerBar } from "./components/Transcript";
import { SettingsModal } from "./components/SettingsModal";
import { FALLBACK_MODELS, resolveChoice } from "./lib/settings";

const PANEL_KEY = "son.panel";

export default function App() {
  const s = useSonSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== "0");

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, panelOpen ? "1" : "0");
  }, [panelOpen]);

  const { subscribe } = useAudioAnalyzer({
    micTrack: s.micTrack,
    botAudio: s.botAudioRef,
    active: s.phase === "connected",
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

  const inChat = s.phase === "connected" || s.phase === "disconnected";

  return (
    <div className="app">
      <audio ref={s.botAudioRef} hidden onPlay={s.handleAudioPlay} onPause={s.handleAudioPause} />

      <Header
        phase={s.phase}
        status={s.status}
        speaking={s.speaking}
        role={s.role}
        roles={s.roles}
        panelOpen={panelOpen}
        onSelectRole={s.selectRole}
        onNewSession={() => void s.newSession()}
        onTogglePanel={() => setPanelOpen((v) => !v)}
        onEndSession={() => void s.disconnect()}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="body">
        <SessionsPanel
          open={panelOpen}
          sessions={sessions.list}
          activeId={s.sessionId}
          onResume={(m) => void s.resumeSession(m)}
          onRename={(id, name) => void sessions.rename(id, name)}
          onDelete={(id) => void sessions.remove(id)}
        />

        <main className="stage">
          {inChat ? (
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
              selected={s.role}
              phase={s.phase}
              onSelect={s.selectRole}
              onConnect={() => void s.connect()}
            />
          )}
        </main>
      </div>

      {settingsOpen && (
        <SettingsModal
          models={models}
          settings={s.settings}
          onChange={s.updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
