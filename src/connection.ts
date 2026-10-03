// Where the Orchard server is, whether Elbert runs it, and what Apple says
// about the session.
//
// Settings keep the names Elbert's own settings.json used before Apple Music
// became a plugin (the manifest's `migrate.settingsKeys` carries them over),
// and the API key keeps its secure-storage name (`migrate.secureKeys`), so an
// existing setup simply carries on.

import { clearAll, invalidatePaged } from './cache';
import { errorText } from './errors';
import { type AppleStatus, OrchardError, orchard } from './orchard/client';
import { managed } from './orchard/managed';

const KEY_SECRET = 'orchard_api_key';

export interface Settings {
  orchardEnabled: boolean;
  orchardServerUrl: string;
  orchardManaged: boolean;
  orchardPlayHistoryEnabled: boolean;
}

export const settings: Settings = {
  orchardEnabled: false,
  orchardServerUrl: '',
  orchardManaged: false,
  orchardPlayHistoryEnabled: true,
};

const listeners = new Set<() => void>();

/** Called on any change to settings, the connection or the session. */
export function onConnectionChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error('connection listener failed', e);
    }
  }
}

export async function loadSettings() {
  const all = await elbert.storage.all();
  if (typeof all.orchardEnabled === 'boolean') settings.orchardEnabled = all.orchardEnabled;
  if (typeof all.orchardServerUrl === 'string') settings.orchardServerUrl = all.orchardServerUrl;
  if (typeof all.orchardManaged === 'boolean') settings.orchardManaged = all.orchardManaged;
  if (typeof all.orchardPlayHistoryEnabled === 'boolean') settings.orchardPlayHistoryEnabled = all.orchardPlayHistoryEnabled;
}

async function save<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  await elbert.storage.set(key, value);
  notify();
}

/** Points the client at the saved server, when there is one. */
export async function applyConfig() {
  const key = await elbert.secrets.get(KEY_SECRET);
  if (settings.orchardEnabled && settings.orchardServerUrl && key) {
    orchard.configure(settings.orchardServerUrl, key);
  } else {
    orchard.clearConfig();
  }
  resetStatus();
  notify();
}

/** Connects to a server the user runs. Throws (with Orchard's message) when it can't. */
export async function connectRemote(url: string, apiKey: string) {
  orchard.configure(url, apiKey);
  const ping = await orchard.ping();
  if (!ping.success) {
    await applyConfig();
    throw new OrchardError('unreachable', ping.error ?? 'Could not reach that Orchard server.');
  }
  await elbert.secrets.set(KEY_SECRET, apiKey);
  settings.orchardManaged = false;
  settings.orchardServerUrl = orchard.url ?? url;
  settings.orchardEnabled = true;
  await elbert.storage.set('orchardManaged', false);
  await elbert.storage.set('orchardServerUrl', settings.orchardServerUrl);
  await elbert.storage.set('orchardEnabled', true);
  clearAll();
  invalidatePaged('');
  resetStatus();
  notify();
}

/** Starts (building on first run) the server Elbert runs itself. */
export async function useManaged() {
  await save('orchardManaged', true);
  await managed.ensureRunning();
}

/** Forgets the server. The managed container, if any, is stopped but kept. */
export async function disconnect() {
  if (settings.orchardManaged && (await managed.isSupported())) await managed.stop();
  await elbert.secrets.remove(KEY_SECRET);
  settings.orchardEnabled = false;
  settings.orchardManaged = false;
  settings.orchardServerUrl = '';
  await elbert.storage.set('orchardEnabled', false);
  await elbert.storage.set('orchardManaged', false);
  await elbert.storage.set('orchardServerUrl', '');
  orchard.clearConfig();
  clearAll();
  invalidatePaged('');
  resetStatus();
  notify();
}

/** The settings page's master switch. Off keeps the key, so on again just works. */
export async function setEnabled(on: boolean) {
  await save('orchardEnabled', on);
  if (!on && settings.orchardManaged && (await managed.isSupported())) await managed.stop();
  await applyConfig();
  if (on && settings.orchardManaged && (await managed.isSupported())) void managed.ensureRunning();
}

/** Run-it-for-me versus a server of the user's own. */
export async function setManaged(on: boolean) {
  await save('orchardManaged', on);
  if (on && settings.orchardEnabled && (await managed.isSupported())) {
    void managed.ensureRunning();
  } else {
    if (!on && (await managed.isSupported()) && managed.phase === 'healthy') await managed.stop();
    await applyConfig();
  }
}

/** Saves a remote server's address and key; with [test], pings it too. */
export async function saveRemote(url: string, apiKey: string, test = false): Promise<{ success: boolean; error?: string } | null> {
  const u = url.trim();
  const k = apiKey.trim();
  if (k) await elbert.secrets.set(KEY_SECRET, k);
  else await elbert.secrets.remove(KEY_SECRET);
  settings.orchardServerUrl = u;
  settings.orchardEnabled = !!u && !!k;
  await elbert.storage.set('orchardServerUrl', u);
  await elbert.storage.set('orchardEnabled', settings.orchardEnabled);
  clearAll();
  invalidatePaged('');
  await applyConfig();
  if (!test) return null;
  return orchard.isConfigured ? orchard.ping() : { success: false, error: 'Fill in the server URL and API key.' };
}

export const storedApiKey = () => elbert.secrets.get(KEY_SECRET);

export async function setPlayHistoryEnabled(on: boolean) {
  await save('orchardPlayHistoryEnabled', on);
}

/**
 * Once the managed server is healthy, its key and address become the
 * configuration — the same thing connecting to a remote one does.
 */
let appliedManagedKey = '';
managed.onChange(() => {
  notify();
  if (managed.phase !== 'healthy' || !managed.apiKey || managed.apiKey === appliedManagedKey) return;
  const key = managed.apiKey;
  appliedManagedKey = key;
  void (async () => {
    await elbert.secrets.set(KEY_SECRET, key);
    orchard.configure(managed.serverUrl, key);
    settings.orchardServerUrl = managed.serverUrl;
    settings.orchardEnabled = true;
    await elbert.storage.set('orchardServerUrl', managed.serverUrl);
    await elbert.storage.set('orchardEnabled', true);
    resetStatus();
    notify();
  })();
});

// ---- Session status ---------------------------------------------------------------

export const UNCONFIGURED: AppleStatus = { state: 'unconfigured', subscribed: false, wrapper: { state: 'absent' } };

export let status: AppleStatus | null = null;
let statusError: string | null = null;
let polling: number | null = null;
let pollers = 0;
let recoveryAttempted = false;

export function lastStatusError() {
  return statusError;
}

function resetStatus() {
  status = null;
  statusError = null;
  recoveryAttempted = false;
  if (pollers > 0) void poll();
}

async function fetchStatus(): Promise<AppleStatus> {
  try {
    return await orchard.getStatus();
  } catch (e) {
    return { ...UNCONFIGURED, state: 'failed', error: errorText(e) };
  }
}

async function poll() {
  if (!orchard.isConfigured) {
    status = UNCONFIGURED;
    notify();
    return;
  }
  let next = await fetchStatus();
  // A `failed` session usually means the daemon inside the container died
  // while the container stayed up; the Apple session itself is still good.
  // One quiet restart of a managed server fixes that before it is ever shown.
  if (next.state === 'failed' && !recoveryAttempted) {
    recoveryAttempted = true;
    if (settings.orchardManaged && (await managed.isSupported())) {
      await managed.restart();
      if (managed.isHealthy) next = await fetchStatus();
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(status);
  status = next;
  statusError = next.state === 'failed' ? (next.error ?? null) : null;
  if (changed) notify();
}

/**
 * Polls the session every 4 s while something wants it (the section's pages,
 * the settings page) and stops when nothing does. Returns the release.
 */
export function watchStatus(): () => void {
  pollers++;
  if (polling == null) {
    void poll();
    polling = setInterval(() => void poll(), 4000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pollers--;
    if (pollers <= 0 && polling != null) {
      clearInterval(polling);
      polling = null;
      pollers = 0;
    }
  };
}

export async function refreshStatus() {
  await poll();
  return status;
}

export const isReady = () => orchard.isConfigured && status?.state === 'ready';

/** On activation: settings, the client, and the managed server if it is ours. */
export async function startConnection() {
  await loadSettings();
  await applyConfig();
  if (settings.orchardEnabled && settings.orchardManaged && (await managed.isSupported())) {
    void managed.ensureRunning();
  }
}
