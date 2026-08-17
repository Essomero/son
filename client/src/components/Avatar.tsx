/**
 * Avatars. Two kinds:
 *   - VoiceAvatar: a kokoro voice id decoded into a gradient + gender glyph
 *     + flag badge (see lib/voices.ts); cloud TTS voices fall back to a mic.
 *   - RoleAvatar: an initial on a hue derived from the role's name.
 */

import type { Choice } from "../lib/types";
import { voiceMeta, voiceSubtitle } from "../lib/voices";

export function VoiceAvatar({ choice, size = 40 }: { choice: Choice; size?: number }) {
  const meta = voiceMeta(choice.id);
  return (
    <span
      className="avatar"
      title={voiceSubtitle(choice.id)}
      style={{
        width: size,
        height: size,
        background: meta.gradient,
        fontSize: Math.round(size * 0.46),
      }}
      aria-hidden
    >
      <span className="avatar-glyph">{meta.glyph}</span>
      {meta.flag && (
        <span className="avatar-flag" style={{ fontSize: Math.max(10, Math.round(size * 0.32)) }}>
          {meta.flag}
        </span>
      )}
    </span>
  );
}

// Warm family only — cool hues would fight the studio palette.
const ROLE_HUES = [18, 30, 42, 55, 24, 36];

function roleHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return ROLE_HUES[h % ROLE_HUES.length];
}

export function RoleAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const hue = roleHue(name);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg, hsl(${hue} 42% 42%), hsl(${hue} 45% 24%))`,
        fontSize: Math.round(size * 0.44),
        fontWeight: 600,
      }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
