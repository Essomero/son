/**
 * MV3 service worker: everything that touches tabs and pages.
 *
 * Capture lives here rather than in the panel because the worker outlives the
 * panel — the sidebar closes, an armed selection watcher stays armed — and
 * because chrome.scripting then has exactly one home. The panel asks for a
 * capture over runtime messaging and gets the payload back.
 */

import { capturePage, watchSelection } from "./lib/capture";
import type { CaptureBudgets, CaptureResult, PageCapture } from "./lib/types";

const MENU_ASK = "son-ask-selection";

// Toolbar click opens the side panel (no popup, no new tab).
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ASK,
    title: "Ask Son about the selection",
    contexts: ["selection"],
  });
});

/** Tell every open panel that the page context is worth re-reading. No panel
 *  open = no receiver = a rejection we deliberately ignore. */
function broadcast(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

/** Why chrome.scripting refused to run on this page, in words a user can act
 *  on — a blank chip with "cannot access" tells them nothing. */

/** A page a capture can work with — chrome:// tabs, the PDF viewer, the Web
 *  Store and extension pages themselves are all off-limits to scripting. */
const READABLE_URL = /^https?:\/\//i;

/**
 * The tab a capture should read.
 *
 * Normally the active tab in the focused window. But the panel is not always
 * invisible to that rule: the popped-out floating window IS a window (focusing
 * Son makes it the active tab there), and the panel can be opened as an
 * ordinary tab. Either way the active tab stops being the page the user was
 * reading, and the context would flip to "can't read this page" the moment they
 * look at Son. So when the active tab isn't a web page, fall back to the page
 * the user most recently looked at — computed from the tab list itself rather
 * than remembered state, because a service worker is killed when idle and
 * anything held in a variable is gone by the next wake-up.
 */
async function pickTargetTab(): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id != null && READABLE_URL.test(active.url ?? "")) return active;

  const mostRecentPage = async (windowId?: number): Promise<chrome.tabs.Tab | null> => {
    // Plain query, filtered here rather than with tabs.query's url patterns:
    // the shortcut depends on the host-permission filter path, which behaves
    // differently in a real extension context than in the same page under
    // inspection.
    const tabs = await chrome.tabs.query(windowId != null ? { windowId } : {});
    const pages = tabs.filter((tab) => tab.id != null && READABLE_URL.test(tab.url ?? ""));
    pages.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return pages[0] ?? null;
  };
  // Focused window first (the ordinary case: the panel is a side panel and the
  // page is right there), then any window — the pop-out case, where the focused
  // window holds nothing but Son itself.
  const fallback = (await mostRecentPage(active?.windowId)) ?? (await mostRecentPage());
  // Nothing readable to offer: hand back the active tab so the caller can
  // explain what it is (a chrome:// page, the PDF viewer, the panel itself).
  return fallback ?? active ?? null;
}

/** Why chrome.scripting refused to run on this page, in words a user can act
 *  on — a blank chip with "cannot access" tells them nothing. */
function whyUnreadable(url: string, reason: unknown): string {
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) {
    return "Chrome keeps its own pages closed to extensions.";
  }
  if (/\.pdf([?#]|$)/i.test(url)) {
    return "Chrome's PDF viewer doesn't expose the text to extensions.";
  }
  if (/^file:/i.test(url)) {
    return "Local files need “Allow access to file URLs” on the extension's details page.";
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/cannot access|Cannot access/i.test(message)) {
    return "This page can't be read yet — reload it and try again.";
  }
  return message;
}

async function capture(budgets: CaptureBudgets): Promise<CaptureResult> {
  const tab = await pickTargetTab();
  if (!tab?.id) return { error: "No active tab to read." };
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: capturePage,
      args: [budgets],
    });
    const result = injected?.result as PageCapture | undefined;
    return result ?? { error: "The page returned nothing to read." };
  } catch (reason) {
    return { error: whyUnreadable(tab.url ?? "", reason) };
  }
}

/** Arm the in-page selection watcher. Idempotent: the injected function bails
 *  if the current document already has one. */
async function ensureWatcher(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: watchSelection });
  } catch {
    // Unreadable page — nothing to watch. The panel learns why from its own
    // capture attempt on the same trigger.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = (message as { type?: string } | undefined)?.type;

  if (type === "son:capture") {
    const budgets = (message as { budgets: CaptureBudgets }).budgets;
    void (async () => {
      const tab = await pickTargetTab();
      const result = await capture(budgets);
      if (tab?.id != null) await ensureWatcher(tab.id);
      // The tab id travels with the payload: a capture that raced a tab switch
      // can then be discarded instead of shown as another page's context.
      sendResponse({ ...result, tabId: tab?.id ?? null });
    })();
    return true; // reply is async
  }

  if (type === "son:selection") {
    const from = sender.tab?.id;
    void (async () => {
      const tab = await pickTargetTab();
      // A selection in some other tab must not replace the context of the page
      // the user is actually reading.
      if (from != null && tab?.id === from) broadcast({ type: "son:context-changed", reason: "selection" });
    })();
    return false;
  }

  return false;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ensureWatcher(tabId);
  broadcast({ type: "son:context-changed", reason: "tab" });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  void ensureWatcher(tabId);
  broadcast({ type: "son:context-changed", reason: "navigation" });
});

chrome.windows.onFocusChanged.addListener(() => {
  broadcast({ type: "son:context-changed", reason: "focus" });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ASK) return;
  void (async () => {
    // The panel picks this up and turns it into a spoken-answer question once
    // it is connected; nothing here talks to the server.
    await chrome.storage.session.set({
      "son:ask-selection": { text: (info.selectionText ?? "").trim(), url: tab?.url ?? "", at: Date.now() },
    });
    if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    broadcast({ type: "son:context-changed", reason: "ask-selection" });
  })();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-panel") return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    broadcast({ type: "son:context-changed", reason: "panel" });
  })();
});
