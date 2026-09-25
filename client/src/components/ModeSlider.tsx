/** The Read | Speak control: two segments in one pill, with a highlight that
 *  slides between them — the Write/Preview tab pattern, one level up. They are
 *  different actions, so picking one *opens* that page; nothing renders both.
 *  It lives in the rail's nav now, beside the Chat destination it sits between. */
export function ModeSlider({
  mode,
  onPick,
}: {
  mode: "read" | "speak";
  onPick: (mode: "read" | "speak") => void;
}) {
  return (
    <div
      className="mode-slider"
      data-mode={mode}
      role="radiogroup"
      aria-label="Read or speak"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onPick("read");
        else if (event.key === "ArrowRight") onPick("speak");
      }}
    >
      <div className="mode-slider-thumb" aria-hidden />
      {(["read", "speak"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          className="mode-btn"
          onClick={() => onPick(value)}
          title={
            value === "read"
              ? "Read: turn text into speech"
              : "Speak: dictate, and the text lands on your clipboard"
          }
        >
          {value === "read" ? "Read" : "Speak"}
        </button>
      ))}
    </div>
  );
}
