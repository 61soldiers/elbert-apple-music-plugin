// What every Apple Music page shares: the section's tabs, card shapes,
// navigation to an item, and cleanup when a page closes.

import type { Page, PageController } from '@evolvedmesh/elbert-plugin-sdk';
import { playStation } from '../activity';
import { activeCount, onDownloadsChange } from '../downloads';
import { errorCode, errorText } from '../errors';
import { formatDuration } from '../format';
import {
  type Album,
  type Artist,
  bestArtwork,
  type Item,
  itemSubtitle,
  type LibraryPlaylist,
  type Pin,
  type Playlist,
  type Song,
  sizedArtwork,
} from '../orchard/client';
import { SECTION } from '../playback';

export { SECTION };

/** Rail artwork: Apple sizes it for us, ~24 KB at 400 px against ~41 KB for the largest. */
export const RAIL_PX = 400;

// ---- Page lifetime ------------------------------------------------------------------

const cleanups = new WeakMap<object, (() => void)[]>();

/** Runs [fn] when [page] closes. */
export function onClose<D extends object, S extends object>(page: Page<D, S>, fn: () => void) {
  const list = cleanups.get(page) ?? [];
  list.push(fn);
  cleanups.set(page, list);
}

/** `elbert.ui.page`, plus the cleanups registered with [onClose]. */
export function definePage<D extends object, S extends object>(name: string, c: PageController<D, S>) {
  elbert.ui.page<D, S>(name, {
    ...c,
    async close(page) {
      for (const fn of cleanups.get(page) ?? []) {
        try {
          fn();
        } catch (e) {
          console.error(`cleanup of ${name} failed`, e);
        }
      }
      cleanups.delete(page);
      await c.close?.(page);
    },
  });
}

/** `page.set` that does nothing once the page has gone. */
export function update<D extends object, S extends object>(page: Page<D, S>, patch: Partial<D>) {
  if (!page.closed) page.set(patch);
}

export { errorText };

/** What a page's template sees as `data.*`: plain JSON-shaped values. */
export type PageData = Record<string, unknown>;

// ---- Section chrome -------------------------------------------------------------------

export function tabs() {
  const downloads = activeCount();
  return [
    { label: 'Home', icon: 'house', route: SECTION },
    { label: 'Search', icon: 'search', route: `${SECTION}/search` },
    { label: 'Library', icon: 'library', route: `${SECTION}/library` },
    { label: 'Replay', icon: 'chart-no-axes-column', route: `${SECTION}/replay` },
    { label: 'Downloads', icon: 'folder-down', route: `${SECTION}/downloads`, badge: downloads },
  ];
}

/** The tabs for a section page, kept current (the Downloads badge) while it is open. */
export function sectionChrome<D extends object, S extends object>(page: Page<D, S>, current: string) {
  onClose(
    page,
    onDownloadsChange(() => update(page as Page<PageData, S>, { tabs: tabs() })),
  );
  return { tabs: tabs(), current };
}

// ---- Cards ----------------------------------------------------------------------------

export interface Card {
  id: string;
  title: string;
  subtitle: string;
  cover?: string;
  placeholderIcon?: string;
}

export const itemCard = (i: Item, px = RAIL_PX): Card => ({
  id: i.id,
  title: i.name,
  subtitle: i.type === 'stations' ? itemSubtitle(i) || 'Station' : itemSubtitle(i),
  cover: sizedArtwork(i.artwork, px),
  placeholderIcon: i.type === 'stations' ? 'radio' : 'music',
});

export const albumCard = (a: Album, px = RAIL_PX): Card => ({
  id: a.id,
  title: a.name,
  subtitle: a.artistName,
  cover: sizedArtwork(a.artwork, px),
  placeholderIcon: 'disc-3',
});
export const playlistCard = (p: Playlist | LibraryPlaylist, px = RAIL_PX): Card => ({
  id: p.id,
  title: p.name,
  subtitle: 'curatorName' in p ? (p.curatorName ?? 'Playlist') : 'Playlist',
  cover: sizedArtwork(p.artwork, px),
  placeholderIcon: 'list-music',
});
export const artistCard = (a: Artist, px = RAIL_PX): Card => ({
  id: a.id,
  title: a.name,
  subtitle: 'Artist',
  cover: sizedArtwork(a.artwork, px),
  placeholderIcon: 'mic-vocal',
});
export const pinCard = (p: Pin): Card => ({
  id: p.id,
  title: p.name,
  subtitle: p.artistName ?? p.curatorName ?? '',
  cover: sizedArtwork(p.artwork, RAIL_PX),
  placeholderIcon: 'pin',
});

/**
 * A track row for `TrackList`. [localId] is the library track a song plays as
 * when there is a local copy, so the now-playing indicator finds it either way.
 */
export function songRow(
  s: Song,
  opts: {
    localId?: string | null;
    status?: 'working' | 'failed' | 'saved' | 'none';
    showCover?: boolean;
    menu?: { id: string; label: string; icon?: string; divider?: boolean }[];
  } = {},
) {
  return {
    id: s.id,
    title: s.name,
    artist: s.artistName,
    duration: formatDuration(s.durationMs),
    cover: opts.showCover === false ? undefined : sizedArtwork(s.artwork, 120),
    localId: opts.localId ?? undefined,
    badge: s.quality.lossless ? 'ALAC' : undefined,
    status: opts.status ?? (opts.localId ? 'saved' : 'none'),
    artistLink: !!s.artistId,
    matchIds: [`applemusic-stream:${s.id}`, ...(opts.localId ? [opts.localId] : [])],
    menu: opts.menu ?? songMenu(s, !!opts.localId),
  };
}

/** The ⋯ menu every Apple Music song row carries. */
export function songMenu(s: Song, inLibrary: boolean) {
  return [
    { id: 'play', label: 'Play', icon: 'play' },
    { id: 'queue', label: 'Add to queue', icon: 'list-plus' },
    { id: 'playlist', label: 'Add to playlist', icon: 'list-music' },
    { id: '-1', label: '', divider: true },
    ...(s.artistId ? [{ id: 'artist', label: 'Go to artist', icon: 'user' }] : []),
    ...(s.albumId ? [{ id: 'album', label: 'Go to album', icon: 'disc' }] : []),
    ...(s.hasLyrics ? [{ id: 'lyrics', label: 'View lyrics', icon: 'mic-vocal' }] : []),
    { id: '-2', label: '', divider: true },
    { id: 'download', label: inLibrary ? 'Download again' : 'Download', icon: 'download' },
    { id: '-3', label: '', divider: true },
    { id: 'info', label: 'Track info', icon: 'info' },
  ];
}

export const heroArtwork = bestArtwork;

// ---- Navigation -----------------------------------------------------------------------

const enc = encodeURIComponent;

export const routes = {
  playlist: (id: string) => `${SECTION}/playlists/${enc(id)}`,
  album: (id: string) => `${SECTION}/albums/${enc(id)}`,
  song: (id: string) => `${SECTION}/songs/${enc(id)}`,
  artist: (id: string) => `${SECTION}/artists/${enc(id)}`,
  libraryPlaylist: (id: string) => `${SECTION}/library/playlists/${enc(id)}`,
  replay: (id: string) => `${SECTION}/replay/${enc(id)}`,
};

/** Opens a card: a page for most things; a station *plays*, having no list to show. */
export async function openItem(item: { id: string; type: string; name: string }) {
  switch (item.type) {
    case 'playlists':
      return elbert.ui.navigate(routes.playlist(item.id));
    case 'albums':
      return elbert.ui.navigate(routes.album(item.id));
    case 'songs':
      return elbert.ui.navigate(routes.song(item.id));
    case 'artists':
      return elbert.ui.navigate(routes.artist(item.id));
    case 'stations':
      return startStation(item.id, item.name);
  }
}

export async function startStation(id: string, name: string) {
  await elbert.ui.toast(`Starting "${name}"…`, { durationMs: 2000 });
  try {
    await playStation(id);
  } catch (e) {
    await elbert.ui.toast(
      errorCode(e) === 'station_not_playable' ? `"${name}" is one of Apple's live radio channels, which has no track list to play from.` : errorText(e),
    );
  }
}

/** A pin with a catalog id opens the catalog page; a personal playlist opens by library id. */
export async function openPin(pin: Pin) {
  if (!pin.catalogId) {
    const libraryId = pin.libraryId ?? pin.id;
    if (pin.type === 'playlists' && libraryId) await elbert.ui.navigate(routes.libraryPlaylist(libraryId));
    return;
  }
  await openItem({ id: pin.catalogId, type: pin.type, name: pin.name });
}

/**
 * Where a library playlist opens. Turns on **canEdit**, not on having a
 * catalog id: Apple gives a shareable catalog id to playlists of your own too,
 * and only the library page can edit one.
 */
export function libraryPlaylistRoute(p: LibraryPlaylist) {
  return !p.canEdit && p.catalogId ? routes.playlist(p.catalogId) : routes.libraryPlaylist(p.id);
}
