// Every library playlist of the account — the "See all" of the Library tab's
// playlists shelf. A playlist that mirrors a catalog playlist (and isn't
// yours to edit) opens the catalog page; the rest open the library page.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { invalidatePaged, type Paged } from '../cache';
import { libraryPlaylists } from '../data';
import { type LibraryPlaylist, sizedArtwork } from '../orchard/client';
import { definePage, errorText, libraryPlaylistRoute, type PageData, RAIL_PX, SECTION, sectionChrome, update } from './common';
import { createPlaylistWithPrompt } from './songs';

interface State {
  list: Paged<LibraryPlaylist>;
}

const card = (p: LibraryPlaylist) => ({
  id: p.id,
  title: p.name,
  subtitle: p.canEdit ? 'Your playlist' : 'Apple Music',
  cover: sizedArtwork(p.artwork, RAIL_PX),
  placeholderIcon: 'list-music',
});

function show(page: Page<PageData, State>) {
  const l = page.state.list;
  update(page, { status: l.items.length ? 'ready' : 'empty', items: l.items.map(card), hasMore: l.hasMore });
}

async function load(page: Page<PageData, State>, force = false) {
  if (force) invalidatePaged('lib:playlists');
  page.state.list = libraryPlaylists();
  try {
    if (force || !page.state.list.isLoaded) await page.state.list.load();
    show(page);
  } catch (e) {
    update(page, { status: 'error', error: errorText(e) });
  }
}

definePage<PageData, State>('playlists', {
  open(page) {
    void load(page);
    return {
      ...sectionChrome(page, `${SECTION}/library`),
      actions: [{ id: 'new', label: 'New playlist', icon: 'plus', primary: true }],
      status: 'loading',
      items: [],
      hasMore: false,
    };
  },
  events: {
    refresh(page) {
      return load(page, true);
    },
    async more(page) {
      if (await page.state.list.loadMore()) show(page);
    },
    open(page, { index }) {
      const p = page.state.list.items[index];
      if (p) return elbert.ui.navigate(libraryPlaylistRoute(p));
    },
    async action(page, { id }) {
      if (id !== 'new') return;
      const created = await createPlaylistWithPrompt();
      if (!created) return;
      await elbert.ui.toast(`Created "${created.name}".`);
      await load(page, true);
    },
  },
});
