// One of the account's library playlists — the page your own playlists open
// on, and the only one that can reorder: rename, edit order (drag, ✕ to
// remove), sync to library and delete all go straight to Apple, so they show
// up in Apple's own apps too.
//
// Every edit needs the *whole* playlist: Apple has no "move one track", so
// an edit replaces the full list and anything never loaded would be dropped.
// While editing, the page shows its own working order rather than refetching,
// so the list doesn't snap back for as long as a refetch takes.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import type { Paged } from '../cache';
import { invalidateLibraryPlaylists, libraryPlaylist, libraryPlaylistTracks } from '../data';
import { downloadSongs } from '../downloads';
import { stripHtml } from '../html';
import { type LibraryPlaylist, type Song, sizedArtwork } from '../orchard/client';
import { playSongs } from '../playback';
import { setTracks } from '../playlists';
import { definePage, errorText, type PageData, update } from './common';
import { playlistActions, runPlaylistAction } from './playlist_actions';
import { SongList } from './tracks';

interface State {
  playlist: LibraryPlaylist;
  paged: Paged<Song>;
  list: SongList;
  /** The page's own order while editing. */
  working: Song[] | null;
  editing: boolean;
  busy: boolean;
}

type P = Page<PageData, State>;

const tracks = (s: State) => s.working ?? s.paged?.items ?? s.playlist?.tracks ?? [];

function render(page: P) {
  const s = page.state;
  if (!s.playlist) return;
  const list = tracks(s);
  const more = s.working == null && !!s.paged?.hasMore;
  const n = list.length;
  update(page, {
    status: 'ready',
    title: s.playlist.name,
    cover: sizedArtwork(s.playlist.artwork, 240),
    countLine: `${n}${more ? '+' : ''} song${n === 1 && !more ? '' : 's'}${s.playlist.canEdit ? '' : ' · read-only'}`,
    hasDescription: !!stripHtml(s.playlist.description),
    description: stripHtml(s.playlist.description),
    hasTracks: n > 0,
    canEdit: s.playlist.canEdit,
    actions: playlistActions(s.busy, n > 0),
    busy: s.busy,
    editing: s.editing,
    tracks: s.editing ? [] : s.list.rows({ removable: s.playlist.canEdit }),
    editItems: s.editing ? list.map((t) => ({ id: t.id, title: t.name, artist: t.artistName, cover: sizedArtwork(t.artwork, 88) })) : [],
    hasMore: more,
  });
}

async function load(page: P) {
  const s = page.state;
  const id = page.params.id;
  try {
    s.playlist = await libraryPlaylist(id);
    s.paged = await libraryPlaylistTracks(id);
    await s.list.set(s.paged.items);
  } catch (e) {
    update(page, { status: 'error', error: errorText(e) });
  }
}

async function loadEvery(s: State) {
  if (s.working) return s.working;
  const all = await s.paged.loadAll();
  return all.length ? all : tracks(s);
}

async function pushOrder(page: P, order: Song[]) {
  const s = page.state;
  s.working = order;
  await s.list.set(order);
  const error = await setTracks(
    s.playlist.id,
    order.map((t) => t.id),
    true,
  );
  if (error) await elbert.ui.toast(error);
  return error;
}

/** The ⋯ menu's "Remove from playlist". By position, so a song listed twice loses only that row. */
async function removeAt(page: P, index: number) {
  const s = page.state;
  const song = tracks(s)[index];
  if (!song) return;
  s.busy = true;
  render(page);
  try {
    // The loaded part is a prefix of the whole list, so the row's index holds.
    const next = [...(await loadEvery(s))];
    if (next[index]?.id !== song.id) return;
    next.splice(index, 1);
    const previous = s.working;
    if (!(await pushOrder(page, next))) {
      await elbert.ui.toast(`Removed "${song.name}" from ${s.playlist.name}.`, { durationMs: 2000 });
      return;
    }
    // Apple refused: show what it still has.
    s.working = previous;
    await s.list.set(previous ?? s.paged.items);
  } catch (e) {
    await elbert.ui.toast(errorText(e));
  } finally {
    s.busy = false;
    render(page);
  }
}

async function toggleEditing(page: P) {
  const s = page.state;
  if (s.editing) {
    s.editing = false;
    render(page);
    return;
  }
  s.busy = true;
  render(page);
  try {
    s.working = await loadEvery(s);
    await s.list.set(s.working);
    s.editing = true;
  } catch (e) {
    await elbert.ui.toast(errorText(e));
  } finally {
    s.busy = false;
    render(page);
  }
}

definePage<PageData, State>('libraryPlaylist', {
  open(page) {
    const s = page.state;
    s.working = null;
    s.editing = false;
    s.busy = false;
    s.list = new SongList(() => render(page));
    s.list.watch(page);
    void load(page);
    return { status: 'loading', editing: false, tracks: [], editItems: [], actions: [] };
  },
  events: {
    play(page, { index }) {
      return playSongs(tracks(page.state), index ?? 0);
    },
    menu(page, { index, action }) {
      if (action === 'removeFromPlaylist') return removeAt(page, index);
      return page.state.list.menu(index, action);
    },
    async more(page) {
      const s = page.state;
      if (s.working == null && (await s.paged.loadMore())) await s.list.set(s.paged.items);
    },
    async downloadAll(page) {
      const s = page.state;
      s.busy = true;
      render(page);
      try {
        const all = await loadEvery(s);
        await downloadSongs(all, { label: s.playlist.name });
        await elbert.ui.toast(`Downloading "${s.playlist.name}" — ${all.length} track(s).`);
      } catch (e) {
        await elbert.ui.toast(errorText(e));
      } finally {
        s.busy = false;
        render(page);
      }
    },
    toggleEditing(page) {
      return toggleEditing(page);
    },
    reorder(page, { from, to }) {
      const next = [...tracks(page.state)];
      next.splice(to, 0, ...next.splice(from, 1));
      return pushOrder(page, next);
    },
    remove(page, { index }) {
      const next = [...tracks(page.state)];
      next.splice(index, 1);
      return pushOrder(page, next);
    },
    action(page, { id }) {
      const s = page.state;
      return runPlaylistAction(id, {
        libraryId: s.playlist.id,
        name: s.playlist.name,
        loadAll: () => loadEvery(s),
        editOrder: () => toggleEditing(page),
        setBusy: (b) => {
          s.busy = b;
          render(page);
        },
        renamed: (name) => {
          s.playlist = { ...s.playlist, name };
          render(page);
        },
        deleted: () => {
          invalidateLibraryPlaylists();
          void elbert.ui.navigate('', { mode: 'pop' });
        },
      });
    },
  },
});
