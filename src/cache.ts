// What Apple Music has already said, kept for a while so switching tabs or
// coming back to a page doesn't re-ask amp-api. A failed fetch is never
// cached — the next look retries — and concurrent asks share one request.

import { hasMore, type Page } from './orchard/client';

interface Entry<T> {
  at: number;
  value: T;
}

const values = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export const TTL = {
  list: 5 * 60_000,
  detail: 5 * 60_000,
  search: 2 * 60_000,
  replay: 60 * 60_000,
};

/** [fetch]'s result for [key], reused for [ttl] ms. */
export async function cached<T>(key: string, ttl: number, fetch: () => Promise<T>): Promise<T> {
  const hit = values.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fetch()
    .then((value) => {
      values.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The cached value for [key] if there is one, fresh or not. */
export function peek<T>(key: string): T | undefined {
  return values.get(key)?.value as T | undefined;
}

/** Forgets [prefix]* — pull-to-refresh, or after an edit. */
export function invalidate(prefix: string) {
  for (const k of [...values.keys()]) if (k.startsWith(prefix)) values.delete(k);
}

export function clearAll() {
  values.clear();
}

/**
 * A list that arrives a page at a time. `loadMore` no-ops while loading or
 * once there is nothing left, and swallows a failure (the visible list stays);
 * `loadAll` drains every page and *throws* — an action that needs the whole
 * list (download all, reorder, sync) must not run on part of it.
 */
export class Paged<T> {
  items: T[] = [];
  cursor: string | undefined;
  loading = false;
  private loaded = false;

  constructor(
    private readonly first: () => Promise<Page<T>>,
    private readonly next: (cursor: string) => Promise<Page<T>>,
  ) {}

  get hasMore() {
    return hasMore({ nextCursor: this.cursor });
  }

  get isLoaded() {
    return this.loaded;
  }

  /** Starts over from the first page. */
  async load(): Promise<T[]> {
    const page = await this.first();
    this.items = page.items;
    this.cursor = page.nextCursor;
    this.loaded = true;
    return this.items;
  }

  /** Seeds from a first page fetched elsewhere (a playlist's own tracks). */
  seed(items: T[], cursor: string | undefined) {
    this.items = items;
    this.cursor = cursor;
    this.loaded = true;
  }

  async loadMore(): Promise<boolean> {
    if (!this.hasMore || this.loading) return false;
    const cursor = this.cursor;
    if (!cursor) return false;
    this.loading = true;
    try {
      const page = await this.next(cursor);
      this.items = [...this.items, ...page.items];
      this.cursor = page.nextCursor;
      return true;
    } catch {
      return false;
    } finally {
      this.loading = false;
    }
  }

  async loadAll(): Promise<T[]> {
    if (!this.loaded) await this.load();
    for (let cursor = this.cursor; cursor; cursor = this.cursor) {
      const page = await this.next(cursor);
      this.items = [...this.items, ...page.items];
      this.cursor = page.nextCursor;
    }
    return this.items;
  }
}

/** One shared Paged per key, kept with the rest of the cache. */
const pagedLists = new Map<string, { at: number; list: Paged<unknown> }>();

export function pagedList<T>(key: string, ttl: number, make: () => Paged<T>): Paged<T> {
  const hit = pagedLists.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.list as Paged<T>;
  const list = make();
  pagedLists.set(key, { at: Date.now(), list: list as Paged<unknown> });
  return list;
}

export function invalidatePaged(prefix: string) {
  for (const k of [...pagedLists.keys()]) if (k.startsWith(prefix)) pagedLists.delete(k);
}
