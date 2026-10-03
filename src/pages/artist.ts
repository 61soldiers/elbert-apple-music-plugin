// An Apple Music artist: the header, biography, top songs, then the
// discography rails Apple exposes (latest release, albums, singles & EPs,
// compilations, appears on), playlists and similar artists.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { rememberContext } from '../activity';
import { artist as fetchArtist } from '../data';
import { stripHtml } from '../html';
import { type Album, type Artist, bestArtwork, sizedArtwork } from '../orchard/client';
import { playSongs } from '../playback';
import { definePage, errorText, type PageData, routes, update } from './common';
import { SongList } from './tracks';

const TOP_SONGS = 10;
const CARD_PX = 400;

interface Rail {
  key: string;
  title: string;
  open: (index: number) => string | undefined;
  cards: { id: string; title: string; subtitle: string; cover?: string; placeholderIcon?: string }[];
}

interface State {
  artist: Artist;
  list: SongList;
  rails: Rail[];
}

type P = Page<PageData, State>;

const year = (a: Album) => a.releaseDate?.split('-')[0] ?? '';

function albumRail(key: string, title: string, albums: Album[]): Rail | null {
  if (!albums.length) return null;
  return {
    key,
    title,
    open: (i) => albums[i] && routes.album(albums[i].id),
    cards: albums.map((a) => ({ id: a.id, title: a.name, subtitle: year(a), cover: sizedArtwork(a.artwork, CARD_PX), placeholderIcon: 'disc-3' })),
  };
}

function rails(a: Artist): Rail[] {
  const list: (Rail | null)[] = [
    albumRail('latest', 'Latest Release', a.latestRelease ? [a.latestRelease] : []),
    albumRail('albums', 'Albums', a.albums),
    albumRail('singles', 'Singles & EPs', a.singles),
    albumRail('compilations', 'Compilations', a.compilations),
    albumRail('appearsOn', 'Appears On', a.appearsOn),
    a.artistPlaylists.length
      ? {
          key: 'playlists',
          title: 'Playlists',
          open: (i) => a.artistPlaylists[i] && routes.playlist(a.artistPlaylists[i].id),
          cards: a.artistPlaylists.map((p) => ({
            id: p.id,
            title: p.name,
            subtitle: p.curatorName ?? '',
            cover: sizedArtwork(p.artwork, CARD_PX),
            placeholderIcon: 'list-music',
          })),
        }
      : null,
    a.similarArtists.length
      ? {
          key: 'similar',
          title: 'Similar Artists',
          open: (i) => a.similarArtists[i] && routes.artist(a.similarArtists[i].id),
          cards: a.similarArtists.map((s) => ({
            id: s.id,
            title: s.name,
            subtitle: 'Artist',
            cover: sizedArtwork(s.artwork, CARD_PX),
            placeholderIcon: 'mic-vocal',
          })),
        }
      : null,
  ];
  return list.filter((r): r is Rail => r != null);
}

function render(page: P) {
  const { artist: a, list } = page.state;
  if (!a) return;
  const info = [
    ...(a.genres.length ? [{ label: 'Genre', value: a.genres[0] }] : []),
    ...(a.origin ? [{ label: 'From', value: a.origin }] : []),
    ...(a.albums.length ? [{ label: 'Albums', value: `${a.albums.length}` }] : []),
  ];
  const bio = stripHtml(a.notes).trim();
  update(page, {
    status: 'ready',
    title: a.name,
    subtitle: a.genres.join(' · '),
    cover: bestArtwork(a.artwork),
    info: info.length ? info : [{ label: 'Artist', value: a.name }],
    hasBio: !!bio,
    bio,
    hasTopSongs: list.songs.length > 0,
    topSongs: list.rows(),
    rails: page.state.rails.map((r) => ({ key: r.key, title: r.title, items: r.cards })),
  });
}

definePage<PageData, State>('artist', {
  open(page) {
    const s = page.state;
    s.rails = [];
    s.list = new SongList(() => render(page));
    s.list.watch(page);
    void (async () => {
      try {
        s.artist = await fetchArtist(page.params.id);
        s.rails = rails(s.artist);
        const top = s.artist.topSongs.slice(0, TOP_SONGS);
        // Top songs played from here are listened to "from" this artist,
        // which is how they land in Apple's Recently Played.
        rememberContext(
          s.artist.topSongs.map((t) => t.id),
          { kind: 'artist', id: s.artist.id },
        );
        await s.list.set(top);
      } catch (e) {
        update(page, { status: 'error', error: errorText(e) });
      }
    })();
    return { status: 'loading', topSongs: [], rails: [], info: [] };
  },
  events: {
    playAll(page) {
      return playSongs(page.state.artist?.topSongs ?? [], 0);
    },
    shuffle(page) {
      return playSongs(page.state.artist?.topSongs ?? [], 0, true);
    },
    play(page, { index }) {
      // The whole top-songs list is the queue, as before.
      return playSongs(page.state.artist.topSongs, index);
    },
    menu(page, { index, action }) {
      return page.state.list.menu(index, action);
    },
    rail(page, { rail, index }) {
      const route = page.state.rails.find((r) => r.key === rail)?.open(index);
      if (route) return elbert.ui.navigate(route);
    },
  },
});
