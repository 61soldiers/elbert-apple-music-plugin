// One catalog playlist, album or song: the sticky header, Download all /
// Downloads / Artist, editorial notes, and the tracks as SongCard rows with
// their download status.
//
// A catalog playlist page can't tell on its own whether the playlist is
// yours — Apple gives a shareable catalog id to playlists of your own too —
// so it asks (`ownedPlaylist`) and shows the edit actions only on a match.
// Showing actions that would 403 is worse than showing none.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { type PlayContext, rememberContext } from '../activity';
import type { Paged } from '../cache';
import { album, ownedPlaylist, playlist, playlistTracks, song } from '../data';
import { formatDuration, formatReadableDuration } from '../format';
import { stripHtml } from '../html';
import { bestArtwork, type LibraryPlaylist, type Song } from '../orchard/client';
import { playSongs } from '../playback';
import { definePage, errorText, type PageData, routes, SECTION, update } from './common';
import { playlistActions, runPlaylistAction } from './playlist_actions';
import { SongList } from './tracks';

type Kind = 'playlist' | 'album' | 'song';

interface Detail {
  title: string;
  subtitle?: string;
  releaseDate?: string;
  cover?: string;
  artistId?: string;
  recordLabel?: string;
  copyright?: string;
  notes?: string;
}

interface State {
  kind: Kind;
  id: string;
  detail: Detail;
  list: SongList;
  /** A playlist's tracks arrive a page at a time. */
  paged: Paged<Song> | null;
  owned: LibraryPlaylist | null;
  ownedBusy: boolean;
}

type P = Page<PageData, State>;

const TYPE_LABEL: Record<Kind, string> = { playlist: 'PLAYLIST', album: 'ALBUM', song: 'SONG' };

function info(s: State) {
  const tracks = s.list.songs;
  const totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const more = !!s.paged?.hasMore;
  const cols: { label: string; value: string }[] = [];
  if (s.kind !== 'song') cols.push({ label: 'Tracks', value: `${tracks.length}${more ? '+' : ''}` });
  cols.push({ label: 'Duration', value: s.kind === 'song' ? formatDuration(totalMs) : formatReadableDuration(totalMs) });
  if (s.kind === 'album' && s.detail.releaseDate) cols.push({ label: 'Released', value: s.detail.releaseDate });
  if (s.detail.recordLabel) cols.push({ label: 'Label', value: s.detail.recordLabel });
  return cols;
}

function render(page: P) {
  const s = page.state;
  if (!s.detail) return;
  const d = s.detail;
  const notes = stripHtml(d.notes).trim();
  const credit = stripHtml(d.copyright).trim();
  const owned = s.owned?.canEdit ? s.owned : null;
  update(page, {
    status: 'ready',
    title: d.title,
    subtitle: d.subtitle ?? '',
    type: TYPE_LABEL[s.kind],
    cover: d.cover,
    info: info(s),
    hasArtist: !!d.artistId,
    downloadLabel: s.list.songs.length > 1 ? 'Download All' : 'Download',
    hasOwned: owned != null,
    ownedActions: playlistActions(s.ownedBusy, true),
    hasNotes: !!(notes || credit),
    notes,
    credit,
    ...s.list.bulkData(),
    tracks: s.list.rows({ fallbackCover: d.cover }),
    hasMore: !!s.paged?.hasMore,
  });
}

async function load(page: P) {
  const s = page.state;
  try {
    let songs: Song[];
    let context: PlayContext | null = null;
    switch (s.kind) {
      case 'playlist': {
        const p = await playlist(s.id);
        s.detail = { title: p.name, subtitle: p.curatorName, cover: bestArtwork(p.artwork), notes: p.description };
        s.paged = await playlistTracks(s.id);
        songs = s.paged.items;
        context = { kind: 'playlist', id: p.id };
        void ownedPlaylist(s.id)
          .then((owned) => {
            s.owned = owned;
            render(page);
          })
          .catch(() => {});
        break;
      }
      case 'album': {
        const a = await album(s.id);
        s.detail = {
          title: a.name,
          subtitle: a.artistName,
          releaseDate: a.releaseDate,
          cover: bestArtwork(a.artwork),
          artistId: a.artistId,
          recordLabel: a.recordLabel,
          copyright: a.copyright,
          notes: a.notes,
        };
        songs = a.tracks;
        context = { kind: 'album', id: a.id };
        break;
      }
      case 'song': {
        const t = await song(s.id);
        // A single song genuinely has no container to report plays under.
        s.detail = { title: t.name, subtitle: t.artistName, cover: bestArtwork(t.artwork), artistId: t.artistId };
        songs = [t];
        break;
      }
    }
    // Plays started here land in Apple's Recently Played as this album or
    // playlist rather than as loose songs.
    rememberContext(
      songs.map((t) => t.id),
      context,
    );
    await s.list.set(songs);
  } catch (e) {
    update(page, { status: 'error', error: errorText(e) });
  }
}

function defineDetail(name: string, kind: Kind) {
  definePage<PageData, State>(name, {
    open(page) {
      const s = page.state;
      s.kind = kind;
      s.id = page.params.id;
      s.paged = null;
      s.owned = null;
      s.ownedBusy = false;
      s.list = new SongList(() => render(page));
      s.list.watch(page);
      void load(page);
      return { status: 'loading', tracks: [], info: [], ownedActions: [], hasOwned: false, hasBulk: false };
    },
    events: {
      play(page, { index }) {
        return playSongs(page.state.list.songs, index ?? 0);
      },
      shuffle(page) {
        return playSongs(page.state.list.songs, 0, true);
      },
      menu(page, { index, action }) {
        return page.state.list.menu(index, action);
      },
      artist(page, { index }) {
        const s = page.state;
        const id = index == null ? s.detail?.artistId : s.list.songs[index]?.artistId;
        if (id) return elbert.ui.navigate(routes.artist(id));
      },
      async more(page) {
        const s = page.state;
        if (s.paged && (await s.paged.loadMore())) {
          rememberContext(
            s.paged.items.map((t) => t.id),
            { kind: 'playlist', id: s.id },
          );
          await s.list.set(s.paged.items);
        }
      },
      async downloadAll(page) {
        const s = page.state;
        try {
          // A playlist drains its pages first: Download all must cover the
          // whole playlist, not the page that happened to be loaded.
          const songs = s.paged ? await s.paged.loadAll() : s.list.songs;
          if (s.paged) await s.list.set(songs);
          await s.list.downloadAll(songs, {
            albumId: s.kind === 'album' ? s.id : undefined,
            label: s.detail.title,
            subtitle: s.detail.subtitle,
            artworkUrl: s.detail.cover,
          });
        } catch (e) {
          await elbert.ui.toast(`Download failed: ${errorText(e)}`);
        }
      },
      downloads() {
        return elbert.ui.navigate(`${SECTION}/downloads`);
      },
      viewFiles(page) {
        const folder = page.state.list.bulkData().bulkFolder;
        if (folder) return elbert.ui.reveal(folder);
      },
      ownedAction(page, { id }) {
        const s = page.state;
        const owned = s.owned;
        if (!owned) return;
        return runPlaylistAction(id, {
          libraryId: owned.id,
          name: owned.name,
          loadAll: async () => (s.paged ? s.paged.loadAll() : s.list.songs),
          // This page can't reorder: Edit order opens the library page.
          setBusy: (b) => {
            s.ownedBusy = b;
            render(page);
          },
          renamed: (name) => {
            s.owned = { ...owned, name };
            render(page);
          },
          deleted: () => void elbert.ui.navigate('', { mode: 'pop' }),
        });
      },
    },
  });
}

defineDetail('playlistDetail', 'playlist');
defineDetail('albumDetail', 'album');
defineDetail('songDetail', 'song');
