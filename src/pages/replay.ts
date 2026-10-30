// Apple Music **Replay**: the account's own listening summary, straight from
// Apple — a year, any month of any year, or every year added together, plus
// an animated "Wrapped" story of a year (`wrapped.ts`).
//
// Deliberately *not* Elbert's statistics page. Apple counts every device the
// account plays on; Elbert counts what played in Elbert. Showing them as one
// number would be wrong both ways, so they are separate sections that each
// say whose figure they show.
//
// Apple's quirks, all load-bearing:
// - Songs carry plays but **no listen time**; the page shows "≈" minutes
//   (plays × the song's length) and says it is an estimate.
// - The year in progress has **no totals** (Apple finalises a year when it
//   ends), so its hero sums the months and says so — and its song play counts
//   are a snapshot that can lag behind those hours, which the page also says.
// - Apple ranks by year only; a month gets listen time, counts and
//   milestones. A month's rankings therefore come from Elbert's own history
//   of Apple Music plays ("In Elbert"), never mixed into Apple's numbers.
// - Genres have no catalog page, so they aren't tappable.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { invalidate } from '../cache';
import { replay, replayYears } from '../data';
import { groupDigits } from '../format';
import { type Item, itemSubtitle, type Summary, type SummaryEntry, sizedArtwork } from '../orchard/client';
import { IMPORT_PROVIDER } from '../privacy/parse';
import type { AllTime } from '../replay/alltime';
import { ArtIndex, detailBars, detailHero, detailRows, type HistoryStats } from '../replay/detail';
import { loadAllTime, monthsOf, withListening } from '../replay/load';
import { calendarDate, estimatedMinutes, milestoneArt, milestoneLabel } from '../replay/story';
import { formatMinutes, heroTime, TIME_UNITS, type TimeUnit } from '../replay/time';
import { hasHostStats, onTimeUnitChange, setTimeUnit, timeUnit } from '../replay/unit';
import { definePage, errorText, onClose, openItem, type PageData, routes, SECTION, sectionChrome, update } from './common';

export { milestoneLabel };

/** The cards are 150–180 logical px; 360 covers them at 2×. */
const CARD_PX = 360;

type Mode = 'year' | 'month' | 'all';

const MODES = [
  { id: 'year', label: 'Year', icon: 'calendar' },
  { id: 'month', label: 'Month', icon: 'calendar-days' },
  { id: 'all', label: 'All time', icon: 'infinity' },
];

const hasTotals = (s: Summary) => s.listenTimeInMinutes > 0;

/** Apple's listen time where it has one, else the play count (songs never have minutes). */
export function entryCaption(e: SummaryEntry, unit: TimeUnit, songs = false): string {
  const plays = e.playCount === 1 ? '1 play' : `${groupDigits(e.playCount)} plays`;
  if (e.listenTimeInMinutes > 0) return `${formatMinutes(e.listenTimeInMinutes, unit)} · ${plays}`;
  const est = songs ? estimatedMinutes(e) : 0;
  return est >= 1 ? `${plays} · ≈ ${formatMinutes(est, unit)}` : plays;
}

const railCards = (entries: SummaryEntry[], unit: TimeUnit) =>
  entries.map((e) => ({ id: e.item?.id ?? '', title: e.name, subtitle: entryCaption(e, unit), cover: sizedArtwork(e.item?.artwork, CARD_PX) }));

const songRows = (entries: SummaryEntry[], unit: TimeUnit) =>
  entries.map((e) => ({
    id: e.item?.id ?? '',
    title: e.name,
    subtitle: e.item ? itemSubtitle(e.item) : '',
    cover: sizedArtwork(e.item?.artwork, 96),
    caption: entryCaption(e, unit, true),
    disabled: !e.item,
  }));

const milestoneCards = (s: { milestones: Summary['milestones'] }) =>
  s.milestones.map((m) => ({
    art: milestoneArt(m.artworkLight || m.artworkDark),
    artDark: milestoneArt(m.artworkDark || m.artworkLight),
    label: milestoneLabel(m),
    caption: calendarDate(m.dateReached),
  }));

const itemsOf = (entries: SummaryEntry[]) => entries.map((e) => e.item);

type Lists = Record<string, (Item | undefined)[]>;

/** What the "In Elbert" section needs, loaded beside the Apple data. */
export interface DetailInput {
  stats: HistoryStats | null;
  /** Whether this Elbert can answer at all (`history.stats`). */
  available: boolean;
  art: ArtIndex;
  scope: string;
}

/** The "In Elbert" section of the body. Never null: the template switches on its flags. */
export function detailBody(d: DetailInput, unit: TimeUnit, lists: Lists, barsCaption: string) {
  const none = {
    hasDetail: false,
    detail: {
      caption: '',
      barsCaption: '',
      hasBars: false,
      bars: [] as unknown[],
      hasSongs: false,
      songs: [] as unknown[],
      hasAlbums: false,
      albums: [] as unknown[],
      hasArtists: false,
      artists: [] as unknown[],
    },
    hasDetailEmpty: false,
    detailEmpty: '',
  };
  if (!d.available) return none;
  if (!d.stats || d.stats.plays === 0) {
    return { ...none, hasDetailEmpty: true, detailEmpty: `No Apple Music plays are logged in Elbert for ${d.scope}.` };
  }
  const { rows, items } = detailRows(d.stats, d.art, unit);
  lists.detailSongs = items.songs;
  lists.detailAlbums = items.albums;
  lists.detailArtists = items.artists;
  const hero = detailHero(d.stats, unit);
  const bars = detailBars(d.stats, unit, 'd');
  return {
    hasDetail: true,
    hasDetailEmpty: false,
    detailEmpty: '',
    detail: {
      caption: `${hero.listened} · ${hero.plays}`,
      barsCaption,
      hasBars: bars.length > 1,
      bars,
      hasSongs: rows.songs.length > 0,
      songs: rows.songs,
      hasAlbums: rows.albums.length > 0,
      albums: rows.albums,
      hasArtists: rows.artists.length > 0,
      artists: rows.artists,
    },
  };
}

interface BodyInput {
  mode: Mode;
  summary?: Summary;
  months: Summary[];
  all?: AllTime;
  detail: DetailInput;
  unit: TimeUnit;
  /** A month Apple hasn't published yet: only Elbert's own history has it. */
  pending?: boolean;
}

const emptyBody = {
  hasCounts: false,
  counts: [] as unknown[],
  hasHighlights: false,
  highlights: [] as unknown[],
  hasPlaylist: false,
  playlistName: '',
  hasBars: false,
  bars: [] as unknown[],
  barsTitle: '',
  barsCaption: '',
  barsKind: 'month',
  hasNote: false,
  noteTitle: '',
  noteText: '',
  hasSongsNote: false,
  songsNote: '',
  hasArtists: false,
  artists: [] as unknown[],
  hasSongs: false,
  songs: [] as unknown[],
  songsTitle: 'Top songs',
  hasAlbums: false,
  albums: [] as unknown[],
  hasGenres: false,
  genres: [] as unknown[],
  hasPlaylists: false,
  playlists: [] as unknown[],
  hasStations: false,
  stations: [] as unknown[],
  hasMilestones: false,
  milestones: [] as unknown[],
};

/** What the year-in-progress ranking covers: Apple's snapshot, up to the latest play it counted. */
export function snapshotNote(s: Summary): string {
  const latest = [...s.topSongs, ...s.topArtists, ...s.topAlbums].reduce((best, e) => (e.lastPlayed && e.lastPlayed > best ? e.lastPlayed : best), '');
  const upTo = calendarDate(latest);
  return `${upTo ? `Apple counted these plays up to ${upTo}` : "These are Apple's own counts for the year so far"}, and refreshes them on its own schedule, so songs played since are not in them yet, even though the hours above are added up from the months. Plays Elbert logged are counted live under “In Elbert” below.`;
}

const genreRows = (entries: SummaryEntry[], unit: TimeUnit) =>
  entries.map((e) => ({ name: e.name, caption: entryCaption(e, unit), value: e.listenTimeInMinutes || e.playCount }));

/** Everything the Replay body shows, and the catalog items behind each ranked list (for taps). */
export function replayBody(input: BodyInput) {
  const { mode, unit } = input;
  const lists: Lists = {};
  const base = { ...emptyBody };
  let id = '';
  let hero: { caption: string; value: number; unit: string; note?: string };
  let more: Partial<typeof emptyBody> & Record<string, unknown> = {};
  let barsCaption = '';

  if (mode === 'all' && input.all) {
    const a = input.all;
    id = 'all';
    const t = heroTime(a.minutes, unit);
    hero = {
      caption: `REPLAY · ${a.firstYear || ''}${a.years.length > 1 ? ` – ${a.years[a.years.length - 1].summary.year}` : ''}`,
      value: t.value,
      unit: t.unit,
    };
    const yearsNote = a.years.some((y) => !hasTotals(y.summary)) ? ' The current year is added up from its months.' : '';
    hero.note = `Every year of your Replay added together.${yearsNote}`;
    const average = a.years.length ? a.minutes / a.years.length : 0;
    const highlights = [
      a.bestYear && { icon: 'trophy', text: `Best year: ${a.bestYear.summary.year} — ${formatMinutes(a.bestYear.minutes, unit)}` },
      a.busiestMonth && {
        icon: 'flame',
        text: `Busiest month: ${a.busiestMonth.name} ${a.busiestMonth.year} — ${formatMinutes(a.busiestMonth.listenTimeInMinutes, unit)}`,
      },
      average > 0 && { icon: 'chart-no-axes-column', text: `${formatMinutes(average, unit)} a year on average` },
    ].filter(Boolean) as { icon: string; text: string }[];
    lists.artists = itemsOf(a.artists);
    lists.songs = itemsOf(a.songs);
    lists.albums = itemsOf(a.albums);
    lists.playlists = itemsOf(a.playlists);
    lists.stations = itemsOf(a.stations);
    barsCaption = a.bestYear ? `Best year: ${a.bestYear.summary.year} — ${formatMinutes(a.bestYear.minutes, unit)}` : '';
    more = {
      hasCounts: true,
      counts: [
        { icon: 'calendar', label: 'years of Replay', value: a.years.length },
        { icon: 'medal', label: 'milestones', value: a.milestones.length },
      ],
      hasHighlights: highlights.length > 0,
      highlights,
      hasBars: a.years.length > 1,
      barsKind: 'year',
      barsTitle: 'Year by year',
      barsCaption,
      bars: a.years.map((y) => ({
        id: y.summary.id,
        label: `${y.summary.year}`.slice(2),
        tooltip: `${y.summary.year}: ${formatMinutes(y.minutes, unit)}`,
        value: y.minutes,
      })),
      hasNote: true,
      noteTitle: 'Built from each year’s top lists',
      noteText:
        'Apple has no all-time Replay. Totals add up every year; rankings add each year’s top 100, so something that never made a year’s list isn’t counted.',
      hasArtists: a.artists.length > 0,
      artists: railCards(a.artists, unit),
      hasSongs: a.songs.length > 0,
      songs: songRows(a.songs, unit),
      songsTitle: 'Top songs, all time',
      hasAlbums: a.albums.length > 0,
      albums: railCards(a.albums, unit),
      hasGenres: a.genres.length > 0,
      genres: genreRows(a.genres, unit),
      hasPlaylists: a.playlists.length > 0,
      playlists: railCards(a.playlists, unit),
      hasStations: a.stations.length > 0,
      stations: railCards(a.stations, unit),
      hasMilestones: a.milestones.length > 0,
      milestones: milestoneCards(a),
    };
  } else {
    const s = input.summary as Summary;
    const months = input.months;
    id = s.id;
    const month = s.period === 'month';
    const monthsTotal = months.reduce((sum, m) => sum + m.listenTimeInMinutes, 0);
    const derived = !month && !hasTotals(s) && monthsTotal > 0;
    const pending = !!input.pending && month;
    const minutes = pending ? (input.detail.stats?.listenedMs ?? 0) / 60000 : month || hasTotals(s) ? s.listenTimeInMinutes : monthsTotal;
    const t = heroTime(minutes, unit);
    const prev = month && !pending ? months.find((m) => m.month === s.month - 1) : undefined;
    const change =
      prev && prev.listenTimeInMinutes > 0 && minutes > 0 ? Math.round(((minutes - prev.listenTimeInMinutes) / prev.listenTimeInMinutes) * 100) : null;
    hero = {
      caption: month ? `${s.name} ${s.year}`.toUpperCase() : `REPLAY ${s.name}`,
      value: t.value,
      unit: t.unit,
      ...(pending
        ? { note: 'Apple publishes a month once it is over. This is the Apple Music listening Elbert logged.' }
        : derived
          ? { note: "Added up from this year's months — Apple only finalises a year's own total once the year is over." }
          : minutes === 0
            ? { note: "Apple hasn't published a total for this period yet." }
            : change !== null && prev
              ? { note: `${change >= 0 ? '+' : ''}${change}% on ${prev.name} (${formatMinutes(prev.listenTimeInMinutes, unit)})` }
              : {}),
    };
    const counts = [
      { icon: 'music', label: 'songs', value: s.uniqueSongCount },
      { icon: 'user-round', label: 'artists', value: s.uniqueArtistCount },
      { icon: 'disc-3', label: 'albums', value: s.uniqueAlbumCount },
      { icon: 'tags', label: 'genres', value: s.uniqueGenreCount },
    ].filter((c) => c.value > 0);
    const busiest = months.reduce<Summary | null>((best, m) => (!best || m.listenTimeInMinutes > best.listenTimeInMinutes ? m : best), null);
    lists.artists = itemsOf(s.topArtists);
    lists.songs = itemsOf(s.topSongs);
    lists.albums = itemsOf(s.topAlbums);
    lists.playlists = itemsOf(s.topPlaylists);
    lists.stations = itemsOf(s.topStations);
    barsCaption = busiest ? `Busiest month: ${busiest.name} — ${formatMinutes(busiest.listenTimeInMinutes, unit)}` : '';
    more = {
      hasCounts: counts.length > 0,
      counts,
      hasPlaylist: !month && !!s.playlistId,
      playlistName: s.playlistName || `Replay ${s.year}`,
      hasBars: !month && months.length > 1,
      barsKind: 'month',
      barsTitle: 'Month by month',
      barsCaption,
      bars: months.map((m) => ({
        id: m.id,
        label: m.name.slice(0, 1),
        tooltip: `${m.name}: ${formatMinutes(m.listenTimeInMinutes, unit)}`,
        value: m.listenTimeInMinutes,
      })),
      hasNote: month && !pending && s.topSongs.length === 0,
      noteTitle: 'Apple only ranks by year',
      noteText:
        'A month gets its own listening time, counts and milestones from Apple. Its top artists, albums and songs below come from the Apple Music plays Elbert has logged.',
      hasSongsNote: !month && !hasTotals(s) && s.topSongs.length > 0,
      songsNote: snapshotNote(s),
      hasArtists: s.topArtists.length > 0,
      artists: railCards(s.topArtists, unit),
      hasSongs: s.topSongs.length > 0,
      songs: songRows(s.topSongs, unit),
      hasAlbums: s.topAlbums.length > 0,
      albums: railCards(s.topAlbums, unit),
      hasGenres: s.topGenres.length > 0,
      genres: genreRows(s.topGenres, unit),
      hasPlaylists: s.topPlaylists.length > 0,
      playlists: railCards(s.topPlaylists, unit),
      hasStations: s.topStations.length > 0,
      stations: railCards(s.topStations, unit),
      hasMilestones: s.milestones.length > 0,
      milestones: milestoneCards(s),
    };
  }

  const detail = detailBody(input.detail, unit, lists, mode === 'month' ? 'By day' : mode === 'year' ? 'By month' : 'By year');
  return { body: { summaryId: id, mode, hero, ...base, ...more, ...detail }, lists };
}

/** The entry a body event names (`rail` + `index`). */
function itemFor(lists: Lists | undefined, rail: string, index: number): Item | undefined {
  return lists?.[rail]?.[index];
}

// ---- The page ---------------------------------------------------------------------------

interface State {
  mode: Mode;
  years: Summary[];
  year: string;
  /** The selected year's months that have any listening (the month picker). */
  months: Summary[];
  /** All twelve, for the year's chart. */
  allMonths: Summary[];
  /** Months only Elbert's history has so far (Apple publishes a month once it is over). */
  pending: string[];
  month: string;
  seq: number;
  summary?: Summary;
  all?: AllTime;
  detail: DetailInput;
  lists?: Lists;
}

const NO_DETAIL: DetailInput = { stats: null, available: false, art: new ArtIndex(), scope: '' };

/** `history.stats`, on an Elbert that has it. */
const hostHistoryStats = () => (typeof elbert.history?.stats === 'function' ? elbert.history.stats.bind(elbert.history) : null);

async function historyStats(period: string): Promise<HistoryStats | null> {
  const stats = hostHistoryStats();
  if (!stats) return null;
  try {
    return ((await stats({ period, provider: IMPORT_PROVIDER })) as HistoryStats | null) ?? null;
  } catch (e) {
    console.debug(`history.stats(${period}) failed: ${errorText(e)}`);
    return null;
  }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The year's months that only Elbert's history has, as stand-in summaries (no Apple totals). */
async function elbertMonths(year: number): Promise<Summary[]> {
  const periods = typeof elbert.history?.periods === 'function' ? await elbert.history.periods({ provider: IMPORT_PROVIDER }).catch(() => null) : null;
  const y = periods?.years.find((p) => p.year === year);
  return (y?.months ?? [])
    .filter((m) => m.listenedMs > 0)
    .map((m) => ({
      id: `month-${year}-${m.month}`,
      period: 'month',
      name: MONTH_NAMES[m.month - 1],
      year,
      month: m.month,
      listenTimeInMinutes: 0,
      uniqueSongCount: 0,
      uniqueAlbumCount: 0,
      uniqueArtistCount: 0,
      uniqueGenreCount: 0,
      topSongs: [],
      topAlbums: [],
      topArtists: [],
      topGenres: [],
      topPlaylists: [],
      topStations: [],
      milestones: [],
    }));
}

const yearOf = (id: string) => Number(/^(?:year|month)-(\d{4})/.exec(id)?.[1] ?? 0);

function chrome(s: State) {
  const showMonths = s.mode === 'month';
  return {
    mode: s.mode,
    years: s.years.map((y) => ({ id: y.id, label: y.name })),
    selected: s.year,
    hasYears: s.mode !== 'all',
    hasMonthPicker: showMonths && s.months.length > 0,
    monthOptions: s.months.map((m) => ({ id: m.id, label: m.name.slice(0, 3) })),
    selectedMonth: s.month,
    hasWrapped: hasHostStats() && s.mode !== 'month',
    wrappedLabel: s.mode === 'all' ? 'All-time Wrapped' : `${s.years.find((y) => y.id === s.year)?.name ?? ''} Wrapped`.trim(),
  };
}

function render(page: Page<PageData, State>) {
  const s = page.state;
  const unit = timeUnit();
  if (s.mode === 'all' ? !s.all : !s.summary) return;
  const { body, lists } = replayBody({
    mode: s.mode,
    summary: s.summary,
    months: s.allMonths,
    pending: s.pending.includes(s.month),
    all: s.all,
    detail: s.detail,
    unit,
  });
  s.lists = lists;
  update(page, { ...chrome(s), unit, bodyStatus: 'ready', body });
}

async function load(page: Page<PageData, State>, force = false) {
  const s = page.state;
  const seq = ++s.seq;
  const stale = () => seq !== s.seq;
  update(page, { ...chrome(s), bodyStatus: 'loading' });
  try {
    if (s.mode === 'all') {
      if (force) invalidate('replay:');
      const { all, art } = await loadAllTime(s.years);
      const stats = await historyStats('all');
      if (stale()) return;
      s.all = all;
      s.detail = { stats, available: !!hostHistoryStats(), art, scope: 'any year' };
    } else {
      const year = s.years.find((y) => y.id === s.year) ?? s.years[0];
      if (!year) return;
      s.year = year.id;
      if (force) {
        invalidate(`replay:${year.id}`);
        invalidate(`replay:months:${year.year}`);
        invalidate(`replay:${s.month}`);
      }
      const [yearSummary, allMonths] = await Promise.all([replay(year.id), monthsOf(year.year)]);
      if (stale()) return;
      s.allMonths = allMonths;
      const apple = withListening(allMonths);
      const elbert = await elbertMonths(year.year);
      if (stale()) return;
      const months = [...apple, ...elbert.filter((m) => !apple.some((a) => a.month === m.month))].sort((a, b) => a.month - b.month);
      s.pending = months.filter((m) => !apple.includes(m)).map((m) => m.id);
      s.months = months;
      const art = new ArtIndex().add(yearSummary);
      if (s.mode === 'month') {
        if (!months.some((m) => m.id === s.month)) s.month = months[months.length - 1]?.id ?? '';
        const picked = months.find((m) => m.id === s.month);
        if (!picked) {
          s.summary = undefined;
          update(page, { ...chrome(s), bodyStatus: 'error', bodyError: `Apple has no listening for ${year.name}.` });
          return;
        }
        update(page, { ...chrome(s), bodyStatus: 'loading' });
        const [summary, stats] = await Promise.all([s.pending.includes(picked.id) ? picked : replay(picked.id), historyStats(picked.id)]);
        if (stale()) return;
        s.summary = summary;
        s.detail = { stats, available: !!hostHistoryStats(), art, scope: `${picked.name} ${picked.year}` };
      } else {
        const stats = await historyStats(year.id);
        if (stale()) return;
        s.summary = yearSummary;
        s.detail = { stats, available: !!hostHistoryStats(), art, scope: year.name };
      }
    }
    render(page);
  } catch (e) {
    if (!stale()) update(page, { ...chrome(s), bodyStatus: 'error', bodyError: errorText(e) });
  }
}

definePage<PageData, State>('replay', {
  open(page) {
    const s = page.state;
    s.years = [];
    s.months = [];
    s.allMonths = [];
    s.pending = [];
    s.seq = 0;
    s.mode = 'year';
    s.year = '';
    s.month = '';
    s.detail = NO_DETAIL;
    onClose(
      page,
      onTimeUnitChange(() => render(page)),
    );
    void (async () => {
      try {
        const index = await replayYears();
        s.years = index.summaries.filter((y) => y.period === 'year');
        if (!s.years.length) {
          update(page, { status: 'empty' });
          return;
        }
        // `/replay/:id` opens straight onto a year or a month.
        const id = page.params?.id;
        if (id?.startsWith('month-')) {
          const y = s.years.find((y) => y.year === yearOf(id));
          if (y) {
            s.mode = 'month';
            s.year = y.id;
            s.month = id;
          }
        } else if (id?.startsWith('year-') && s.years.some((y) => y.id === id)) {
          s.year = id;
        }
        s.year ||= s.years[0].id;
        update(page, { status: 'ready', ...chrome(s), units: TIME_UNITS, unit: timeUnit(), modes: MODES });
        await load(page);
      } catch (e) {
        update(page, { status: 'error', error: errorText(e) });
      }
    })();
    return {
      ...sectionChrome(page, `${SECTION}/replay`),
      status: 'loading',
      years: [],
      bodyStatus: 'loading',
      modes: MODES,
      units: TIME_UNITS,
      unit: timeUnit(),
      mode: 'year',
    };
  },
  events: {
    open(page, { rail, index }) {
      const item = itemFor(page.state.lists, String(rail), Number(index));
      if (item) return openItem(item);
    },
    playlist(page) {
      const id = page.state.summary?.playlistId;
      if (id) return elbert.ui.navigate(routes.playlist(id));
    },
    select(page, { id }) {
      page.state.year = String(id);
      page.state.month = '';
      return load(page);
    },
    selectMonth(page, { id }) {
      page.state.month = String(id);
      return load(page);
    },
    setMode(page, { id }) {
      if (id !== 'year' && id !== 'month' && id !== 'all') return;
      if (page.state.mode === id) return;
      page.state.mode = id;
      if (id === 'month') page.state.month = '';
      return load(page);
    },
    setUnit(_page, { id }) {
      return setTimeUnit(id as TimeUnit);
    },
    /** A bar: a month in a year's chart, or a year in the all-time chart. */
    bar(page, { id }) {
      const key = String(id ?? '');
      if (page.state.mode === 'all' && key.startsWith('year-')) {
        page.state.mode = 'year';
        page.state.year = key;
        return load(page);
      }
      if (key.startsWith('month-')) {
        page.state.mode = 'month';
        page.state.month = key;
        return load(page);
      }
    },
    wrapped(page) {
      const s = page.state;
      return elbert.ui.navigate(s.mode === 'all' ? routes.wrapped('all') : routes.wrapped(String(yearOf(s.year))));
    },
    importPlays() {
      return elbert.ui.navigate(`${SECTION}/settings`);
    },
    refresh(page) {
      return load(page, true);
    },
  },
});
