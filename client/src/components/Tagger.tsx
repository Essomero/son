/**
 * The "Tag" page: label and convert audio files — the season tool for a
 * personal podcast. Pick one or more recordings; each becomes an episode
 * whose number and title you set, while the show/season fields (show, host,
 * season, year, genre, show notes, transcript, cover art) apply to every
 * file. A shared field left blank leaves each file's own tag alone, so a
 * season can be assembled from episodes that already carry their own notes.
 *
 * Nothing is synthesized here: the files are the user's own, uploaded to the
 * server (which is this machine), probed with ffprobe, and written back with
 * ffmpeg. The container's audio stream is copied unless the format changed or
 * Re-encode is on, so re-tagging never costs a generation of quality.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, ImagePlus, Loader2, Plus, Tags, Trash2, X } from "lucide-react";

import type { Settings, TagFormat, TagInfo, TagMode } from "../lib/types";
import { EXPORT_DEFAULTS_URL, TAG_INSPECT_URL, TAG_SAVE_URL } from "../lib/son";
import {
  TAG_BITRATES,
  TAG_CHANNELS,
  buildTagPreview,
  fmtSize,
  fmtTime,
  normalizeTagKey,
  parseError,
  sanitizeStem,
  TAG_COVER_FORMATS,
  TAG_FORMATS,
  TAG_SAMPLE_RATES,
  isTagFormat,
} from "../lib/audioFile";
import { copyText } from "../lib/clipboard";
import { OptionPicker } from "./OptionPicker";
const CURRENT_YEAR = String(new Date().getFullYear());

/** Podcast fields in form order. */
const PODCAST_FIELDS: { key: string; label: string; hint: string; placeholder?: string }[] = [
  { key: "album", label: "Show", hint: "album", placeholder: "Show name…" },
  { key: "artist", label: "Host / author", hint: "artist", placeholder: "Host or author…" },
  { key: "album_artist", label: "Show (sort)", hint: "album_artist", placeholder: "Show sort or publisher…" },
  { key: "grouping", label: "Season name", hint: "grouping", placeholder: "Season or series…" },
  { key: "disc", label: "Season", hint: "disc", placeholder: "Season #" },
  { key: "date", label: "Year", hint: "date", placeholder: CURRENT_YEAR },
  { key: "genre", label: "Genre", hint: "genre", placeholder: "Podcast" },
  { key: "composer", label: "Composer", hint: "composer", placeholder: "Theme composer…" },
];

const PODCAST_WIDE: { key: string; label: string; hint: string; placeholder: string }[] = [
  { key: "comment", label: "Show notes", hint: "comment", placeholder: "What this episode is about…" },
  { key: "lyrics", label: "Transcript", hint: "lyrics", placeholder: "Paste the source text — it stays searchable in the file" },
];

/** Music fields in form order. */
const MUSIC_FIELDS: { key: string; label: string; hint: string; placeholder?: string }[] = [
  { key: "album", label: "Album", hint: "album", placeholder: "Album name…" },
  { key: "artist", label: "Artist", hint: "artist", placeholder: "Track or band artist…" },
  { key: "album_artist", label: "Album artist", hint: "album_artist", placeholder: "Album artist (if different)…" },
  { key: "date", label: "Year", hint: "date", placeholder: CURRENT_YEAR },
  { key: "genre", label: "Genre", hint: "genre", placeholder: "e.g. Electronic, Rock, Classical…" },
  { key: "disc", label: "Disc #", hint: "disc", placeholder: "1" },
  { key: "composer", label: "Composer", hint: "composer", placeholder: "Songwriter or composer…" },
  { key: "grouping", label: "Grouping", hint: "grouping", placeholder: "Work, movement, or set…" },
];

const MUSIC_WIDE: { key: string; label: string; hint: string; placeholder: string }[] = [
  { key: "lyrics", label: "Lyrics", hint: "lyrics", placeholder: "Song lyrics…" },
  { key: "comment", label: "Comment", hint: "comment", placeholder: "Liner notes, description, or comment…" },
];
const KNOWN_TAGS: Record<string, true> = {
  album: true,
  artist: true,
  album_artist: true,
  grouping: true,
  disc: true,
  date: true,
  genre: true,
  composer: true,
  comment: true,
  lyrics: true,
  title: true,
  track: true,
};


interface Episode {
  id: string;
  file: File;
  /** Episode title → the file's title tag. */
  title: string;
  /** Episode number → the file's track tag. */
  track: string;
  info: TagInfo | null;
  error: string | null;
}

interface SaveResult {
  name: string;
  path?: string;
  size?: number;
  error?: string;
}

let uidCounter = 0;
const nextId = () => `tag-${++uidCounter}`;

/** Strip a file's extension for a usable starting title. */
function stemOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(jpe?g|png|webp|avif|gif|bmp|tiff|heic)$/i.test(file.name)
  );
}

export function Tagger({
  settings,
  onChangeSettings,
}: {
  settings: Settings;
  onChangeSettings: (patch: Partial<Settings>) => void;
}) {
  const [tagMode, setTagMode] = useState<TagMode>(settings.tagMode ?? "podcast");
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [shared, setShared] = useState<Record<string, string>>(() =>
    (settings.tagMode ?? "podcast") === "podcast"
      ? { genre: "Podcast", date: CURRENT_YEAR }
      : { date: CURRENT_YEAR },
  );

  const activeFields = tagMode === "music" ? MUSIC_FIELDS : PODCAST_FIELDS;
  const activeWide = tagMode === "music" ? MUSIC_WIDE : PODCAST_WIDE;

  const switchTagMode = (mode: TagMode) => {
    if (mode === tagMode) return;
    setTagMode(mode);
    onChangeSettings({ tagMode: mode });
    if (mode === "podcast") {
      if (!shared.genre) {
        setShared((prev) => ({ ...prev, genre: "Podcast" }));
      }
    } else {
      if (shared.genre === "Podcast") {
        setShared((prev) => {
          const next = { ...prev };
          const origGenre = episodes[0]?.info?.tags?.genre;
          if (origGenre && origGenre !== "Podcast") {
            next.genre = origGenre;
          } else {
            delete next.genre;
          }
          return next;
        });
      }
    }
  };
  const [extras, setExtras] = useState<{ id: string; key: string; value: string }[]>([]);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverDragging, setCoverDragging] = useState(false);
  const [pageDragging, setPageDragging] = useState(false);
  const coverDragCount = useRef(0);
  const pageDragCount = useRef(0);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!coverFile) {
      setCoverPreview(null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);

  const [dir, setDir] = useState(settings.tagDir ?? settings.exportDir ?? "");
  const [format, setFormat] = useState<TagFormat | "">(settings.tagFormat ?? "");
  const [bitrate, setBitrate] = useState(settings.tagBitrate ?? 128);
  const [sampleRate, setSampleRate] = useState<number | "">("");
  const [channels, setChannels] = useState<number | "">("");
  const [reencode, setReencode] = useState(false);

  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [probeOk, setProbeOk] = useState(true);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<SaveResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cmdCopied, setCmdCopied] = useState(false);

  /** The user has edited a shared field — stop prefilling from a lone file. */
  const sharedTouched = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  // applyInfo needs the live episode count, and inspect runs from a click
  // handler — a ref keeps that check honest without re-creating the callback.
  const episodesRef = useRef<Episode[]>([]);

  // Prefill the folder from the server's detected download dir, and learn
  // whether the ffmpeg tools exist. Mount-only, like the Read page's panel.
  useEffect(() => {
    let live = true;
    void fetch(EXPORT_DEFAULTS_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        // A server that predates these fields answers without them — that is
        // "unknown", not "missing binary", so only an explicit false warns.
        setFfmpegOk(d.ffmpeg !== false);
        setProbeOk(d.ffprobe !== false);
        if (!settings.tagDir && !settings.exportDir && typeof d.dir === "string") {
          setDir(d.dir);
          onChangeSettings({ tagDir: d.dir });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const single = episodes.length === 1;

  /** Fold a probe result into the form: episode title/number always, and —
   *  while a lone file is the whole season — every shared field and extra tag
   *  it already carries, so the full tagger shows the file's real state. */
  const applyInfo = (ep: Episode, info: TagInfo) => {
    const tags = info.tags ?? {};
    setEpisodes((list) =>
      list.map((e) =>
        e.id === ep.id
          ? {
              ...e,
              info,
              error: null,
              // Prefer what the file already says, then the file name — and
              // number an unnumbered episode by its place in the season.
              title: e.title || tags.title || stemOf(e.file.name),
              track: e.track || tags.track || String(list.findIndex((x) => x.id === ep.id) + 1),
            }
          : e,
      ),
    );
    if (episodesRef.current.length !== 1 || sharedTouched.current) return;
    const next: Record<string, string> = {};
    for (const f of [...activeFields, ...activeWide]) {
      if (tags[f.key]) next[f.key] = tags[f.key];
    }
    if (tagMode === "podcast") {
      if (!next.genre) next.genre = "Podcast";
    }
    if (!next.date) next.date = CURRENT_YEAR;
    setShared(next);
    setExtras(
      Object.entries(tags)
        .filter(([key]) => !KNOWN_TAGS[normalizeTagKey(key)])
        .map(([key, value]) => ({ id: nextId(), key, value })),
    );
  };

  const inspect = async (ep: Episode) => {
    const fd = new FormData();
    fd.append("file", ep.file);
    try {
      const res = await fetch(TAG_INSPECT_URL, { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          res.status === 404
            ? "This server doesn't have the Tag API yet — restart it (`son restart server`) and try again."
            : parseError(body) || `Could not read the file (HTTP ${res.status}).`,
        );
      }
      applyInfo(ep, (await res.json()) as TagInfo);
    } catch (e) {
      setEpisodes((list) =>
        list.map((x) => (x.id === ep.id ? { ...x, error: e instanceof Error ? e.message : "Inspect failed." } : x)),
      );
    }
  };

  // applyInfo needs the live episode count, and inspect is called from a
  // click handler — a ref keeps the check honest without re-creating it.
  useEffect(() => {
    episodesRef.current = episodes;
  }, [episodes]);

  const addFiles = (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const added: Episode[] = files.map((file) => ({
      id: nextId(),
      file,
      title: "",
      track: "",
      info: null,
      error: null,
    }));
    // A second file turns the form into a season: the lone-file tags that
    // filled the shared fields are that file's, not the show's — clear them.
    if (episodes.length > 0 && !sharedTouched.current) {
      setShared(tagMode === "podcast" ? { genre: "Podcast", date: CURRENT_YEAR } : { date: CURRENT_YEAR });
      setExtras([]);
    }
    setEpisodes((prev) => [...prev, ...added]);
    setResults([]);
    setError(null);
    void (async () => {
      for (const ep of added) await inspect(ep);
    })();
  };

  const onCoverDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!coverable) return;
    coverDragCount.current++;
    if (coverDragCount.current === 1) {
      setCoverDragging(true);
    }
  };

  const onCoverDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!coverable) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.dataTransfer.dropEffect = "copy";
  };

  const onCoverDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    coverDragCount.current = Math.max(0, coverDragCount.current - 1);
    if (coverDragCount.current === 0) {
      setCoverDragging(false);
    }
  };

  const onCoverDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    coverDragCount.current = 0;
    setCoverDragging(false);
    if (!coverable) return;
    const file = Array.from(e.dataTransfer.files).find(isImageFile);
    if (file) setCoverFile(file);
  };

  const onPageDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes("Files")) return;
    pageDragCount.current++;
    if (pageDragCount.current === 1) {
      setPageDragging(true);
    }
  };

  const onPageDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const onPageDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    pageDragCount.current = Math.max(0, pageDragCount.current - 1);
    if (pageDragCount.current === 0) {
      setPageDragging(false);
    }
  };

  const onPageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    pageDragCount.current = 0;
    setPageDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;

    const audioFiles = files.filter(
      (f) =>
        f.type.startsWith("audio/") ||
        /\.(mp3|m4a|wav|flac|ogg|opus|aac|m4b|aiff|wma)$/i.test(f.name),
    );
    const imageFiles = files.filter(isImageFile);
    const nonImages = files.filter((f) => !isImageFile(f));
    const effectiveAudio = audioFiles.length > 0 ? audioFiles : nonImages;

    if (effectiveAudio.length > 0) {
      addFiles(effectiveAudio);
    }
    if (imageFiles.length > 0 && coverable) {
      setCoverFile(imageFiles[0]);
    }
  };

  const updateEpisode = (id: string, patch: Partial<Episode>) =>
    setEpisodes((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const removeEpisode = (id: string) => setEpisodes((list) => list.filter((e) => e.id !== id));

  const setSharedField = (key: string, value: string) => {
    sharedTouched.current = true;
    setShared((prev) => ({ ...prev, [key]: value }));
  };

  /** Every tag a save will write for one episode: the file's own tags, the
   *  filled season fields on top, then the episode's own title and number. */
  const mergedTags = (ep: Episode): Record<string, string> => {
    const tags: Record<string, string> = { ...(ep.info?.tags ?? {}) };
    for (const [key, value] of Object.entries(shared)) {
      if (value.trim()) tags[key] = value.trim();
    }
    for (const x of extras) {
      const key = normalizeTagKey(x.key);
      if (key && x.value.trim()) tags[key] = x.value.trim();
    }
    const title = ep.title.trim();
    if (title) tags.title = title;
    else delete tags.title;
    const track = ep.track.trim();
    if (track) tags.track = track;
    else delete tags.track;
    return tags;
  };

  const formatFor = (ep: Episode): TagFormat =>
    format || (isTagFormat(ep.info?.format) ? (ep.info!.format as TagFormat) : "mp3");

  // The command preview stands in for the first episode; the server echoes the
  // real one per file after a save.
  const preview = useMemo(() => {
    if (!episodes.length) return "";
    const ep = episodes[0];
    const fmt = formatFor(ep);
    const copyAudio = !reencode && ep.info?.format === fmt;
    const stem = sanitizeStem(ep.title || ep.file.name);
    return buildTagPreview({
      srcName: ep.file.name,
      dst: `${(dir.trim() || "~/Downloads").replace(/\/+$/, "")}/${stem}.${fmt}`,
      format: fmt,
      tags: mergedTags(ep),
      copyAudio,
      bitrate: bitrate || null,
      sampleRate: sampleRate === "" ? null : sampleRate,
      channels: channels === "" ? null : channels,
      newCoverName: coverFile ? coverFile.name : "",
      keepCover: !coverFile && Boolean(ep.info?.cover) && TAG_COVER_FORMATS.includes(fmt),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, shared, extras, coverFile, dir, format, bitrate, sampleRate, channels, reencode]);

  const copyCommand = () =>
    void copyText(preview).then(() => {
      setCmdCopied(true);
      window.setTimeout(() => setCmdCopied(false), 1600);
    });

  const save = async () => {
    if (!episodes.length || saving) return;
    setSaving(true);
    setError(null);
    setResults([]);
    setProgress({ done: 0, total: episodes.length });
    try {
      let coverData: string | undefined;
      if (coverFile) {
        coverData = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
          r.onerror = () => reject(r.error ?? new Error("Could not read the cover image."));
          r.readAsDataURL(coverFile);
        });
        if (!coverData) throw new Error("The cover image could not be read.");
      }

      const out: SaveResult[] = [];
      for (const ep of episodes) {
        const fmt = formatFor(ep);
        const payload = {
          format: fmt,
          filename: sanitizeStem(ep.title || ep.file.name),
          dir: dir.trim() || undefined,
          tags: mergedTags(ep),
          bitrate: bitrate || undefined,
          sample_rate: sampleRate === "" ? undefined : sampleRate,
          channels: channels === "" ? undefined : channels,
          reencode,
          keep_cover: Boolean(ep.info?.cover),
          cover_data: coverData,
          cover_name: coverFile?.name,
        };
        const fd = new FormData();
        fd.append("file", ep.file);
        fd.append("payload", JSON.stringify(payload));
        try {
          const res = await fetch(TAG_SAVE_URL, { method: "POST", body: fd });
          const data = (await res.json().catch(() => null)) as
            | { detail?: string; path?: string; size?: number }
            | null;
          if (!res.ok) {
            out.push({
              name: ep.file.name,
              error:
                res.status === 404
                  ? "This server doesn't have the Tag API yet — restart it (`son restart server`)."
                  : data?.detail || `Save failed (HTTP ${res.status}).`,
            });
          } else {
            out.push({ name: ep.file.name, path: data?.path ?? "", size: data?.size ?? 0 });
          }
        } catch (e) {
          out.push({ name: ep.file.name, error: e instanceof Error ? e.message : "Save failed." });
        }
        setResults([...out]);
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      if (out.every((r) => r.error)) setError("Nothing was saved — see the rows above.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const coverable = !format || TAG_COVER_FORMATS.includes(format);
  const canSave = episodes.length > 0 && !saving && episodes.every((e) => e.info || e.error);

  return (
    <section
      className={`reader tagger${pageDragging ? " dragging" : ""}`}
      onDragEnter={onPageDragEnter}
      onDragOver={onPageDragOver}
      onDragLeave={onPageDragLeave}
      onDrop={onPageDrop}
    >
      <div className="reader-tabs tagger-tabs" role="tablist" aria-label="Tag mode" data-active={tagMode}>
        <div className="reader-tabs-thumb" aria-hidden />
        <button
          type="button"
          role="tab"
          aria-selected={tagMode === "podcast"}
          className={`tab-btn${tagMode === "podcast" ? " active" : ""}`}
          onClick={() => switchTagMode("podcast")}
          title="Podcast mode: show, host, season, episode, show notes, transcript"
        >
          Podcast
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tagMode === "music"}
          className={`tab-btn${tagMode === "music" ? " active" : ""}`}
          onClick={() => switchTagMode("music")}
          title="Music mode: album, artist, album artist, track, disc, lyrics, genre"
        >
          Music
        </button>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tagger-files">
          Audio files
        </label>
        <input
          id="tagger-files"
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.opus,.aac"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = ""; // allow re-picking the same file
          }}
        />
        <div className={`tagger-add${pageDragging ? " dragging" : ""}`}>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            <Plus size={15} aria-hidden />
            Add audio files
          </button>
          <span className="field-hint">
            {coverFile && episodes.length === 0
              ? `Cover art "${coverFile.name}" selected. Add audio files to assemble the ${tagMode === "music" ? "album" : "season"}.`
              : tagMode === "music"
                ? "One file is a track; several make an album. Drop audio files or images here."
                : "One file is a single episode; several make a season. Drop audio files or images here."}
          </span>
        </div>
      </div>

      {episodes.length > 0 && (
        <section className="export-panel">
          <h3 className="export-heading">{tagMode === "music" ? "Tracks" : "Episodes"}</h3>
          <ul className="tagger-list">
            {episodes.map((ep) => (
              <li key={ep.id} className="tagger-ep">
                <input
                  className="text-input tagger-ep-num"
                  value={ep.track}
                  onChange={(e) => updateEpisode(ep.id, { track: e.target.value })}
                  placeholder="#"
                  aria-label={`${tagMode === "music" ? "Track" : "Episode"} number for ${ep.file.name}`}
                  inputMode="numeric"
                />
                <input
                  className="text-input"
                  value={ep.title}
                  onChange={(e) => updateEpisode(ep.id, { title: e.target.value })}
                  placeholder={stemOf(ep.file.name)}
                  aria-label={`${tagMode === "music" ? "Track" : "Episode"} title for ${ep.file.name}`}
                />
                <span className="tagger-ep-meta">
                  {ep.error ? (
                    <span className="tagger-ep-bad">{ep.error}</span>
                  ) : ep.info ? (
                    <>
                      <span className="tagger-ep-name">{ep.file.name}</span>
                      {`${fmtTime(ep.info.duration)} · ${(ep.info.format ?? ep.info.codec) || "audio"} · ${fmtSize(ep.info.size)}`}
                    </>
                  ) : (
                    <>
                      <Loader2 size={13} className="spin" aria-hidden />
                      Reading…
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => removeEpisode(ep.id)}
                  title="Remove this file"
                  aria-label={`Remove ${ep.file.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {episodes.length > 0 && (
        <section className="export-panel">
          <h3 className="export-heading">
            {single
              ? tagMode === "music"
                ? "Track tags"
                : "Episode tags"
              : tagMode === "music"
                ? "Album / artist tags"
                : "Season / show tags"}
          </h3>
          <p className="tagger-note">
            <Tags size={13} aria-hidden />
            {single
              ? "Prefilled from the file — edit anything."
              : `Filled fields apply to every ${tagMode === "music" ? "track" : "episode"}; blank ones leave each file's own tag alone.`}
          </p>
          <div className="export-grid tagger-grid">
            {activeFields.map((f) => (
              <label key={f.key} className="export-field">
                <span className="export-label">
                  {f.label} <span className="tagger-tagkey">{f.key}</span>
                </span>
                <input
                  className="text-input"
                  value={shared[f.key] ?? ""}
                  onChange={(e) => setSharedField(f.key, e.target.value)}
                  placeholder={f.placeholder ?? "—"}
                  aria-label={f.label}
                />
              </label>
            ))}
          </div>
          <div className="tagger-wide">
            {activeWide.map((f) => (
              <label key={f.key} className="export-field">
                <span className="export-label">
                  {f.label} <span className="tagger-tagkey">{f.key}</span>
                </span>
                <textarea
                  className="text-input tagger-textarea"
                  value={shared[f.key] ?? ""}
                  onChange={(e) => setSharedField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  aria-label={f.label}
                />
              </label>
            ))}
          </div>

          <details className="export-tags">
            <summary>More tags</summary>
            <p className="field-hint">
              Any other tag the file carries, or any you want to add — written verbatim as an
              ffmpeg metadata key.
            </p>
            <div className="tagger-extra-list">
              {extras.map((x) => (
                <div key={x.id} className="tagger-extra-row">
                  <input
                    className="text-input"
                    value={x.key}
                    onChange={(e) => setExtras((list) => list.map((k) => (k.id === x.id ? { ...k, key: e.target.value } : k)))}
                    placeholder="key"
                    aria-label="Tag name"
                  />
                  <input
                    className="text-input"
                    value={x.value}
                    onChange={(e) => setExtras((list) => list.map((k) => (k.id === x.id ? { ...k, value: e.target.value } : k)))}
                    placeholder="value"
                    aria-label="Tag value"
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setExtras((list) => list.filter((k) => k.id !== x.id))}
                    title="Remove this tag"
                    aria-label="Remove this tag"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn ghost tagger-extra-add"
                onClick={() => setExtras((list) => [...list, { id: nextId(), key: "", value: "" }])}
              >
                <Plus size={14} aria-hidden />
                Add tag
              </button>
            </div>
          </details>

          <div
            className={`export-field export-cover tagger-cover${coverDragging ? " dragging" : ""}`}
            onDragEnter={onCoverDragEnter}
            onDragOver={onCoverDragOver}
            onDragLeave={onCoverDragLeave}
            onDrop={onCoverDrop}
          >
            <span className="export-label">Cover art (all {tagMode === "music" ? "tracks" : "episodes"})</span>
            <input
              ref={coverRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                setCoverFile(e.target.files?.[0] ?? null);
                e.target.value = ""; // allow re-picking the same file
              }}
            />
            <div className="export-cover-row">
              <button
                type="button"
                className={`btn ghost export-cover-btn${coverDragging ? " dragging" : ""}`}
                onClick={() => coverRef.current?.click()}
                disabled={!coverable}
                title={
                  coverable
                    ? "Pick or drop an image from this computer"
                    : "Cover art fits MP3 and M4A only"
                }
              >
                {coverPreview ? (
                  <img src={coverPreview} alt="" className="export-cover-thumb" />
                ) : (
                  <ImagePlus size={14} aria-hidden />
                )}
                <span className="export-cover-name">
                  {coverDragging
                    ? "Drop image here"
                    : coverFile
                      ? coverFile.name
                      : "Choose or drop image…"}
                </span>
              </button>
              {coverFile && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setCoverFile(null)}
                  title="Remove cover art"
                  aria-label="Remove cover art"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <span className="field-hint">
              {coverable
                ? "Embedded in MP3 and M4A. Drop an image or click to browse. Left empty, each file keeps the art it already has."
                : "Cover art fits MP3 and M4A — choose one of those formats to embed it."}
            </span>
          </div>
        </section>
      )}

      {episodes.length > 0 && (
        <section className="export-panel">
          <h3 className="export-heading">Convert &amp; save</h3>
          <div className="export-grid">
            <div className="export-field">
              <span className="export-label">Format</span>
              <OptionPicker
                options={[{ value: "", label: "Keep each file's format" }, ...TAG_FORMATS]}
                value={format}
                onChange={(v) => {
                  const f = (v || "") as TagFormat | "";
                  setFormat(f);
                  onChangeSettings({ tagFormat: f });
                  if (f && !TAG_COVER_FORMATS.includes(f)) setCoverFile(null);
                }}
                label="Format"
              />
            </div>
            <div className="export-field">
              <span className="export-label">Bitrate</span>
              <OptionPicker
                options={TAG_BITRATES.map((b) => ({ value: String(b), label: `${b} kbps` }))}
                value={String(bitrate)}
                onChange={(v) => {
                  const b = Number(v);
                  setBitrate(b);
                  onChangeSettings({ tagBitrate: b });
                }}
                label="Bitrate"
              />
            </div>
            <div className="export-field">
              <span className="export-label">Sample rate</span>
              <OptionPicker
                options={[{ value: "", label: "Keep" }, ...TAG_SAMPLE_RATES.map((r) => ({ value: String(r), label: `${r} Hz` }))]}
                value={String(sampleRate)}
                onChange={(v) => setSampleRate(v === "" ? "" : Number(v))}
                label="Sample rate"
              />
            </div>
            <div className="export-field">
              <span className="export-label">Channels</span>
              <OptionPicker
                options={[
                  { value: "", label: "Keep" },
                  ...TAG_CHANNELS.map((c) => ({ value: String(c), label: c === 1 ? "Mono" : "Stereo" })),
                ]}
                value={String(channels)}
                onChange={(v) => setChannels(v === "" ? "" : Number(v))}
                label="Channels"
              />
            </div>
            <label className="export-field export-folder">
              <span className="export-label">Folder</span>
              <input
                className="text-input"
                value={dir}
                onChange={(e) => {
                  setDir(e.target.value);
                  onChangeSettings({ tagDir: e.target.value.trim() || undefined });
                }}
                placeholder="~/Downloads (detected)"
                aria-label="Folder"
              />
              <span className="field-hint">
                The server writes each episode here. Same-named files get " (2)" instead of being
                overwritten.
              </span>
            </label>
          </div>

          <label className="export-field tagger-reencode">
            <span className="tagger-check">
              <input
                type="checkbox"
                checked={reencode}
                onChange={(e) => setReencode(e.target.checked)}
              />
              <span>
                Re-encode audio
                <span className="field-hint">
                  Off: same-format files keep their stream (lossless, instant) — bitrate, sample
                  rate and channels apply only when on, or when the format changes.
                </span>
              </span>
            </span>
          </label>

          {preview && (
            <div className="export-cmd">
              <code>{preview}</code>
              <button
                type="button"
                className={`icon-btn export-copy${cmdCopied ? " copied" : ""}`}
                onClick={copyCommand}
                title="Copy the ffmpeg command"
                aria-label="Copy the ffmpeg command"
              >
                {cmdCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          )}

          <div className="export-actions">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={!canSave}>
              {saving ? <Loader2 size={15} className="spin" aria-hidden /> : <Download size={15} aria-hidden />}
              {saving
                ? `Saving ${progress.done + 1} of ${progress.total}…`
                : episodes.length > 1
                  ? `Save all ${episodes.length} episodes`
                  : "Save to folder"}
            </button>
          </div>

          {!probeOk && (
            <p className="reader-error">
              <span>
                ffprobe isn't installed on the server — install ffmpeg (
                <code>brew install ffmpeg</code>) to read and label audio files.
              </span>
            </p>
          )}
          {!ffmpegOk && (
            <p className="reader-error">
              <span>ffmpeg isn't installed on the server — files can't be converted or tagged until it is.</span>
            </p>
          )}
          {error && (
            <p className="reader-error" role="alert">
              {error}
            </p>
          )}
          {results.length > 0 && (
            <ul className="tagger-results">
              {results.map((r, i) => (
                <li key={`${r.name}-${i}`} className={r.error ? "tagger-ep-bad" : "export-result"}>
                  {r.error ? (
                    <>
                      <strong>{r.name}</strong> — {r.error}
                    </>
                  ) : (
                    <>
                      Saved <strong>{r.path}</strong> ({fmtSize(r.size ?? 0)})
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!episodes.length && (
        <p className="reader-note">
          <Tags size={14} aria-hidden />
          {tagMode === "music"
            ? "Add one track to label it, or an album's worth to tag them together and convert them to one format. Audio is copied, never re-encoded, unless you ask."
            : "Add one recording to label it, or a season's worth to tag them together and convert them to one format. Audio is copied, never re-encoded, unless you ask."}
        </p>
      )}
    </section>
  );
}
