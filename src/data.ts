// Every Apple Music fetch the pages make, cached (see cache.ts). Mirrors what
// used to be Elbert's apple_music_provider.dart, one function per provider.

import { cached, invalidate, invalidatePaged, Paged, pagedList, TTL } from './cache';
import { type Album, type Artist, type LibraryPlaylist, orchard, type Song, type Summary } from './orchard/client';

/** Home's Recently Played shelf. */
const RECENT_LIMIT = 20;

export const recommendations = () => cached('recs', TTL.home, () => orchard.getRecommendations());
export const recentlyPlayed = () => cached('recent', TTL.list, () => orchard.getRecentlyPlayed(RECENT_LIMIT));
export const pins = () => cached('pins', TTL.list, () => orchard.getPins());

export const playlist = (id: string) => cached(`playlist:${id}`, TTL.detail, () => orchard.getPlaylist(id));
export const album = (id: string) => cached(`album:${id}`, TTL.detail, () => orchard.getAlbum(id));
export const song = (id: string) => cached(`song:${id}`, TTL.detail, () => orchard.getSong(id));
export const artist = (id: string) => cached(`artist:${id}`, TTL.detail, () => orchard.getArtist(id));
export const libraryPlaylist = (id: string) => cached(`libplaylist:${id}`, TTL.detail, () => orchard.getLibraryPlaylist(id));

export function search(term: string) {
  const t = term.trim();
  if (t.length < 2) return Promise.resolve({ songs: [], albums: [], artists: [], playlists: [] });
  return cached(`search:${t.toLowerCase()}`, TTL.search, () => orchard.search(t));
}

export const replayYears = () => cached('replay:index', TTL.replay, () => orchard.getSummaries());
export const replayMonths = (year: number) => cached(`replay:months:${year}`, TTL.replay, async () => (await orchard.getSummaries(year)).summaries);
export const replay = (id: string): Promise<Summary> => cached(`replay:${id}`, TTL.replay, () => orchard.getSummary(id));

// ---- Paged lists ---------------------------------------------------------------

const RECENTLY_ADDED_PAGE = 30;

export const libraryPlaylists = () =>
  pagedList<LibraryPlaylist>(
    'lib:playlists',
    TTL.list,
    () =>
      new Paged(
        () => orchard.getLibraryPlaylists(),
        (c) => orchard.getLibraryPlaylists(c),
      ),
  );
export const librarySongs = () =>
  pagedList<Song>(
    'lib:songs',
    TTL.list,
    () =>
      new Paged(
        () => orchard.getLibrarySongs(),
        (c) => orchard.getLibrarySongs(c),
      ),
  );
export const libraryAlbums = () =>
  pagedList<Album>(
    'lib:albums',
    TTL.list,
    () =>
      new Paged(
        () => orchard.getLibraryAlbums(),
        (c) => orchard.getLibraryAlbums({ cursor: c }),
      ),
  );
export const libraryArtists = () =>
  pagedList<Artist>(
    'lib:artists',
    TTL.list,
    () =>
      new Paged(
        () => orchard.getLibraryArtists(),
        (c) => orchard.getLibraryArtists(c),
      ),
  );
/**
 * Newest first, 30 a page. `limit` goes on every request, cursor ones
 * included — Apple drops it from its `next` links.
 */
export const recentlyAdded = () =>
  pagedList<Album>(
    'lib:recent',
    TTL.list,
    () =>
      new Paged(
        () => orchard.getLibraryAlbums({ recent: true, limit: RECENTLY_ADDED_PAGE }),
        (c) => orchard.getLibraryAlbums({ cursor: c, recent: true, limit: RECENTLY_ADDED_PAGE }),
      ),
  );

/** A catalog playlist's tracks, seeded from the playlist's own first page. */
export async function playlistTracks(id: string): Promise<Paged<Song>> {
  const list = pagedList<Song>(
    `tracks:${id}`,
    TTL.detail,
    () =>
      new Paged(
        async () => {
          const p = await playlist(id);
          return { items: p.tracks, nextCursor: p.tracksNextCursor };
        },
        (c) => orchard.getPlaylistTracks(id, c),
      ),
  );
  if (!list.isLoaded) await list.load();
  return list;
}

export async function libraryPlaylistTracks(id: string): Promise<Paged<Song>> {
  const list = pagedList<Song>(
    `libtracks:${id}`,
    TTL.detail,
    () =>
      new Paged(
        async () => {
          const p = await libraryPlaylist(id);
          return { items: p.tracks, nextCursor: p.tracksNextCursor };
        },
        (c) => orchard.getLibraryPlaylistTracks(id, c),
      ),
  );
  if (!list.isLoaded) await list.load();
  return list;
}

/**
 * The account's own library playlist behind a catalog id, or null. A catalog
 * page can't tell on its own whether a playlist is yours; every write route
 * needs the library id (`p.*`). Bounded at 50 pages (5,000 playlists).
 */
export const ownedPlaylist = (catalogId: string) =>
  cached(`owned:${catalogId}`, TTL.list, async (): Promise<LibraryPlaylist | null> => {
    if (!catalogId) return null;
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await orchard.getLibraryPlaylists(cursor);
      const hit = result.items.find((p) => p.catalogId === catalogId);
      if (hit) return hit;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return null;
  });

// ---- Invalidation ---------------------------------------------------------------

export function invalidateLibraryPlaylists() {
  invalidatePaged('lib:playlists');
  invalidate('owned:');
  invalidate('pins');
}

export function invalidateLibraryPlaylist(id: string) {
  invalidate(`libplaylist:${id}`);
  invalidatePaged(`libtracks:${id}`);
}
