/**
 * Kokoro voice id decoding → avatar.
 *
 * Voice ids look like "af_heart": [accent][gender]_[name]. a=American,
 * b=British, f=female, m=male — so af_* is American female, bf_* British
 * female, am_* American male, etc. Each voice gets a circular avatar: a
 * gradient in the accent's palette, the gender's person glyph, and a small
 * flag badge. Cloud TTS voices (no kokoro id shape) fall back to a neutral
 * mic avatar.
 */

export interface VoiceMeta {
  name: string;
  /** e.g. "American" */
  accent: string;
  /** e.g. "female" */
  gender: string;
  flag: string;
  glyph: string;
  gradient: string;
  isKokoro: boolean;
}

const ACCENTS: Record<string, { label: string; flag: string; gradient: string }> = {
  a: { label: "American", flag: "🇺🇸", gradient: "linear-gradient(140deg, #c94f3f, #7e2f26)" },
  b: { label: "British", flag: "🇬🇧", gradient: "linear-gradient(140deg, #4a5aa6, #262c55)" },
};

const GENDERS: Record<string, { label: string; glyph: string }> = {
  f: { label: "female", glyph: "👩" },
  m: { label: "male", glyph: "👨" },
};

const FALLBACK_GRADIENT = "linear-gradient(140deg, #3b3427, #241f16)";
const FALLBACK_GLYPH = "🎙️";

export function voiceMeta(voiceId: string): VoiceMeta {
  const m = /^([a-z])([mf])_([a-z0-9]+)/.exec(voiceId);
  if (!m) {
    return {
      name: voiceId,
      accent: "",
      gender: "",
      flag: "",
      glyph: FALLBACK_GLYPH,
      gradient: FALLBACK_GRADIENT,
      isKokoro: false,
    };
  }
  const [, accentCode, genderCode, nameCode] = m;
  const accent = ACCENTS[accentCode];
  const gender = GENDERS[genderCode];
  const name = nameCode.charAt(0).toUpperCase() + nameCode.slice(1);
  return {
    name,
    accent: accent?.label ?? "",
    gender: gender?.label ?? "",
    flag: accent?.flag ?? "",
    glyph: gender?.glyph ?? FALLBACK_GLYPH,
    gradient: accent?.gradient ?? FALLBACK_GRADIENT,
    isKokoro: true,
  };
}

/** Subtitle for pickers: "Heart — American female". */
export function voiceSubtitle(voiceId: string): string {
  const v = voiceMeta(voiceId);
  if (!v.accent) return voiceId;
  return `${v.name} — ${v.accent} ${v.gender}`;
}
