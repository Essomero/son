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
import { Check, ChevronLeft, ChevronRight, Copy, Download, ImagePlus, Loader2, Plus, Tags, Trash2, X } from "lucide-react";

import type { Settings, TagFormat, TagInfo, TagMode } from "../lib/types";
import { EXPORT_DEFAULTS_URL, TAG_INSPECT_URL, TAG_LOAD_URL, TAG_SAVE_URL } from "../lib/son";
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
import { copyText, readClipboard } from "../lib/clipboard";
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
  file?: File;
  localPath?: string;
  name: string;
  /** Episode title → the file's title tag. */
  title: string;
  /** Episode number → the file's track tag. */
  track: string;
  /** Per-song tags */
  tags: Record<string, string>;
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

/** The file list is windowed: a folder load can hand us 80+ files, and 80 rows
 *  of live <input>s is a lot of DOM for a box you can only see seven rows of.
 *  Row height is fixed in CSS (.tagger-ep) so the geometry is arithmetic, not
 *  measurement — the two must stay in step. */
const TAG_ROW_H = 48;
const TAG_LIST_ROWS = 7;
const TAG_LIST_H = TAG_ROW_H * TAG_LIST_ROWS;
const TAG_OVERSCAN = 2;
const TAG_WINDOW = TAG_LIST_ROWS + TAG_OVERSCAN * 2;


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
  const [selectedEpId, setSelectedEpId] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(true);
  const [loadFolderPath, setLoadFolderPath] = useState("");
  const [loadingFolder, setLoadingFolder] = useState(false);
  const [loadFolderError, setLoadFolderError] = useState<string | null>(null);
  const [copiedFromPrev, setCopiedFromPrev] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  /** Windowed list: which episode index the scroller starts at. Quantized to a
   *  row, so a scroll re-renders only when the window actually moves. */
  const [listStart, setListStart] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);


  const updateFolder = (val: string) => {
    const trimmed = val.trim();
    let folder = trimmed;
    if (/\.(mp3|m4a|wav|flac|ogg|opus|aac|m4b|aiff)$/i.test(trimmed)) {
      const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      if (idx > 0) folder = trimmed.slice(0, idx);
    }
    setDir(folder);
    onChangeSettings({ tagDir: folder || undefined });
  };

  const pasteFolder = async () => {
    const text = await readClipboard();
    if (text) updateFolder(text);
  };

  const loadFromBackendFolder = async (rawPath: string) => {
    const targetPath = rawPath.trim();
    if (!targetPath || loadingFolder) return;
    setLoadingFolder(true);
    setLoadFolderError(null);
    try {
      const res = await fetch(TAG_LOAD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath }),
      });
      const data = (await res.json().catch(() => null)) as {
        folder?: string;
        files?: { name: string; path: string; dir: string; size: number; info: TagInfo | null; error: string | null }[];
        detail?: string;
      } | null;
      if (!res.ok) {
        throw new Error(data?.detail || `Could not load folder (HTTP ${res.status}).`);
      }
      if (!Array.isArray(data?.files) || !data.files.length) {
        throw new Error("No supported audio files found in that folder.");
      }
      const loaded: Episode[] = data.files.map((item, idx) => {
        const info = item.info;
        const tags = info?.tags ?? {};
        return {
          id: nextId(),
          localPath: item.path,
          name: item.name,
          title: tags.title || stemOf(item.name),
          track: tags.track || String(idx + 1),
          tags: { ...tags },
          info,
          error: item.error || null,
        };
      });

      if (data.folder) {
        setDir(data.folder);
        onChangeSettings({ tagDir: data.folder });
      }

      setEpisodes(loaded);
      if (loaded.length > 0) {
        setSelectedEpId(loaded[0].id);
      }
      setResults([]);
      setError(null);
    } catch (e) {
      setLoadFolderError(e instanceof Error ? e.message : "Failed to load folder.");
    } finally {
      setLoadingFolder(false);
    }
  };

  const selectedEp = episodes.find((e) => e.id === selectedEpId) ?? (episodes.length === 1 ? episodes[0] : null);
  const currentSongIndex = selectedEp ? episodes.findIndex((e) => e.id === selectedEp.id) : -1;

  const goToPrevSong = () => {
    if (!episodes.length) return;
    if (currentSongIndex <= 0) {
      setSelectedEpId(episodes[0].id);
    } else {
      setSelectedEpId(episodes[currentSongIndex - 1].id);
    }
  };

  const goToNextSong = () => {
    if (!episodes.length) return;
    if (currentSongIndex < 0 || currentSongIndex >= episodes.length - 1) {
      setSelectedEpId(episodes[episodes.length - 1].id);
    } else {
      setSelectedEpId(episodes[currentSongIndex + 1].id);
    }
  };

  const removeEpisode = (id: string) => {
    setEpisodes((list) => {
      const remaining = list.filter((e) => e.id !== id);
      if (selectedEpId === id) {
        if (!remaining.length) {
          setSelectedEpId(null);
        } else {
          const removedIdx = list.findIndex((e) => e.id === id);
          const nextIdx = Math.min(removedIdx, remaining.length - 1);
          setSelectedEpId(remaining[nextIdx].id);
        }
      }
      return remaining;
    });
  };

  const setSongTag = (epId: string, key: string, value: string) => {
    setEpisodes((list) =>
      list.map((e) => {
        if (e.id !== epId) return e;
        const nextTags = { ...(e.tags ?? {}), [key]: value };
        const patch: Partial<Episode> = { tags: nextTags };
        if (key === "title") patch.title = value;
        if (key === "track") patch.track = value;
        return { ...e, ...patch };
      }),
    );
  };

  // The window: only the rows around the scroll offset are mounted, with
  // spacer rows standing in for the rest so the scrollbar still spans all of
  // them. Rows are a fixed TAG_ROW_H (see .tagger-ep), so this is arithmetic.
  const maxListStart = Math.max(0, episodes.length - TAG_WINDOW);
  const start = Math.min(listStart, maxListStart);
  const windowRows = episodes.slice(start, start + TAG_WINDOW);
  const padTop = start * TAG_ROW_H;
  const padBottom = (episodes.length - start - windowRows.length) * TAG_ROW_H;

  const onListScroll = (e: React.UIEvent<HTMLUListElement>) => {
    const raw = Math.floor(e.currentTarget.scrollTop / TAG_ROW_H) - TAG_OVERSCAN;
    const next = Math.max(0, Math.min(raw, maxListStart));
    setListStart((prev) => (prev === next ? prev : next));
  };

  // `episodes` shrinking under a standing offset would leave a blank window.
  useEffect(() => {
    setListStart((prev) => Math.min(prev, Math.max(0, episodes.length - TAG_WINDOW)));
  }, [episodes.length]);

  // Keep the selected row in view — the slider's Prev/Next moves the selection
  // without touching the list's own scroll position.
  useEffect(() => {
    const el = listRef.current;
    const idx = episodes.findIndex((e) => e.id === selectedEpId);
    if (!el || idx < 0) return;
    const top = idx * TAG_ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + TAG_ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + TAG_ROW_H - el.clientHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEpId]);

  const copyFromPreviousSong = () => {
    if (!selectedEp || currentSongIndex <= 0) return;
    const prevEp = episodes[currentSongIndex - 1];
    const prevTags = { ...(prevEp.tags ?? {}) };
    const curTitle = selectedEp.title;
    const curTrack = selectedEp.track;
    const nextTags: Record<string, string> = {
      ...prevTags,
      ...(selectedEp.tags ?? {}),
      album: prevTags.album || shared.album || "",
      artist: prevTags.artist || shared.artist || "",
      album_artist: prevTags.album_artist || shared.album_artist || "",
      date: prevTags.date || shared.date || "",
      genre: prevTags.genre || shared.genre || "",
      composer: prevTags.composer || shared.composer || "",
      grouping: prevTags.grouping || shared.grouping || "",
      disc: prevTags.disc || shared.disc || "",
    };
    if (curTitle) nextTags.title = curTitle;
    if (curTrack) nextTags.track = curTrack;

    setEpisodes((list) =>
      list.map((e) => (e.id === selectedEp.id ? { ...e, tags: nextTags } : e)),
    );
    setCopiedFromPrev(true);
    window.setTimeout(() => setCopiedFromPrev(false), 1600);
  };

  useEffect(() => {
    if (!sliderRef.current) return;
    const activeEl = sliderRef.current.querySelector(".tagger-snapshot.active") as HTMLElement;
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [selectedEpId]);

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
              title: e.title || tags.title || stemOf(e.name),
              track: e.track || tags.track || String(list.findIndex((x) => x.id === ep.id) + 1),
              tags: { ...tags, ...(e.tags ?? {}) },
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
    if (!ep.file) return;
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
      name: file.name,
      title: "",
      track: "",
      tags: {},
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
    for (const [key, value] of Object.entries(ep.tags ?? {})) {
      if (value.trim()) tags[key] = value.trim();
    }
    const title = ep.title.trim() || tags.title;
    if (title) tags.title = title;
    const track = ep.track.trim() || tags.track;
    if (track) tags.track = track;
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
    const stem = sanitizeStem(ep.title || ep.name);
    return buildTagPreview({
      srcName: ep.localPath || ep.name,
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
          filename: sanitizeStem(ep.title || ep.name),
          dir: dir.trim() || undefined,
          overwrite,
          local_path: ep.localPath,
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
        if (ep.file) {
          fd.append("file", ep.file);
        }
        fd.append("payload", JSON.stringify(payload));
        try {
          const res = await fetch(TAG_SAVE_URL, { method: "POST", body: fd });
          const data = (await res.json().catch(() => null)) as
            | { detail?: string; path?: string; size?: number }
            | null;
          if (!res.ok) {
            out.push({
              name: ep.name,
              error:
                res.status === 404
                  ? "This server doesn't have the Tag API yet — restart it (`son restart server`)."
                  : data?.detail || `Save failed (HTTP ${res.status}).`,
            });
          } else {
            out.push({ name: ep.name, path: data?.path ?? "", size: data?.size ?? 0 });
          }
        } catch (e) {
          out.push({ name: ep.name, error: e instanceof Error ? e.message : "Save failed." });
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
        <div className="tagger-folder-loader">
          <input
            className="text-input tagger-folder-input"
            value={loadFolderPath}
            onChange={(e) => setLoadFolderPath(e.target.value)}
            placeholder="Or paste a folder path to load music files directly (e.g. ~/Music/iPhone)"
            aria-label="Folder path"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void loadFromBackendFolder(loadFolderPath);
              }
            }}
          />
          <button
            type="button"
            className="btn ghost sm tagger-folder-btn"
            onClick={() => void loadFromBackendFolder(loadFolderPath)}
            disabled={!loadFolderPath.trim() || loadingFolder}
          >
            {loadingFolder ? <Loader2 size={14} className="spin" /> : "Load folder"}
          </button>
        </div>
        {loadFolderError && (
          <p className="reader-error" role="alert">
            <span>{loadFolderError}</span>
          </p>
        )}
      </div>

      {episodes.length > 0 && (
        <section className="export-panel">
          <h3 className="export-heading">
            {tagMode === "music" ? "Tracks" : "Episodes"}{" "}
            <span className="tagger-count">{episodes.length}</span>
          </h3>
          <ul
            ref={listRef}
            className="tagger-list"
            style={{ maxHeight: TAG_LIST_H }}
            onScroll={onListScroll}
          >
            {padTop > 0 && <li className="tagger-spacer" style={{ height: padTop }} aria-hidden />}
            {windowRows.map((ep) => (
              <li
                key={ep.id}
                className={`tagger-ep${selectedEp?.id === ep.id ? " selected" : ""}`}
                onClick={() => setSelectedEpId(ep.id)}
              >
                <input
                  className="text-input tagger-ep-num"
                  value={ep.track}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateEpisode(ep.id, { track: e.target.value })}
                  placeholder="#"
                  aria-label={`${tagMode === "music" ? "Track" : "Episode"} number for ${ep.name}`}
                  inputMode="numeric"
                />
                <input
                  className="text-input"
                  value={ep.title}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateEpisode(ep.id, { title: e.target.value })}
                  placeholder={stemOf(ep.name)}
                  aria-label={`${tagMode === "music" ? "Track" : "Episode"} title for ${ep.name}`}
                />
                <span className="tagger-ep-meta">
                  {ep.error ? (
                    <span className="tagger-ep-bad">{ep.error}</span>
                  ) : ep.info ? (
                    <>
                      <span className="tagger-ep-name">{ep.name}</span>
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
                  onClick={(e) => {
                    e.stopPropagation();
                    removeEpisode(ep.id);
                  }}
                  title="Remove this file"
                  aria-label={`Remove ${ep.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {padBottom > 0 && <li className="tagger-spacer" style={{ height: padBottom }} aria-hidden />}
          </ul>
        </section>
      )}

      {episodes.length > 0 && (
        <section className="export-panel">
          {episodes.length > 1 && (
            <div className="tagger-slider-wrap">
              <button
                type="button"
                className="tagger-slider-arrow"
                onClick={goToPrevSong}
                disabled={currentSongIndex <= 0}
                title="Previous song"
                aria-label="Previous song"
              >
                <ChevronLeft size={18} />
              </button>

              <div ref={sliderRef} className="tagger-slider-track">
                <button
                  type="button"
                  className={`tagger-snapshot${selectedEpId === null ? " active" : ""}`}
                  onClick={() => setSelectedEpId(null)}
                  title="Edit shared album tags that apply across all files"
                >
                  <div className="tagger-snapshot-head">
                    <span className="tagger-snapshot-badge">ALL</span>
                    <Tags size={13} aria-hidden />
                  </div>
                  <div className="tagger-snapshot-body">
                    <span className="tagger-snapshot-title">{tagMode === "music" ? "Album tags" : "Season tags"}</span>
                    <span className="tagger-snapshot-sub">{episodes.length} {tagMode === "music" ? "tracks" : "episodes"}</span>
                  </div>
                </button>

                {episodes.map((ep, idx) => {
                  const isActive = selectedEp?.id === ep.id;
                  const displayTitle = ep.title || stemOf(ep.name);
                  const displayArtist = ep.tags.artist || shared.artist || (tagMode === "music" ? "Unknown artist" : "Unknown host");
                  return (
                    <div
                      key={ep.id}
                      className={`tagger-snapshot${isActive ? " active" : ""}`}
                      onClick={() => setSelectedEpId(ep.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedEpId(ep.id);
                        }
                      }}
                      title={`Track ${ep.track || idx + 1}: ${displayTitle}`}
                    >
                      <div className="tagger-snapshot-head">
                        <span className="tagger-snapshot-badge">#{ep.track || idx + 1}</span>
                        <button
                          type="button"
                          className="tagger-snapshot-del"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeEpisode(ep.id);
                          }}
                          title={`Remove ${ep.name} (won't be tagged/overwritten)`}
                          aria-label={`Remove ${ep.name}`}
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="tagger-snapshot-body">
                        <span className="tagger-snapshot-title">{displayTitle}</span>
                        <span className="tagger-snapshot-sub">{displayArtist}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                className="tagger-slider-arrow"
                onClick={goToNextSong}
                disabled={currentSongIndex < 0 || currentSongIndex >= episodes.length - 1}
                title="Next song"
                aria-label="Next song"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}

          <div className="tagger-tags-head">
            <h3 className="export-heading">
              {selectedEp
                ? `Tags for: "${selectedEp.title || stemOf(selectedEp.name)}"`
                : single
                  ? tagMode === "music"
                    ? "Track tags"
                    : "Episode tags"
                  : tagMode === "music"
                    ? "Album / artist tags (all tracks)"
                    : "Season / show tags (all episodes)"}
            </h3>
            {selectedEp && currentSongIndex > 0 && (
              <button
                type="button"
                className={`btn ghost sm tagger-copy-prev${copiedFromPrev ? " copied" : ""}`}
                onClick={copyFromPreviousSong}
                title={`Copy album, artist, year and genre from track ${currentSongIndex}`}
              >
                {copiedFromPrev ? <Check size={13} /> : <Copy size={13} />}
                {copiedFromPrev ? "Copied from previous track!" : "Copy previous track's tags"}
              </button>
            )}
          </div>

          <p className="tagger-note">
            <Tags size={13} aria-hidden />
            {selectedEp
              ? `Editing full tags for this specific ${tagMode === "music" ? "track" : "episode"}. Switch snapshots above or click "Album tags" for shared metadata.`
              : single
                ? "Prefilled from the file — edit anything."
                : `Filled fields apply to every ${tagMode === "music" ? "track" : "episode"}; blank ones leave each file's own tag alone.`}
          </p>

          <div className="export-grid tagger-grid">
            {activeFields.map((f) => {
              const val = selectedEp ? (selectedEp.tags[f.key] ?? shared[f.key] ?? "") : (shared[f.key] ?? "");
              return (
                <label key={f.key} className="export-field">
                  <span className="export-label">
                    {f.label} <span className="tagger-tagkey">{f.key}</span>
                  </span>
                  <input
                    className="text-input"
                    value={val}
                    onChange={(e) => {
                      if (selectedEp) setSongTag(selectedEp.id, f.key, e.target.value);
                      else setSharedField(f.key, e.target.value);
                    }}
                    placeholder={f.placeholder ?? "—"}
                    aria-label={f.label}
                  />
                </label>
              );
            })}
          </div>
          <div className="tagger-wide">
            {activeWide.map((f) => {
              const val = selectedEp ? (selectedEp.tags[f.key] ?? shared[f.key] ?? "") : (shared[f.key] ?? "");
              return (
                <label key={f.key} className="export-field">
                  <span className="export-label">
                    {f.label} <span className="tagger-tagkey">{f.key}</span>
                  </span>
                  <textarea
                    className="text-input tagger-textarea"
                    value={val}
                    onChange={(e) => {
                      if (selectedEp) setSongTag(selectedEp.id, f.key, e.target.value);
                      else setSharedField(f.key, e.target.value);
                    }}
                    placeholder={f.placeholder}
                    aria-label={f.label}
                  />
                </label>
              );
            })}
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

          <div className="export-field export-cover tagger-cover">
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
            <div
              className={`tagger-cover-zone${coverDragging ? " dragging" : ""}${!coverable ? " disabled" : ""}`}
              onDragEnter={onCoverDragEnter}
              onDragOver={onCoverDragOver}
              onDragLeave={onCoverDragLeave}
              onDrop={onCoverDrop}
              onClick={() => {
                if (coverable) coverRef.current?.click();
              }}
              role="button"
              tabIndex={coverable ? 0 : -1}
              onKeyDown={(e) => {
                if (coverable && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  coverRef.current?.click();
                }
              }}
              title={
                coverable
                  ? "Pick or drop an image from this computer"
                  : "Cover art fits MP3 and M4A only"
              }
            >
              {coverPreview ? (
                <div className="tagger-cover-preview-row">
                  <img src={coverPreview} alt="Cover preview" className="tagger-cover-preview-img" />
                  <div className="tagger-cover-info">
                    <span className="tagger-cover-filename">{coverFile?.name}</span>
                    <span className="tagger-cover-subtext">
                      {coverDragging
                        ? "Drop to replace cover image"
                        : "Click or drop an image to replace"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="icon-btn tagger-cover-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCoverFile(null);
                    }}
                    title="Remove cover art"
                    aria-label="Remove cover art"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <div className="tagger-cover-prompt">
                  <ImagePlus size={24} className="tagger-cover-icon" aria-hidden />
                  <span className="tagger-cover-text">
                    {coverDragging ? "Drop image here" : "Choose or drop cover image…"}
                  </span>
                  <span className="field-hint tagger-cover-hint">
                    {coverable
                      ? "Embedded in MP3 and M4A. Left empty, each file keeps the art it already has."
                      : "Cover art fits MP3 and M4A — choose one of those formats to embed it."}
                  </span>
                </div>
              )}
            </div>
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
            <div className="export-field export-folder">
              <span className="export-label">
                Save folder <span className="export-label-hint">— overrides ~/Downloads</span>
              </span>
              <div className="export-folder-row">
                <input
                  className="text-input export-folder-input"
                  value={dir}
                  onChange={(e) => updateFolder(e.target.value)}
                  placeholder="Paste folder path to override ~/Downloads (e.g. ~/Music/iPhone)"
                  aria-label="Save folder path"
                />
                <button
                  type="button"
                  className="btn ghost sm export-folder-paste"
                  onClick={() => void pasteFolder()}
                  title="Paste path from clipboard to override ~/Downloads"
                >
                  <Copy size={13} aria-hidden />
                  Paste path
                </button>
                {dir && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => updateFolder("")}
                    title="Clear folder (use default ~/Downloads)"
                    aria-label="Clear folder"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <span className="field-hint">
                {dir
                  ? `Writing into "${dir}". Paste any folder (or file path) to override.`
                  : "Defaults to ~/Downloads when loaded from browser. Paste any folder path above to override."}
              </span>
            </div>
          </div>

          <label className="export-field tagger-reencode">
            <span className="tagger-check">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              <span>
                Replace existing files in folder
                <span className="field-hint">
                  {overwrite
                    ? "Overwrites the file in place. Uncheck to write a ' (2)' copy instead."
                    : "Writes a ' (2)' copy so existing files in the folder are left untouched."}
                </span>
              </span>
            </span>
          </label>

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
