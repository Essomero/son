/**
 * Clipboard helpers.
 *
 * Writes have two paths: the async clipboard API when the context is secure
 * (localhost, https, the packaged app's own origin) and a hidden textarea +
 * `execCommand("copy")` when it isn't — the app is also served over plain http
 * on a LAN, where `navigator.clipboard` doesn't exist at all.
 *
 * Reads have no fallback: `execCommand` can paste nothing, and the async API
 * needs the `clipboard-read` permission and a user gesture. So a read that is
 * refused returns `null`, distinct from `""` (an empty clipboard), because the
 * two deserve different words in the UI.
 */

/** Bound a clipboard call. Chrome can leave `writeText`/`readText` pending
 *  indefinitely — an unfocused document, a permission prompt nobody answers —
 *  and a promise that never settles makes a button that never reacts. */
function withDeadline<T>(work: Promise<T> | undefined, ms: number): Promise<T | null> {
  if (!work) return Promise.resolve(null);
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

/** Copy `text`. False only when both paths failed. */
export async function copyText(text: string): Promise<boolean> {
  // writeText resolves `undefined` on success, so `null` alone means "didn't".
  const wrote = await withDeadline(navigator.clipboard?.writeText(text), 2500);
  if (wrote !== null) return true;
  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand("copy");
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The clipboard's text: `""` when empty, `null` when refused or unavailable. */
export async function readClipboard(): Promise<string | null> {
  return await withDeadline(navigator.clipboard?.readText?.(), 2500);
}
