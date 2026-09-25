import type { CaptureBudgets, PageCapture } from "./types";

/**
 * Runs IN the page: chrome.scripting serializes this function's own source, so
 * it is self-contained by contract — no imports, no module state, no closures
 * (type-only references are erased at build time and therefore fine).
 *
 * Returns the user's selection plus the block it sits in, and the page's main
 * text, both already trimmed to the caller's budgets. Trimming happens in the
 * page so a 400 KB documentation page never crosses the IPC boundary.
 */
export function capturePage(budgets: CaptureBudgets): PageCapture {
  const collapse = (s: string) => s.replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const cut = (s: string, n: number) => {
    if (s.length <= n) return s;
    // Cut on a boundary rather than mid-word; the marker says it was trimmed.
    return s.slice(0, n).replace(/\s+\S{0,40}$/, "").trimEnd() + "\n…[truncated]";
  };
  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean)[0];
    return cls ? `${tag}.${cls}` : tag;
  };
  const textOf = (el: Element): string => collapse((el as HTMLElement).innerText || el.textContent || "");

  const selection = window.getSelection();
  const selectionText = collapse(selection ? selection.toString() : "");

  // The block the selection lives in: nearest ancestor whose text is
  // meaningfully longer than the selection itself (paragraph, list item, table
  // cell, code block). Without it a two-word selection has no sentence around
  // it and "this bit" is unanswerable.
  let selectionContext = "";
  let selectionSource = "";
  if (selectionText && selection && selection.anchorNode) {
    let node: Node | null = selection.anchorNode;
    if (node.nodeType !== 1) node = node.parentElement;
    let el: Element | null = node as Element | null;
    for (let hop = 0; el && hop < 6; hop++) {
      const tag = el.tagName;
      if (tag === "BODY" || tag === "HTML") break;
      const text = textOf(el);
      if (text.length > selectionText.length + 40) {
        selectionContext = cut(text, Math.max(600, budgets.selection));
        selectionSource = describe(el);
        break;
      }
      el = el.parentElement;
    }
  }

  // Main text: the first semantic container holding real content wins, so a
  // docs page yields its article instead of "Skip to content" + nav + footer.
  // body is the last resort, not the default.
  const candidates = [
    "article",
    "main",
    "[role='main']",
    "[role=main]",
    "#content",
    ".markdown-body",
    ".prose",
    ".post",
    ".content",
  ];
  let bestText = "";
  let bestSource = "";
  for (const selector of candidates) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue; // a page can hold markup that makes a selector invalid here
    }
    for (let i = 0; i < nodes.length; i++) {
      const text = textOf(nodes[i]);
      if (text.length > bestText.length) {
        bestText = text;
        bestSource = describe(nodes[i]);
      }
    }
    if (bestText.length >= 1200) break; // good enough — stop widening the net
  }
  if (!bestText) {
    bestText = collapse(document.body ? document.body.innerText || "" : "");
    bestSource = "body";
  }

  return {
    url: location.href,
    title: document.title,
    selection: selectionText,
    selectionContext,
    selectionSource,
    page: cut(bestText, budgets.page),
    pageSource: bestSource,
  };
}

/**
 * Runs IN the page (same self-contained contract as capturePage): reports
 * selection changes to the extension. This is the one thing the capture path
 * can't provide — a push when the selection changes, so the attached context
 * follows the user's reading without polling the page on a timer.
 *
 * Chrome keeps one isolated world per extension per frame, so the flag both
 * survives re-injection and stays invisible to the page's own scripts.
 */
export function watchSelection(): void {
  const flag = "__sonSelectionWatcher";
  const w = window as unknown as Record<string, unknown>;
  if (w[flag]) return;
  w[flag] = true;
  let timer: number | null = null;
  document.addEventListener(
    "selectionchange",
    () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        let text = "";
        try {
          text = (window.getSelection()?.toString() ?? "").trim();
        } catch {
          /* the page navigated out from under us */
        }
        try {
          chrome.runtime.sendMessage({ type: "son:selection", text });
        } catch {
          /* extension reloaded (the world it belonged to is gone) */
        }
      }, 350);
    },
    true,
  );
}
