// Editing the account's own Apple Music playlists, and mirroring one into
// Elbert's library.
//
// **Reorder and remove are one operation.** Apple has no "move" or "remove
// one": the client sends the complete list in its new order and Apple replaces
// what it has. So a paginated playlist must be fully loaded before it is
// reordered, or the pages never loaded are dropped from Apple's copy.
//
// Every edit returns a message to show on failure (null on success) rather
// than throwing — an edit Apple refused is something to tell the user, never
// something to crash a button over. Note Apple silently drops a track id it
// can't resolve and still answers 200.

import type { LibraryPlaylist as ElbertPlaylist } from '@evolvedmesh/elbert-plugin-sdk';
import { invalidateLibraryPlaylist, invalidateLibraryPlaylists } from './data';
import { songJob, startDownload, waitForCompletion } from './downloads';
import { type LibraryPlaylist, OrchardError, orchard, type Song } from './orchard/client';
import { localMatches } from './playback';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function attempt(fn: () => Promise<void>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return message(e);
  }
}

export async function createPlaylist(name: string, trackIds: string[] = [], description?: string): Promise<{ playlist?: LibraryPlaylist; error?: string }> {
  try {
    const playlist = await orchard.createLibraryPlaylist(name.trim(), trackIds, description);
    invalidateLibraryPlaylists();
    return { playlist };
  } catch (e) {
    return { error: message(e) };
  }
}

export function renamePlaylist(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return Promise.resolve(null);
  return attempt(async () => {
    await orchard.updateLibraryPlaylist(id, { name: trimmed });
    invalidateLibraryPlaylists();
    invalidateLibraryPlaylist(id);
  });
}

export function addTracks(id: string, trackIds: string[]) {
  if (!trackIds.length) return Promise.resolve(null);
  return attempt(async () => {
    await orchard.addTracksToLibraryPlaylist(id, trackIds);
    invalidateLibraryPlaylist(id);
  });
}

/** Exactly [trackIds], in that order — the whole playlist. */
export function setTracks(id: string, trackIds: string[], allowEmpty = false) {
  if (!trackIds.length && !allowEmpty) return Promise.resolve(null);
  return attempt(async () => {
    await orchard.setLibraryPlaylistTracks(id, trackIds, allowEmpty);
    invalidateLibraryPlaylist(id);
  });
}

export function deletePlaylist(id: string) {
  return attempt(async () => {
    await orchard.deleteLibraryPlaylist(id);
    invalidateLibraryPlaylists();
    invalidateLibraryPlaylist(id);
  });
}

// ---- Sync to library -----------------------------------------------------------------
//
// Match every song against the library; download only what's missing — into
// the first music folder under `Apple Music/`, so the scanner walks it and it
// survives a rescan; then write a real `.m3u` beside them and create-or-update
// the linked library playlist. The `.m3u` is the point: anything else pointed
// at that folder can read it.

export const LIBRARY_SUBFOLDER = 'Apple Music';

export interface SyncResult {
  playlist?: ElbertPlaylist;
  m3uPath?: string;
  alreadyLocal: number;
  downloaded: number;
  missing: number;
  error?: string;
}

const failed = (error: string): SyncResult => ({ alreadyLocal: 0, downloaded: 0, missing: 0, error });

/** [songs] must be the playlist's *complete* list. */
export async function syncToLibrary(libraryPlaylistId: string, name: string, songs: Song[], onProgress?: (message: string) => void): Promise<SyncResult> {
  if (!songs.length) return failed('This playlist has no tracks to sync.');
  const folders = await elbert.library.folders();
  if (!folders.length) {
    return failed('Add a music folder in Settings first — a synced playlist has to live inside your library.');
  }
  // One folder: splitting a playlist's tracks across several would make the
  // .m3u's relative paths useless.
  const root = folders[0];
  const downloadRoot = elbert.fs.join(root, LIBRARY_SUBFOLDER);

  let matches = await localMatches(songs);
  const alreadyLocal = matches.filter(Boolean).length;
  const missing = songs.filter((_, i) => !matches[i]);

  if (missing.length) {
    onProgress?.(`Downloading ${missing.length} missing track${missing.length === 1 ? '' : 's'}…`);
    let done = 0;
    // Each song its own job, three at a time — and this caller *waits*: the
    // .m3u can't be written until the files exist.
    for (let start = 0; start < missing.length; start += 3) {
      const jobIds: string[] = [];
      for (const s of missing.slice(start, start + 3)) {
        try {
          jobIds.push(await startDownload(songJob(s, { destinationRoot: downloadRoot })));
        } catch {
          // A song Apple won't serve ends up in `missing`.
        }
      }
      for (const id of jobIds) {
        await waitForCompletion(id);
        onProgress?.(`Downloaded ${++done} of ${missing.length}…`);
      }
    }
    matches = await localMatches(songs);
  }

  const resolved = matches.filter((t): t is NonNullable<typeof t> & { path: string } => !!t?.path);
  if (!resolved.length) return failed("None of this playlist's tracks could be downloaded.");

  const m3uPath = elbert.fs.join(root, m3uFileNameFor(name));
  try {
    await elbert.fs.writeText(
      m3uPath,
      buildM3u(
        resolved.map((t) => ({ path: t.path, title: t.title, artist: t.artist, durationMs: t.durationMs })),
        root,
      ),
    );
  } catch (e) {
    return failed(`Could not write the playlist file: ${message(e)}`);
  }

  const playlist = await elbert.playlists.upsertLinked({
    remoteId: libraryPlaylistId,
    name,
    trackIds: resolved.map((t) => t.id),
    sourcePath: m3uPath,
  });
  return {
    playlist,
    m3uPath,
    alreadyLocal,
    downloaded: resolved.length - alreadyLocal,
    missing: songs.length - resolved.length,
  };
}

/** Re-syncs a library playlist linked to an Apple Music one; a message to show. */
export async function resync(libraryPlaylistId: string): Promise<string> {
  if (!orchard.isConfigured) return 'Apple Music is not connected.';
  try {
    // The whole playlist: a sync writes the .m3u from exactly what it is given.
    const remote = await orchard.getLibraryPlaylist(libraryPlaylistId);
    const songs = [...remote.tracks];
    let cursor = remote.tracksNextCursor;
    while (cursor) {
      const page = await orchard.getLibraryPlaylistTracks(libraryPlaylistId, cursor);
      songs.push(...page.items);
      cursor = page.nextCursor;
    }
    return syncMessage(remote.name, await syncToLibrary(libraryPlaylistId, remote.name, songs));
  } catch (e) {
    return e instanceof OrchardError ? e.message : message(e);
  }
}

export function syncMessage(name: string, r: SyncResult): string {
  if (r.error) return r.error;
  return `Synced "${name}": ${r.downloaded} downloaded, ${r.alreadyLocal} already in your library${r.missing > 0 ? `, ${r.missing} unavailable` : ''}.`;
}

// ---- .m3u ------------------------------------------------------------------------------

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Extended M3U, paths relative to the playlist's folder when inside it (so
 * moving the library doesn't break it) and always `/`-separated.
 */
export function buildM3u(entries: { path: string; title: string; artist: string; durationMs: number }[], playlistDir: string): string {
  const dir = norm(playlistDir);
  const lines = ['#EXTM3U'];
  for (const e of entries) {
    const seconds = e.durationMs > 0 ? Math.round(e.durationMs / 1000) : -1;
    const label = e.artist.trim() ? `${e.artist.trim()} - ${e.title.trim()}` : e.title.trim();
    lines.push(`#EXTINF:${seconds},${label}`);
    const file = norm(e.path);
    lines.push(file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file);
  }
  return `${lines.join('\n')}\n`;
}

export function m3uFileNameFor(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cleaned || 'Playlist'}.m3u`;
}
