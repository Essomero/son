/**
 * Markdown → speech-friendly text for the read-out page.
 *
 * The textarea keeps the raw paste; when the Clean toggle is on, Speak sends
 * this stripped version instead. Everything here only removes or
 * de-emphasizes — never rewrites words — so the result reads naturally
 * aloud. Order matters: code and math go first (their contents would
 * otherwise be mangled by the later emphasis/link passes).
 */
export function cleanText(raw: string): string {
  let t = raw.replace(/\r\n?/g, "\n");

  // Fenced code blocks (``` or ~~~) — unreadable aloud, dropped whole.
  t = t.replace(/```[^\n`]*\n[\s\S]*?```/g, "\n");
  t = t.replace(/~~~[^\n~]*\n[\s\S]*?~~~/g, "\n");
  // Indented code blocks: consecutive 4-space lines. (Requires two+ lines so
  // a lone indented line — usually a nested list item — survives.)
  t = t.replace(/^(?: {4}|\t).*\n(?:(?: {4}|\t).*\n?)+/gm, "");

  // Block math ($$…$$, \[…\]) and LaTeX delimiters — equations don't read.
  t = t.replace(/\$\$[\s\S]*?\$\$/g, "\n");
  t = t.replace(/\\\[[\s\S]*?\\\]/g, "\n");
  t = t.replace(/\\\([^)\n]*\\\)/g, "");

  // Inline math $…$: strip the whole span. A pasted article's dollar pairs
  // are equations, not prices — the operator sniff let $\alpha$, $Q \sim X$
  // and long equations through as literal "dollar … dollar". A lone $ (no
  // second $ to pair with) survives only as a price prefix: $5, $10.50.
  t = t.replace(/\$[^$\n]*\$/g, "");
  t = t.replace(/\$(?!\d)/g, "");

  // Images dropped, links keep their text, autolinks dropped.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/<https?:\/\/[^>\s]+>/gi, "");

  // Inline code: backticks stripped, the word stays (it's usually a term).
  t = t.replace(/`([^`\n]+)`/g, "$1");

  // Headings: strip the # run, keep the heading as prose.
  t = t.replace(/^#{1,6}\s+/gm, "");

  // Lists: strip bullets and ordered markers, keep the item text.
  t = t.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "");

  // Blockquotes: strip the > marker, keep the quote.
  t = t.replace(/^>\s?/gm, "");

  // Horizontal rules.
  t = t.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");

  // Tables: consecutive |-delimited rows — cell text is meaningless aloud.
  t = t.replace(/^\|.*(?:\n\|.*)*$/gm, "");

  // Emphasis, bold and strikethrough: strip markers, keep the words. Looped
  // so nested spans (**bold _italic_**) collapse fully.
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(/(\*\*\*|___)([^*_]+)\1/g, "$2");
    t = t.replace(/(\*\*|__)([^*_]+)\1/g, "$2");
    t = t.replace(/(\*|_)([^*_]+)\1/g, "$2");
    if (t === before) break;
  }

  // Escapes: stray backslashes (from \(…\), \*, …) are just noise aloud.
  t = t.replace(/\\/g, "");

  // Whitespace: trim line ends, collapse 3+ blank lines to one so paragraphs
  // keep their pause, and tidy the edges.
  t = t.replace(/[ \t]+$/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
