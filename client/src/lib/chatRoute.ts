/**
 * Chat URL routing: /s/<session_id> is the "this conversation is open" path.
 * Reloading (or opening a shared link) lands back in the same chat instead
 * of home. Path-based, not hash: son.py serves the app shell for /s/<id>
 * (client/src App.tsx restores the session on mount), and Vite's SPA
 * fallback does the same during dev.
 */

export const SESSION_ROUTE = "/s/";

/** The session id in a pathname, or null when the path is home. */
export function sessionIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(SESSION_ROUTE)) return null;
  return pathname.slice(SESSION_ROUTE.length) || null;
}

/** Point the URL at an open chat — no-op when it's already that chat. */
export function pushSessionRoute(id: string) {
  const target = SESSION_ROUTE + id;
  if (location.pathname !== target) history.pushState(null, "", target);
}

/** Point the URL home. */
export function pushHomeRoute() {
  if (location.pathname !== "/") history.pushState(null, "", "/");
}
