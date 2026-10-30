// All time: Apple has no "ever" summary, only one per year, so this folds the
// years together. Totals add exactly; rankings are built from each year's
// own top list, so a song that never made a year's top 100 is not counted —
// the page says so.

import type { Milestone, Summary, SummaryEntry } from '../orchard/client';

export interface YearTotal {
  summary: Summary;
  months: Summary[];
  /** Apple's year total, or the months added up while the year is in progress. */
  minutes: number;
}

export interface AllTime {
  minutes: number;
  years: YearTotal[];
  firstYear: number;
  bestYear?: YearTotal;
  busiestMonth?: Summary;
  artists: SummaryEntry[];
  albums: SummaryEntry[];
  songs: SummaryEntry[];
  genres: SummaryEntry[];
  playlists: SummaryEntry[];
  stations: SummaryEntry[];
  milestones: Milestone[];
}

const TOP = 25;

/** Apple's total for a year, or its months added up when Apple hasn't finalised it. */
export const yearMinutes = (year: Summary, months: Summary[]) =>
  year.listenTimeInMinutes > 0 ? year.listenTimeInMinutes : months.reduce((sum, m) => sum + m.listenTimeInMinutes, 0);

const keyOf = (e: SummaryEntry) => (e.item ? `${e.item.type}:${e.item.id}` : `name:${e.name.toLowerCase()}`);

const earlier = (a?: string, b?: string) => (!a ? b : !b ? a : a < b ? a : b);
const later = (a?: string, b?: string) => (!a ? b : !b ? a : a > b ? a : b);

/** Adds the same ranked thing across lists; the biggest first. */
export function mergeEntries(lists: SummaryEntry[][], limit = TOP): SummaryEntry[] {
  const merged = new Map<string, SummaryEntry>();
  for (const list of lists) {
    for (const e of list) {
      const key = keyOf(e);
      const have = merged.get(key);
      if (!have) {
        merged.set(key, { ...e });
        continue;
      }
      have.playCount += e.playCount;
      have.listenTimeInMinutes += e.listenTimeInMinutes;
      have.firstPlayed = earlier(have.firstPlayed, e.firstPlayed);
      have.lastPlayed = later(have.lastPlayed, e.lastPlayed);
      have.item ??= e.item;
    }
  }
  return [...merged.values()].sort((a, b) => b.listenTimeInMinutes - a.listenTimeInMinutes || b.playCount - a.playCount).slice(0, limit);
}

/** Songs carry plays but no minutes, so they rank by plays. */
function mergeSongs(lists: SummaryEntry[][]): SummaryEntry[] {
  return mergeEntries(lists, Number.MAX_SAFE_INTEGER)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, TOP);
}

/** Milestones of the same kind and value are one achievement: keep the earliest. */
function mergeMilestones(years: Summary[]): Milestone[] {
  const seen = new Map<string, Milestone>();
  for (const y of years) {
    for (const m of y.milestones) {
      const key = `${m.kind}:${m.value}`;
      const have = seen.get(key);
      if (!have || (m.dateReached && (!have.dateReached || m.dateReached < have.dateReached))) seen.set(key, m);
    }
  }
  return [...seen.values()].sort((a, b) => (b.dateReached ?? '').localeCompare(a.dateReached ?? ''));
}

export function buildAllTime(input: { summary: Summary; months: Summary[] }[]): AllTime {
  const years: YearTotal[] = input
    .map((y) => ({ ...y, minutes: yearMinutes(y.summary, y.months) }))
    .filter((y) => y.minutes > 0 || y.summary.topSongs.length > 0)
    .sort((a, b) => a.summary.year - b.summary.year);
  const summaries = years.map((y) => y.summary);
  const allMonths = years.flatMap((y) => y.months);
  const bestYear = years.reduce<YearTotal | undefined>((best, y) => (!best || y.minutes > best.minutes ? y : best), undefined);
  const busiestMonth = allMonths.reduce<Summary | undefined>((best, m) => (!best || m.listenTimeInMinutes > best.listenTimeInMinutes ? m : best), undefined);
  return {
    minutes: years.reduce((sum, y) => sum + y.minutes, 0),
    years,
    firstYear: years[0]?.summary.year ?? 0,
    bestYear,
    busiestMonth,
    artists: mergeEntries(summaries.map((s) => s.topArtists)),
    albums: mergeEntries(summaries.map((s) => s.topAlbums)),
    songs: mergeSongs(summaries.map((s) => s.topSongs)),
    genres: mergeEntries(
      summaries.map((s) => s.topGenres),
      10,
    ),
    playlists: mergeEntries(
      summaries.map((s) => s.topPlaylists),
      15,
    ),
    stations: mergeEntries(
      summaries.map((s) => s.topStations),
      15,
    ),
    milestones: mergeMilestones(summaries),
  };
}
