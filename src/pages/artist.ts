// An Apple Music artist, headed as Elbert's own artist page is (a summary
// line, About with the biography in the ⋯ menu): top songs, then the
// discography rails Apple exposes (latest release, albums, singles & EPs,
// compilations, appears on), playlists and similar artists. On an Elbert
// without the newer header the biography sits under it, as before.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { rememberContext } from '../activity';
import { artist as fetchArtist } from '../data';
import { formatCount } from '../format';
import { stripHtml } from '../html';
import { type Album, type Artist, bestArtwork, sizedArtwork } from '../orchard/client';
import { playSongs } from '../playback';
import { definePage, errorText, hasDetailPages, type PageData, routes, showAbout, update } from './common';
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

function about(a: Artist) {
  return showAbout(
    a.name,
    [
      ['Genres', a.genres.join(', ')],
      ['From', a.origin],
      ['Born or formed', a.bornOrFormed],
      ['Albums', a.albums.length ? String(a.albums.length) : undefined],
      ['Singles & EPs', a.singles.length ? String(a.singles.length) : undefined],
    ],
    stripHtml(a.notes).trim(),
  );
}

function render(page: P) {
  const { artist: a, list } = page.state;
  if (!a) return;
  const modern = hasDetailPages();
  const info = [
    ...(a.genres.length ? [{ label: 'Genre', value: a.genres[0] }] : []),
    ...(a.origin ? [{ label: 'From', value: a.origin }] : []),
    ...(a.albums.length ? [{ label: 'Albums', value: `${a.albums.length}` }] : []),
  ];
  const bio = stripHtml(a.notes).trim();
  update(page, {
    status: 'ready',
    modern,
    title: a.name,
    // Elbert's artist header has no subtitle: the genre leads the summary instead.
    subtitle: modern ? '' : a.genres.join(' · '),
    cover: bestArtwork(a.artwork),
    // The artist's photo across the header, as on Elbert's own artist page.
    hasHero: !!a.artwork,
    hero: sizedArtwork(a.artwork, 1600) ?? '',
    summary: [a.genres[0], a.albums.length ? formatCount(a.albums.length, 'album') : '', a.origin].filter(Boolean).join(' · '),
    info: modern ? [] : info.length ? info : [{ label: 'Artist', value: a.name }],
    menu: modern ? [{ id: 'about', label: 'About', icon: 'info' }] : [],
    hasBio: !modern && !!bio,
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
    return { status: 'loading', modern: hasDetailPages(), topSongs: [], rails: [], info: [], menu: [] };
  },
  events: {
    about(page) {
      if (page.state.artist) return about(page.state.artist);
    },
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
