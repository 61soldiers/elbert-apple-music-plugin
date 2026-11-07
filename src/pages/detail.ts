// One catalog playlist, album or song, laid out as Elbert's own album and
// playlist pages are: the sticky header (a summary line, Play / Shuffle /
// Download, About and the rest in its ⋯ menu), a Tracks heading with the
// cards/table switch, and the tracks with their download status. On an
// Elbert without those pieces it keeps the older layout: info chips, a
// Download row and the notes under the header.
//
// A catalog playlist page can't tell on its own whether the playlist is
// yours — Apple gives a shareable catalog id to playlists of your own too —
// so it asks (`ownedPlaylist`) and shows the edit actions only on a match.
// Showing actions that would 403 is worse than showing none.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { type PlayContext, rememberContext } from '../activity';
import type { Paged } from '../cache';
import { album, ownedPlaylist, playlist, playlistTracks, song } from '../data';
import { formatCount, formatDuration, formatReadableDuration } from '../format';
import { stripHtml } from '../html';
import { bestArtwork, type LibraryPlaylist, type Song, sizedArtwork } from '../orchard/client';
import { playSongs } from '../playback';
import { definePage, errorText, hasDetailPages, type PageData, releaseYear, routes, SECTION, showAbout, update } from './common';
import { playlistActions, runPlaylistAction } from './playlist_actions';
import { SongList } from './tracks';

type Kind = 'playlist' | 'album' | 'song';

interface Detail {
  title: string;
  subtitle?: string;
  releaseDate?: string;
  cover?: string;
  /** Drawn sharp across the header, as Elbert's album page draws its large cover. */
  hero?: string;
  artistId?: string;
  recordLabel?: string;
  copyright?: string;
  notes?: string;
  genres?: string[];
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

/** Elbert decodes a header's hero at most 1600 wide; Apple's artwork goes to 3000. */
const HERO_PX = 1600;

const TYPE_LABEL: Record<Kind, string> = { playlist: 'PLAYLIST', album: 'ALBUM', song: 'SONG' };

function info(s: State) {
  const tracks = s.list.songs;
  const totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const more = !!s.paged?.hasMore;
  const cols: { label: string; value: string }[] = [];
  if (s.kind !== 'song') cols.push({ label: 'Tracks', value: `${tracks.length}${more ? '+' : ''}` });
  cols.push({ label: 'Duration', value: s.kind === 'song' ? formatDuration(totalMs) : formatReadableDuration(totalMs) });
  // Three chips at most, like Elbert's own album page: the header is a fixed height.
  if (s.kind === 'album' && s.detail.releaseDate) cols.push({ label: 'Released', value: s.detail.releaseDate.slice(0, 4) });
  return cols;
}

/** The header's one line, as Elbert's album (`2021 · 12 tracks · 48 min`) and playlist (`30 songs · 1 hr 52 min`) say it. */
function summary(s: State) {
  const tracks = s.list.songs;
  const totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const more = s.paged?.hasMore ? '+' : '';
  switch (s.kind) {
    case 'album':
      return [releaseYear(s.detail.releaseDate), formatCount(tracks.length, 'track'), formatReadableDuration(totalMs)].filter(Boolean).join(' · ');
    case 'playlist':
      return `${tracks.length}${more} ${tracks.length === 1 && !more ? 'song' : 'songs'} · ${formatReadableDuration(totalMs)}`;
    case 'song':
      return [releaseYear(s.detail.releaseDate), formatDuration(totalMs)].filter(Boolean).join(' · ');
  }
}

/** The About sheet: what the header leaves out, then Apple's notes and credit. */
function about(s: State) {
  const d = s.detail;
  const tracks = s.list.songs;
  const totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const more = s.paged?.hasMore ? '+' : '';
  const notes = stripHtml(d.notes).trim();
  return showAbout(
    d.title,
    [
      [s.kind === 'playlist' ? 'Curator' : 'Artist', d.subtitle],
      ['Released', d.releaseDate],
      ['Tracks', s.kind === 'song' ? undefined : `${tracks.length}${more}`],
      ['Length', formatReadableDuration(totalMs)],
      ['Genres', d.genres?.filter((g) => g !== 'Music').join(', ')],
      ['Label', d.recordLabel],
      ['Copyright', stripHtml(d.copyright).trim()],
    ],
    notes,
  );
}

function render(page: P) {
  const s = page.state;
  if (!s.detail) return;
  const d = s.detail;
  const modern = hasDetailPages();
  const notes = stripHtml(d.notes).trim();
  const credit = [stripHtml(d.copyright).trim(), d.recordLabel ? `Label: ${d.recordLabel}` : ''].filter(Boolean).join(' · ');
  const owned = s.owned?.canEdit ? s.owned : null;
  const n = s.list.songs.length;
  const more = s.paged?.hasMore ? '+' : '';
  update(page, {
    status: 'ready',
    modern,
    title: d.title,
    subtitle: d.subtitle ?? '',
    type: TYPE_LABEL[s.kind],
    cover: d.cover,
    hasHero: !!d.hero,
    hero: d.hero ?? '',
    summary: summary(s),
    info: modern ? [] : info(s),
    hasArtist: !!d.artistId,
    downloadLabel: modern ? (n > 1 ? `Download (${n}${more})` : 'Download') : n > 1 ? 'Download All' : 'Download',
    menu: [
      ...(modern ? [{ id: 'about', label: 'About', icon: 'info' }] : []),
      ...(d.artistId ? [{ id: 'artist', label: 'Go to artist', icon: 'user' }] : []),
      { id: 'downloads', label: 'Downloads', icon: 'folder-down' },
      ...(owned ? playlistActions(s.ownedBusy, true) : []),
    ],
    // The About sheet holds them where there is one.
    hasNotes: !modern && !!(notes || credit),
    notes,
    credit,
    ...s.list.bulkData(),
    tracks: s.list.rows({ fallbackCover: d.cover }),
    // Elbert's album page gaps its cards; its playlist page doesn't.
    rowSpacing: modern && s.kind !== 'playlist' ? 8 : 0,
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
          hero: sizedArtwork(a.artwork, HERO_PX),
          artistId: a.artistId,
          recordLabel: a.recordLabel,
          copyright: a.copyright,
          notes: a.notes,
          genres: a.genres,
        };
        songs = a.tracks;
        context = { kind: 'album', id: a.id };
        break;
      }
      case 'song': {
        const t = await song(s.id);
        // A single song genuinely has no container to report plays under.
        s.detail = {
          title: t.name,
          subtitle: t.artistName,
          cover: bestArtwork(t.artwork),
          hero: sizedArtwork(t.artwork, HERO_PX),
          artistId: t.artistId,
          releaseDate: t.releaseDate,
          genres: t.genres,
        };
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
      return { status: 'loading', modern: hasDetailPages(), tracks: [], rowSpacing: 0, info: [], menu: [], hasBulk: false };
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
      viewFiles(page) {
        const folder = page.state.list.bulkData().bulkFolder;
        if (folder) return elbert.ui.reveal(folder);
      },
      about(page) {
        if (page.state.detail) return about(page.state);
      },
      // The header's ⋯ menu: About and navigation first, then the playlist's own actions.
      headerMenu(page, { id }) {
        const s = page.state;
        if (id === 'about') return about(s);
        if (id === 'artist') {
          const artistId = s.detail?.artistId;
          return artistId ? elbert.ui.navigate(routes.artist(artistId)) : undefined;
        }
        if (id === 'downloads') return elbert.ui.navigate(`${SECTION}/downloads`);
        const owned = s.owned;
        // The header menu can't grey an item out while a sync runs.
        if (!owned || s.ownedBusy) return;
        return runPlaylistAction(id, {
          libraryId: owned.id,
          name: owned.name,
          loadAll: async () => (s.paged ? s.paged.loadAll() : s.list.songs),
          // This page can't reorder: "Reorder or remove songs" opens the library page.
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
