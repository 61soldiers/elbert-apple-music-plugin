// The user's choice of hours or minutes, shared with Elbert's own statistics
// pages. On an Elbert that has `elbert.stats` the setting lives there (and
// follows changes made on /stats or in Settings); on an older one it is kept
// in this plugin's storage so the toggle still works.

import { isTimeUnit, type TimeUnit } from './time';

const KEY = 'timeUnit';
let current: TimeUnit = 'auto';
const listeners = new Set<(unit: TimeUnit) => void>();

export const timeUnit = (): TimeUnit => current;

/** Whether Elbert shares this setting with its own statistics (and offers Wrapped). */
export const hasHostStats = (): boolean => typeof elbert.stats?.timeUnit === 'function';

const hostStats = () => (hasHostStats() ? elbert.stats : undefined);

function adopt(unit: TimeUnit) {
  if (unit === current) return;
  current = unit;
  for (const fn of listeners) fn(unit);
}

/** Calls [fn] whenever the unit changes; returns the unsubscribe. */
export function onTimeUnitChange(fn: (unit: TimeUnit) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reads the stored unit and starts following the host. Call once on activation. */
export async function initTimeUnit() {
  try {
    const host = hostStats();
    const stored = host ? await host.timeUnit() : await elbert.storage.get<string>(KEY);
    if (isTimeUnit(stored)) current = stored;
  } catch (e) {
    console.debug(`reading the time unit failed: ${e instanceof Error ? e.message : e}`);
  }
  if (hasHostStats()) {
    elbert.on('stats.timeUnit', (e: { unit?: unknown }) => {
      if (isTimeUnit(e?.unit)) adopt(e.unit);
    });
  }
}

export async function setTimeUnit(unit: TimeUnit) {
  adopt(unit);
  try {
    const host = hostStats();
    if (host) await host.setTimeUnit(unit);
    else await elbert.storage.set(KEY, unit);
  } catch (e) {
    console.debug(`saving the time unit failed: ${e instanceof Error ? e.message : e}`);
  }
}
