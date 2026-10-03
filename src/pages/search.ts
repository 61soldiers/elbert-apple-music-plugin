// Apple Music catalog search (the Search tab): songs as rows, then artists,
// albums and playlists as card strips. Every result opens its detail page.

import { search } from '../data';
import { type SearchResults, sizedArtwork } from '../orchard/client';
import { albumCard, artistCard, definePage, errorText, type PageData, playlistCard, routes, SECTION, sectionChrome, update } from './common';

const HINT = 'Search songs, albums, artists and playlists.';
/** The old page showed at most this many song rows. */
const MAX_SONGS = 15;
const CARD_PX = 340;

interface State {
  results: SearchResults | null;
  /** Bumped per query, so a slow answer to an old query is dropped. */
  seq: number;
}

function resultsData(r: SearchResults) {
  const songs = r.songs.slice(0, MAX_SONGS);
  return {
    hasSongs: songs.length > 0,
    songs: songs.map((s, index) => ({ index, title: s.name, subtitle: s.artistName, cover: sizedArtwork(s.artwork, 120) })),
    hasArtists: r.artists.length > 0,
    artists: r.artists.map((a) => artistCard(a, CARD_PX)),
    hasAlbums: r.albums.length > 0,
    albums: r.albums.map((a) => albumCard(a, CARD_PX)),
    hasPlaylists: r.playlists.length > 0,
    playlists: r.playlists.map((p) => playlistCard(p, CARD_PX)),
  };
}

const empty = { hasSongs: false, songs: [], hasArtists: false, artists: [], hasAlbums: false, albums: [], hasPlaylists: false, playlists: [] };

definePage<PageData, State>('search', {
  open(page) {
    page.state.results = null;
    page.state.seq = 0;
    return { ...sectionChrome(page, `${SECTION}/search`), status: 'hint', icon: 'search', message: HINT, ...empty };
  },
  events: {
    async query(page, { query }) {
      const q = String(query ?? '').trim();
      const seq = ++page.state.seq;
      if (q.length < 2) {
        page.state.results = null;
        update(page, { status: 'hint', icon: 'search', message: HINT, ...empty });
        return;
      }
      update(page, { status: 'loading' });
      try {
        const r = await search(q);
        if (seq !== page.state.seq) return;
        page.state.results = r;
        const none = !r.songs.length && !r.albums.length && !r.artists.length && !r.playlists.length;
        update(page, none ? { status: 'hint', icon: 'search-x', message: `Nothing found for "${q}".`, ...empty } : { status: 'ready', ...resultsData(r) });
      } catch (e) {
        if (seq !== page.state.seq) return;
        update(page, { status: 'hint', icon: 'circle-alert', message: errorText(e) });
      }
    },
    song(page, { index }) {
      const s = page.state.results?.songs[index];
      if (s) return elbert.ui.navigate(routes.song(s.id));
    },
    artist(page, { index }) {
      const a = page.state.results?.artists[index];
      if (a) return elbert.ui.navigate(routes.artist(a.id));
    },
    album(page, { index }) {
      const a = page.state.results?.albums[index];
      if (a) return elbert.ui.navigate(routes.album(a.id));
    },
    playlist(page, { index }) {
      const p = page.state.results?.playlists[index];
      if (p) return elbert.ui.navigate(routes.playlist(p.id));
    },
  },
});
