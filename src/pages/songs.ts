// What a song row's ⋯ menu does, shared by every page that lists songs —
// and the "Add to Apple Music playlist" picker it opens.

import type { LibraryTrack } from '@evolvedmesh/elbert-plugin-sdk';
import type { Paged } from '../cache';
import { libraryPlaylists } from '../data';
import { songJob, startDownload } from '../downloads';
import { formatDuration } from '../format';
import { type LibraryPlaylist, type Song, sizedArtwork } from '../orchard/client';
import { localMatches, playableQueue, playSongs, streamTrack } from '../playback';
import { addTracks, createPlaylist } from '../playlists';
import { definePage, errorText, onClose, type PageData, routes, update } from './common';

/**
 * Runs menu [action] on `songs[index]`. [onDownload] replaces the default
 * single-song download (a page that tracks its own jobs).
 */
export async function songAction(
  songs: Song[],
  index: number,
  action: string,
  opts: { local?: (LibraryTrack | null)[]; onDownload?: (song: Song) => Promise<void> } = {},
) {
  const song = songs[index];
  if (!song) return;
  const local = opts.local?.[index] ?? null;
  switch (action) {
    case 'play':
      return playSongs(songs, index);
    case 'queue': {
      const [entry] = await playableQueue([song]);
      await elbert.player.addToQueue([entry]);
      return elbert.ui.toast(`Added "${song.name}" to queue`, { durationMs: 2000 });
    }
    case 'playlist':
      return addToPlaylist(song);
    case 'artist':
      if (song.artistId) return elbert.ui.navigate(routes.artist(song.artistId));
      return;
    case 'album':
      if (song.albumId) return elbert.ui.navigate(routes.album(song.albumId));
      return;
    case 'lyrics':
      return elbert.ui.showLyrics(streamTrack(song));
    case 'info': {
      const isLocal = local != null || (await localMatches([song]))[0] != null;
      return elbert.ui.showTrackInfo({ icon: 'music-4', rows: trackInfoRows(song, isLocal) });
    }
    case 'download':
    case 'redownload':
      if (opts.onDownload) return opts.onDownload(song);
      try {
        await startDownload(songJob(song, { replaceLocalMatch: true }));
        await elbert.ui.toast(`Downloading "${song.name}"…`, { durationMs: 2000 });
      } catch (e) {
        await elbert.ui.toast(errorText(e));
      }
  }
}

export function trackInfoRows(song: Song, isLocal: boolean): [string, string][] {
  const quality = [
    song.quality.lossless && 'ALAC (lossless)',
    song.quality.hiRes && 'Hi-Res',
    song.quality.atmos && 'Dolby Atmos',
    song.quality.spatial && 'Spatial Audio',
  ].filter(Boolean) as string[];
  const rows: [string, string][] = [
    ['Title', song.name],
    ['Artist', song.artistName],
  ];
  if (song.albumName) rows.push(['Album', song.albumName]);
  if (song.composerName) rows.push(['Composer', song.composerName]);
  if (song.trackNumber > 0) rows.push(['Track #', String(song.trackNumber)]);
  if (song.discNumber > 0) rows.push(['Disc #', String(song.discNumber)]);
  if (song.durationMs > 0) rows.push(['Duration', formatDuration(song.durationMs)]);
  if (song.releaseDate) rows.push(['Released', song.releaseDate]);
  if (song.genres.length) rows.push(['Genre', song.genres.join(', ')]);
  if (song.contentRating) rows.push(['Rating', song.contentRating]);
  if (quality.length) rows.push(['Quality', quality.join(' · ')]);
  rows.push(['Lyrics', song.hasLyrics ? (song.hasTimeSyncedLyrics ? 'Time-synced' : 'Available') : 'None']);
  // The identifier that decides whether this streams or plays from disk.
  if (song.isrc) rows.push(['ISRC', song.isrc]);
  rows.push(['Apple Music ID', song.id], ['Source', 'Apple Music'], ['In your library', isLocal ? 'Yes — plays from disk' : 'No — streams']);
  return rows;
}

// ---- Add to playlist -----------------------------------------------------------------

/** Asks for a name and creates a playlist seeded with [trackIds]. */
export async function createPlaylistWithPrompt(trackIds: string[] = []) {
  const name = await elbert.ui.prompt({ title: 'New Apple Music playlist', hint: 'Playlist name', confirmLabel: 'Create' });
  if (!name?.trim()) return null;
  const result = await createPlaylist(name, trackIds);
  if (result.error) {
    await elbert.ui.toast(result.error);
    return null;
  }
  return result.playlist ?? null;
}

async function addToPlaylist(song: Song) {
  const picked = await elbert.ui.sheet<{ createNew?: boolean; id?: string; name?: string }>({ page: 'playlistPicker', widget: 'common:PlaylistPicker' });
  if (!picked) return;
  if (picked.createNew) {
    const created = await createPlaylistWithPrompt([song.id]);
    if (created) await elbert.ui.toast(`Created "${created.name}" with this song.`);
    return;
  }
  if (!picked.id) return;
  const error = await addTracks(picked.id, [song.id]);
  await elbert.ui.toast(error ?? `Added "${song.name}" to ${picked.name}.`);
}

/** The picker: your editable playlists (Apple refuses writes to the rest). */
definePage<PageData, { list: Paged<LibraryPlaylist> }>('playlistPicker', {
  open(page) {
    const list = libraryPlaylists();
    const show = () => {
      const editable = list.items.filter((p) => p.canEdit);
      update(page, {
        status: editable.length ? 'ready' : list.isLoaded ? 'empty' : 'loading',
        hasMore: list.hasMore,
        items: editable.map((p) => ({
          id: p.id,
          title: p.name,
          subtitle: p.trackCount ? `${p.trackCount}${p.tracksNextCursor ? '+' : ''} songs` : 'Playlist',
          cover: sizedArtwork(p.artwork, 120),
        })),
      });
    };
    page.state.list = list;
    let alive = true;
    onClose(page, () => (alive = false));
    if (!list.isLoaded) {
      list
        .load()
        .then(() => alive && show())
        .catch((e) => alive && update(page, { status: 'error', error: errorText(e) }));
    } else {
      setTimeout(show, 0);
    }
    return { status: 'loading', items: [], hasMore: false };
  },
  events: {
    pick(page, { index }) {
      const editable = page.state.list.items.filter((p) => p.canEdit);
      const p = editable[index];
      if (p) return page.dismiss({ id: p.id, name: p.name });
    },
    create(page) {
      return page.dismiss({ createNew: true });
    },
    async more(page) {
      await page.state.list.loadMore();
      const editable = page.state.list.items.filter((p) => p.canEdit);
      update(page, {
        hasMore: page.state.list.hasMore,
        items: editable.map((p) => ({ id: p.id, title: p.name, subtitle: 'Playlist', cover: sizedArtwork(p.artwork, 120) })),
      });
    },
  },
});
