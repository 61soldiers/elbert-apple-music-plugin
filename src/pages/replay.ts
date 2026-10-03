// Apple Music **Replay**: the account's own listening summary, straight from
// Apple — a year at a time, with each month opening from the year's chart.
//
// Deliberately *not* Elbert's statistics page. Apple counts every device the
// account plays on; Elbert counts what played in Elbert. Showing them as one
// number would be wrong both ways, so they are two screens that each say
// whose figure they show.
//
// Apple's quirks, all load-bearing:
// - Songs carry plays but **no listen time**; the caption says plays only
//   rather than inventing minutes from track length × plays.
// - The year in progress has **no totals** (Apple finalises a year when it
//   ends), so its hero sums the months and says so.
// - Apple ranks by year only; a month's rankings come back empty, and the page
//   says why instead of just showing less.
// - Genres have no catalog page, so they aren't tappable.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { invalidate } from '../cache';
import { replay, replayMonths, replayYears } from '../data';
import { formatListenMinutes, groupDigits } from '../format';
import { type Item, itemSubtitle, type Milestone, type Summary, type SummaryEntry, sizedArtwork } from '../orchard/client';
import { definePage, errorText, openItem, type PageData, routes, SECTION, sectionChrome, update } from './common';

/** The cards are 150–180 logical px; 360 covers them at 2×. */
const CARD_PX = 360;

const hasTotals = (s: Summary) => s.listenTimeInMinutes > 0;
const isMonth = (s: Summary) => s.period === 'month';

/** Apple's listen time where it has one, else the play count (songs never have minutes). */
export function entryCaption(e: SummaryEntry): string {
  const plays = e.playCount === 1 ? '1 play' : `${e.playCount} plays`;
  return e.listenTimeInMinutes > 0 ? `${formatListenMinutes(e.listenTimeInMinutes)} · ${plays}` : plays;
}

export function milestoneLabel(m: Milestone): string {
  const value = m.value || `${m.listenTimeInMinutes}`;
  const n = Number.parseInt(value, 10);
  const pretty = Number.isFinite(n) && n > 0 ? groupDigits(n) : value;
  switch (m.kind) {
    case 'listen-time':
      return `${pretty} minutes`;
    case 'song':
      return `${pretty} songs`;
    case 'artist':
      return `${pretty} artists`;
    case 'album':
      return `${pretty} albums`;
    case 'genre':
      return `${pretty} genres`;
    default:
      return pretty;
  }
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "May 1, 2024" from Apple's date, read as a calendar date (no timezone shift). */
function milestoneDate(iso: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return '';
  return `${MONTH_ABBR[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

const milestoneArt = (template: string) => (template ? template.replace(/\{w\}/g, '256').replace(/\{h\}/g, '256').replace(/\{f\}/g, 'png') : undefined);

const railCards = (entries: SummaryEntry[]) =>
  entries.map((e) => ({ id: e.item?.id ?? '', title: e.name, subtitle: entryCaption(e), cover: sizedArtwork(e.item?.artwork, CARD_PX) }));

/** Everything the Replay body shows for one period. */
export function replayBody(s: Summary, months: Summary[]) {
  const monthsTotal = months.reduce((sum, m) => sum + m.listenTimeInMinutes, 0);
  const derived = !hasTotals(s) && monthsTotal > 0;
  const minutes = hasTotals(s) ? s.listenTimeInMinutes : monthsTotal;
  const hours = Math.floor(minutes / 60);
  const counts = [
    { icon: 'music', label: 'songs', value: s.uniqueSongCount },
    { icon: 'user-round', label: 'artists', value: s.uniqueArtistCount },
    { icon: 'disc-3', label: 'albums', value: s.uniqueAlbumCount },
    { icon: 'tags', label: 'genres', value: s.uniqueGenreCount },
  ].filter((t) => t.value > 0);
  const busiest = months.reduce<Summary | null>((best, m) => (!best || m.listenTimeInMinutes > best.listenTimeInMinutes ? m : best), null);

  return {
    summaryId: s.id,
    hero: {
      caption: isMonth(s) ? `${s.name} ${s.year}`.toUpperCase() : `REPLAY ${s.name}`,
      value: hours > 0 ? hours : minutes,
      unit: hours > 0 ? (hours === 1 ? 'hour of music' : 'hours of music') : minutes === 1 ? 'minute of music' : 'minutes of music',
      ...(derived
        ? { note: "Added up from this year's months — Apple only finalises a year's own total once the year is over." }
        : minutes === 0
          ? { note: "Apple hasn't published a total for this period yet." }
          : {}),
    },
    hasCounts: counts.length > 0,
    counts,
    hasPlaylist: !!s.playlistId,
    playlistName: s.playlistName || `Replay ${s.year}`,
    hasMonths: months.length > 1,
    monthsCaption: busiest ? `Busiest month: ${busiest.name} — ${formatListenMinutes(busiest.listenTimeInMinutes)}` : '',
    months: months.map((m) => ({
      id: m.id,
      label: m.name.slice(0, 1),
      tooltip: `${m.name}: ${formatListenMinutes(m.listenTimeInMinutes)}`,
      value: m.listenTimeInMinutes,
    })),
    monthNote: isMonth(s) && s.topSongs.length === 0,
    hasArtists: s.topArtists.length > 0,
    artists: railCards(s.topArtists),
    hasSongs: s.topSongs.length > 0,
    songs: s.topSongs.map((e) => ({
      id: e.item?.id ?? '',
      title: e.name,
      subtitle: e.item ? itemSubtitle(e.item) : '',
      cover: sizedArtwork(e.item?.artwork, 96),
      caption: entryCaption(e),
      disabled: !e.item,
    })),
    hasAlbums: s.topAlbums.length > 0,
    albums: railCards(s.topAlbums),
    hasGenres: s.topGenres.length > 0,
    genres: s.topGenres.map((e) => ({ name: e.name, caption: entryCaption(e), value: e.listenTimeInMinutes })),
    hasPlaylists: s.topPlaylists.length > 0,
    playlists: railCards(s.topPlaylists),
    hasStations: s.topStations.length > 0,
    stations: railCards(s.topStations),
    hasMilestones: s.milestones.length > 0,
    milestones: s.milestones.map((m) => ({
      art: milestoneArt(m.artworkLight || m.artworkDark),
      artDark: milestoneArt(m.artworkDark || m.artworkLight),
      label: milestoneLabel(m),
      caption: milestoneDate(m.dateReached),
    })),
  };
}

/** The entry a body event names (`rail` + `index`). */
function entryFor(s: Summary, rail: string, index: number): Item | undefined {
  const list: Record<string, SummaryEntry[]> = {
    artists: s.topArtists,
    songs: s.topSongs,
    albums: s.topAlbums,
    playlists: s.topPlaylists,
    stations: s.topStations,
  };
  return list[rail]?.[index]?.item;
}

/** Events both Replay pages share. */
type BodyPage = Page<PageData, { summary?: Summary }>;

const bodyEvents = {
  open(page: BodyPage, { rail, index }: Record<string, unknown>) {
    const s = page.state.summary;
    const item = s && entryFor(s, String(rail), Number(index));
    if (item) return openItem(item);
  },
  playlist(page: BodyPage) {
    const id = page.state.summary?.playlistId;
    if (id) return elbert.ui.navigate(routes.playlist(id));
  },
  month(_page: BodyPage, { id }: Record<string, unknown>) {
    if (typeof id === 'string' && id) return elbert.ui.navigate(routes.replay(id));
  },
  yearRankings() {
    return elbert.ui.navigate(`${SECTION}/replay`, { mode: 'go' });
  },
};

// ---- The year page (the Replay tab) ----------------------------------------------------

interface YearState {
  years: Summary[];
  selected: string;
  summary?: Summary;
  seq: number;
}

async function loadYear(page: Page<PageData, YearState>, force = false) {
  const s = page.state;
  const year = s.years.find((y) => y.id === s.selected) ?? s.years[0];
  if (!year) return;
  const seq = ++s.seq;
  if (force) {
    invalidate(`replay:${year.id}`);
    invalidate(`replay:months:${year.year}`);
  }
  update(page, { bodyStatus: 'loading', selected: year.id });
  try {
    const [summary, months] = await Promise.all([replay(year.id), replayMonths(year.year).catch(() => [] as Summary[])]);
    if (seq !== s.seq) return;
    s.summary = summary;
    update(page, { bodyStatus: 'ready', body: replayBody(summary, months) });
  } catch (e) {
    if (seq === s.seq) update(page, { bodyStatus: 'error', bodyError: errorText(e) });
  }
}

definePage<PageData, YearState>('replay', {
  open(page) {
    const s = page.state;
    s.years = [];
    s.seq = 0;
    void (async () => {
      try {
        const index = await replayYears();
        s.years = index.summaries;
        if (!s.years.length) {
          update(page, { status: 'empty' });
          return;
        }
        s.selected = s.years[0].id;
        update(page, { status: 'ready', years: s.years.map((y) => ({ id: y.id, label: y.name })), selected: s.selected });
        await loadYear(page);
      } catch (e) {
        update(page, { status: 'error', error: errorText(e) });
      }
    })();
    return { ...sectionChrome(page, `${SECTION}/replay`), status: 'loading', years: [], bodyStatus: 'loading' };
  },
  events: {
    ...bodyEvents,
    select(page, { id }) {
      page.state.selected = id;
      return loadYear(page);
    },
    refresh(page) {
      return loadYear(page, true);
    },
  },
});

// ---- One month, opened from the year's chart -----------------------------------------------

async function loadMonth(page: Page<PageData, { summary?: Summary }>, force = false) {
  const id = page.params.id;
  if (force) invalidate(`replay:${id}`);
  try {
    const summary = await replay(id);
    page.state.summary = summary;
    update(page, { status: 'ready', title: `${summary.name} ${summary.year}`, bodyStatus: 'ready', body: replayBody(summary, []) });
  } catch (e) {
    update(page, { status: 'error', error: errorText(e) });
  }
}

definePage<PageData, { summary?: Summary }>('replayMonth', {
  open(page) {
    void loadMonth(page);
    return { status: 'loading', title: '', bodyStatus: 'loading' };
  },
  events: {
    ...bodyEvents,
    refresh(page) {
      return loadMonth(page, true);
    },
  },
});
