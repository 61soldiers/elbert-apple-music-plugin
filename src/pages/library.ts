// The account's own library, as one page of sections at every width: pins,
// playlists, shortcuts to the three flat lists (Songs · Albums · Artists) and
// Downloads, then a "Recently Added" grid. Each flat list opens on a page of
// its own (`/apple-music/library/<list>`).
//
// It began as a phone layout — a segmented control over Songs / Albums /
// Artists hid the pins and playlists on tabs you had to already know about —
// and desktop shares it. What differs by width is chrome only (the template's
// job): a phone gets a "Library" header, desktop the sub-nav and New playlist.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { invalidate, invalidatePaged, type Paged } from '../cache';
import { libraryAlbums, libraryArtists, libraryPlaylists, librarySongs, pins, recentlyAdded } from '../data';
import { activeCount, onDownloadsChange } from '../downloads';
import { type Album, type Artist, type LibraryPlaylist, type Pin, type Song, sizedArtwork } from '../orchard/client';
import { playSongs } from '../playback';
import { definePage, errorText, libraryPlaylistRoute, onClose, openPin, type PageData, RAIL_PX, routes, SECTION, sectionChrome, update } from './common';
import { createPlaylistWithPrompt } from './songs';

// ---- Library overview -----------------------------------------------------------------

interface State {
  pins: Pin[];
  playlists: Paged<LibraryPlaylist>;
  recent: Paged<Album>;
}

const tiles = () => {
  const active = activeCount();
  return [
    { id: 'songs', icon: 'music', label: 'Songs' },
    { id: 'albums', icon: 'disc-3', label: 'Albums' },
    { id: 'artists', icon: 'user', label: 'Artists' },
    { id: 'downloads', icon: 'folder-down', label: 'Downloads', ...(active > 0 ? { trailing: `${active} active` } : {}) },
  ];
};

const libraryPlaylistCard = (p: LibraryPlaylist) => ({
  id: p.id,
  title: p.name,
  subtitle: p.canEdit ? 'Your playlist' : 'Apple Music',
  cover: sizedArtwork(p.artwork, RAIL_PX),
  placeholderIcon: 'list-music',
  // Playlist names here are short; a second reserved line was empty under
  // every card.
  titleLines: 1,
});

const recentCard = (a: Album) => ({ id: a.id, title: a.name, subtitle: a.artistName, cover: sizedArtwork(a.artwork, RAIL_PX), titleLines: 1 });

async function loadOverview(page: Page<PageData, State>, force = false) {
  const s = page.state;
  if (force) {
    invalidate('pins');
    invalidatePaged('lib:playlists');
    invalidatePaged('lib:recent');
  }
  s.playlists = libraryPlaylists();
  s.recent = recentlyAdded();

  const pinned = pins()
    .then((list) => {
      s.pins = list;
      update(page, { hasPins: list.length > 0, pins: list.map((p) => ({ id: p.id, title: p.name, cover: sizedArtwork(p.artwork, 160) })) });
    })
    .catch(() => {});
  const playlists = (s.playlists.isLoaded ? Promise.resolve() : s.playlists.load().then(() => {}))
    .then(() => update(page, { playlistsStatus: s.playlists.items.length ? 'ready' : 'empty', playlists: s.playlists.items.map(libraryPlaylistCard) }))
    .catch((e) => update(page, { playlistsStatus: 'error', playlistsError: errorText(e) }));
  const recent = (s.recent.isLoaded ? Promise.resolve() : s.recent.load().then(() => {}))
    .then(() => showRecent(page))
    .catch((e) => update(page, { recentStatus: 'error', recentError: errorText(e) }));
  await Promise.all([pinned, playlists, recent]);
}

function showRecent(page: Page<PageData, State>) {
  const r = page.state.recent;
  update(page, { recentStatus: r.items.length ? 'ready' : 'empty', recent: r.items.map(recentCard), recentHasMore: r.hasMore });
}

definePage<PageData, State>('library', {
  open(page) {
    page.state.pins = [];
    onClose(
      page,
      onDownloadsChange(() => update(page, { tiles: tiles() })),
    );
    void loadOverview(page);
    return {
      ...sectionChrome(page, `${SECTION}/library`),
      actions: [{ id: 'new', label: 'New playlist', icon: 'plus', primary: true }],
      hasPins: false,
      pins: [],
      playlistsStatus: 'loading',
      playlists: [],
      tiles: tiles(),
      recentStatus: 'loading',
      recent: [],
      recentHasMore: false,
    };
  },
  events: {
    refresh(page) {
      return loadOverview(page, true);
    },
    async action(page, { id }) {
      if (id !== 'new') return;
      const created = await createPlaylistWithPrompt();
      if (created) {
        await elbert.ui.toast(`Created "${created.name}".`);
        await loadOverview(page, true);
      }
    },
    pin(page, { index }) {
      const pin = page.state.pins[index];
      if (pin) return openPin(pin);
    },
    playlist(page, { index }) {
      const p = page.state.playlists.items[index];
      if (p) return elbert.ui.navigate(libraryPlaylistRoute(p));
    },
    seeAllPlaylists() {
      return elbert.ui.navigate(`${SECTION}/playlists`);
    },
    tile(_page, { id }) {
      return elbert.ui.navigate(id === 'downloads' ? `${SECTION}/downloads` : `${SECTION}/library/${id}`);
    },
    album(page, { index }) {
      const a = page.state.recent.items[index];
      if (a) return elbert.ui.navigate(routes.album(a.id));
    },
    async more(page) {
      if (await page.state.recent.loadMore()) showRecent(page);
    },
  },
});

// ---- One flat list on a page of its own ---------------------------------------------------

type ListKind = 'songs' | 'albums' | 'artists';

const LISTS: Record<ListKind, { title: string; empty: string; list: () => Paged<Song | Album | Artist>; key: string }> = {
  songs: { title: 'Songs', empty: 'No songs in your library.', list: librarySongs, key: 'lib:songs' },
  albums: { title: 'Albums', empty: 'No albums in your library.', list: libraryAlbums, key: 'lib:albums' },
  artists: { title: 'Artists', empty: 'No artists in your library.', list: libraryArtists, key: 'lib:artists' },
};

interface ListState {
  kind: ListKind;
  list: Paged<Song | Album | Artist>;
}

function listItems(kind: ListKind, items: (Song | Album | Artist)[]) {
  switch (kind) {
    case 'songs':
      return (items as Song[]).map((s) => ({ id: s.id, title: s.name, subtitle: s.artistName, cover: sizedArtwork(s.artwork, 120) }));
    case 'albums':
      return (items as Album[]).map((a) => ({ id: a.id, title: a.name, subtitle: a.artistName, cover: sizedArtwork(a.artwork, RAIL_PX) }));
    case 'artists':
      return (items as Artist[]).map((a) => ({
        id: a.id,
        title: a.name,
        subtitle: 'Artist',
        cover: sizedArtwork(a.artwork, RAIL_PX),
        placeholderIcon: 'mic-vocal',
      }));
  }
}

function showList(page: Page<PageData, ListState>) {
  const { kind, list } = page.state;
  update(page, { status: list.items.length ? 'ready' : 'empty', items: listItems(kind, list.items), hasMore: list.hasMore });
}

async function loadList(page: Page<PageData, ListState>, force = false) {
  const spec = LISTS[page.state.kind];
  if (force) invalidatePaged(spec.key);
  page.state.list = spec.list();
  try {
    if (force || !page.state.list.isLoaded) await page.state.list.load();
    showList(page);
  } catch (e) {
    update(page, { status: 'error', error: errorText(e) });
  }
}

definePage<PageData, ListState>('libraryList', {
  open(page) {
    const kind = (page.params.list in LISTS ? page.params.list : 'songs') as ListKind;
    page.state.kind = kind;
    void loadList(page);
    return { kind, title: LISTS[kind].title, empty: LISTS[kind].empty, status: 'loading', items: [], hasMore: false };
  },
  events: {
    refresh(page) {
      return loadList(page, true);
    },
    async more(page) {
      if (await page.state.list.loadMore()) showList(page);
    },
    tap(page, { index }) {
      const { kind, list } = page.state;
      const item = list.items[index];
      if (!item) return;
      // Songs already in the local library play from disk (playableQueue).
      if (kind === 'songs') return playSongs(list.items as Song[], index);
      return elbert.ui.navigate(kind === 'albums' ? routes.album(item.id) : routes.artist(item.id));
    },
  },
});
