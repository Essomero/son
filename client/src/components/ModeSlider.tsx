/** The Read | Speak | Tag control: three segments in one pill, with a
 *  highlight that slides between them — the Write/Preview tab pattern, one
 *  level up. They are different actions, so picking one *opens* that page;
 *  nothing renders more than one. It lives in the rail's foot, where the
 *  destinations you switch between are. */
export type ReaderMode = "read" | "speak" | "tag";

const SEGMENTS: { value: ReaderMode; label: string; title: string }[] = [
  { value: "read", label: "Read", title: "Read: turn text into speech" },
  { value: "speak", label: "Speak", title: "Speak: dictate, and the text lands on your clipboard" },
  { value: "tag", label: "Tag", title: "Tag: label audio files and convert them into a podcast season" },
];

export function ModeSlider({
  mode,
  onPick,
}: {
  mode: ReaderMode;
  onPick: (mode: ReaderMode) => void;
}) {
  const step = (delta: number) => {
    const index = SEGMENTS.findIndex((s) => s.value === mode);
    const next = Math.min(Math.max(index + delta, 0), SEGMENTS.length - 1);
    onPick(SEGMENTS[next].value);
  };

  return (
    <div
      className="mode-slider"
      data-mode={mode}
      role="radiogroup"
      aria-label="Read, speak, or tag audio"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") step(-1);
        else if (event.key === "ArrowRight") step(1);
      }}
    >
      <div className="mode-slider-thumb" aria-hidden />
      {SEGMENTS.map((segment) => (
        <button
          key={segment.value}
          type="button"
          role="radio"
          aria-checked={mode === segment.value}
          className="mode-btn"
          onClick={() => onPick(segment.value)}
          title={segment.title}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}
