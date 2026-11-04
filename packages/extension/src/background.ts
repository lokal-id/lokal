// Service worker: the only place that masks. Each site has its own vault, so [NIK_1] means the same person in every
// tab of that site, and a value typed into one site is never shown, restored, or copied on another. The vaults live
// in storage.session, which stays in memory and is gone when the browser closes; they are never written to disk or
// sent anywhere. Messages to the tabs only say that a vault changed: each tab asks for its own site's vault.
import { Samaran } from '../../core/src/samaran/index.ts';
import type { MaskResponse, Request, Stats } from './shared.ts';
import { siteOf } from './shared.ts';

let vaults: Map<string, Samaran> | undefined;
let masked = 0;
// One request at a time, so two tabs masking at once cannot hand out the same placeholder twice.
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Map<string, Samaran>> {
  if (vaults) return vaults;
  const fresh = new Map<string, Samaran>();
  const { vaults: stored, masked: count } = await chrome.storage.session.get(['vaults', 'masked']);
  if (stored && typeof stored === 'object') {
    for (const [site, entries] of Object.entries(stored as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      const s = new Samaran();
      s.importVault(entries as Array<[string, string]>);
      fresh.set(site, s);
    }
  }
  masked = typeof count === 'number' ? count : 0;
  vaults = fresh;
  return fresh;
}

function vaultOf(all: Map<string, Samaran>, site: string): Samaran {
  let s = all.get(site);
  if (!s) all.set(site, (s = new Samaran()));
  return s;
}

async function save(all: Map<string, Samaran>): Promise<void> {
  const stored: Record<string, Array<[string, string]>> = {};
  for (const [site, s] of all) if (s.size) stored[site] = s.exportVault();
  await chrome.storage.session.set({ vaults: stored, masked });
}

async function changed(site: string | undefined): Promise<void> {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: 'vault-changed', site }).catch(() => {});
  }
}

/**
 * Which site's vault a request may use. A content script gets its own page's site and nothing else, whatever the
 * request says; only the extension's own popup may name a site (the tab it was opened on).
 */
function siteFor(request: Request, sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.tab) return siteOf(sender.origin ?? sender.url ?? sender.tab.url ?? '');
  const own = `chrome-extension://${chrome.runtime.id}`;
  if ((sender.origin ?? sender.url ?? '').startsWith(own) && 'site' in request && typeof request.site === 'string') {
    return siteOf(request.site);
  }
  return undefined;
}

async function handle(request: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const all = await load();
  const site = siteFor(request, sender);
  switch (request.type) {
    case 'mask': {
      if (!site || !sender.tab) throw new Error('Masking is only for the chat sites.');
      const s = vaultOf(all, site);
      const { text, matches } = s.mask(String(request.text));
      const vault = s.exportVault();
      if (matches.length) {
        masked += matches.length;
        await save(all);
        await chrome.action.setBadgeBackgroundColor({ color: '#E5262E' });
        await chrome.action.setBadgeText({ text: masked > 999 ? '999+' : String(masked) });
        void changed(site);
      }
      return { text, types: matches.map((m) => m.type), vault } satisfies MaskResponse;
    }
    case 'vault':
      return site ? (all.get(site)?.exportVault() ?? []) : [];
    case 'stats': {
      const known = site ? (all.get(site)?.size ?? 0) : [...all.values()].reduce((n, s) => n + s.size, 0);
      return { masked, known } satisfies Stats;
    }
    case 'clear':
      // From the popup only: a page cannot make the extension forget, or start over, behind the user's back.
      if (sender.tab) throw new Error('Only the popup clears the vault.');
      vaults = new Map();
      masked = 0;
      await chrome.storage.session.clear();
      await chrome.action.setBadgeText({ text: '' });
      void changed(undefined);
      return true;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages and content scripts can reach the vaults.
  if (sender.id !== chrome.runtime.id) return false;
  const next = queue.then(() => handle(message as Request, sender));
  queue = next.catch(() => {});
  next.then(sendResponse, (e: Error) => sendResponse({ error: e.message }));
  return true;
});
