// Replay's arithmetic: the hours/minutes unit, all-time folding, the Wrapped
// slides and the "In Elbert" rows. Run with `bun test`.

import { expect, test } from 'bun:test';
import type { Item, Milestone, Summary, SummaryEntry } from '../src/orchard/client';
import { buildAllTime, mergeEntries, yearMinutes } from '../src/replay/alltime';
import { ArtIndex, detailBars, detailRows, type HistoryStats, mergeTracks } from '../src/replay/detail';
import { buildAllTimeStory, buildYearStory, dayCaption, estimatedMinutes } from '../src/replay/story';
import { formatMinutes, heroTime, storyTime } from '../src/replay/time';

const item = (id: string, name: string, artist = 'A', type = 'songs', durationMs = 180_000): Item => ({ id, type, name, artistName: artist, durationMs });
const entry = (name: string, playCount: number, minutes = 0, it?: Item): SummaryEntry => ({ name, playCount, listenTimeInMinutes: minutes, item: it });
const summary = (o: Partial<Summary>): Summary => ({
  id: 'year-2025',
  period: 'year',
  name: '2025',
  year: 2025,
  month: 0,
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
  ...o,
});

// ---- Units ----------------------------------------------------------------------------

test('hours and minutes are the same duration written two ways', () => {
  expect(formatMinutes(24750, 'minutes')).toBe('24,750 min');
  expect(formatMinutes(24750, 'hours')).toBe('412.5 hr');
  expect(formatMinutes(120, 'hours')).toBe('2 hr');
  expect(formatMinutes(45, 'hours')).toBe('0.8 hr');
  expect(formatMinutes(372, 'auto')).toBe('6 hr 12 min');
});

test('the hero counts hours or minutes, whole', () => {
  expect(heroTime(24750, 'hours')).toEqual({ value: 412, unit: 'hours of music' });
  expect(heroTime(24750, 'minutes')).toEqual({ value: 24750, unit: 'minutes of music' });
  expect(heroTime(61, 'auto')).toEqual({ value: 1, unit: 'hour of music' });
  expect(heroTime(40, 'auto')).toEqual({ value: 40, unit: 'minutes of music' });
  expect(heroTime(40, 'hours')).toEqual({ value: 0, unit: 'hours of music' });
  expect(storyTime(120, 'minutes')).toEqual({ value: 120, noun: 'minutes' });
});

// ---- All time -------------------------------------------------------------------------

test('a year in progress adds up its months', () => {
  const months = [summary({ period: 'month', listenTimeInMinutes: 100 }), summary({ period: 'month', listenTimeInMinutes: 50 })];
  expect(yearMinutes(summary({}), months)).toBe(150);
  expect(yearMinutes(summary({ listenTimeInMinutes: 900 }), months)).toBe(900);
});

test('the same artist across years is one row, summed', () => {
  const a = item('1', 'Artist', '', 'artists');
  const merged = mergeEntries([[entry('Artist', 10, 100, a), entry('Other', 1, 10)], [entry('Artist', 5, 60, a)]]);
  expect(merged[0]).toMatchObject({ name: 'Artist', playCount: 15, listenTimeInMinutes: 160 });
  expect(merged).toHaveLength(2);
});

test('songs rank by plays since Apple gives them no minutes', () => {
  const all = buildAllTime([
    { summary: summary({ year: 2024, topSongs: [entry('Old', 30, 0, item('o', 'Old'))], listenTimeInMinutes: 600 }), months: [] },
    {
      summary: summary({ year: 2025, topSongs: [entry('Old', 40, 0, item('o', 'Old')), entry('New', 60, 0, item('n', 'New'))], listenTimeInMinutes: 900 }),
      months: [],
    },
  ]);
  expect(all.songs.map((s) => [s.name, s.playCount])).toEqual([
    ['Old', 70],
    ['New', 60],
  ]);
  expect(all.minutes).toBe(1500);
  expect(all.bestYear?.summary.year).toBe(2025);
  expect(all.firstYear).toBe(2024);
});

test('a milestone reached in two years counts once, earliest kept', () => {
  const m = (date: string): Milestone => ({
    id: date,
    kind: 'listen-time',
    value: '10000',
    dateReached: date,
    listenTimeInMinutes: 10000,
    artworkLight: '',
    artworkDark: '',
  });
  const all = buildAllTime([
    { summary: summary({ year: 2024, listenTimeInMinutes: 5, milestones: [m('2024-05-01')] }), months: [] },
    { summary: summary({ year: 2025, listenTimeInMinutes: 5, milestones: [m('2025-02-01')] }), months: [] },
  ]);
  expect(all.milestones.map((x) => x.dateReached)).toEqual(['2024-05-01']);
});

// ---- Wrapped --------------------------------------------------------------------------

const rich = summary({
  year: 2026,
  listenTimeInMinutes: 24750,
  uniqueSongCount: 1000,
  uniqueArtistCount: 200,
  topSongs: [entry('Top', 99, 0, item('s1', 'Top', 'Band', 'songs', 200_000)), entry('Second', 80, 0, item('s2', 'Second'))],
  topArtists: [entry('Band', 120, 1500, item('a1', 'Band', '', 'artists')), entry('Duo', 10, 90, item('a2', 'Duo', '', 'artists'))],
  topAlbums: [entry('LP', 50, 700, item('b1', 'LP', 'Band', 'albums'))],
  topGenres: [entry('Pop', 0, 900)],
  playlistId: 'pl.rp-1',
});
const months = [1, 2, 3].map((m) =>
  summary({ period: 'month', id: `month-2026-${m}`, name: ['January', 'February', 'March'][m - 1], month: m, listenTimeInMinutes: m * 100 }),
);

test('the year story tells the numbers in the chosen unit', () => {
  const story = buildYearStory(rich, months, 'hours');
  const kinds = story.slides.map((s) => s.kind);
  expect(kinds).toEqual(['intro', 'time', 'counts', 'topSong', 'songs', 'topArtist', 'artists', 'albums', 'genres', 'months', 'outro']);
  expect(story.slides[1]).toMatchObject({ value: 412, noun: 'hours' });
  expect(buildYearStory(rich, months, 'minutes').slides[1]).toMatchObject({ value: 24750, noun: 'minutes' });
  const top = story.slides[3];
  expect(top).toMatchObject({ title: 'Top', plays: 99, subtitle: 'Band' });
  expect(story.items.topSong?.[0]?.id).toBe('s1');
  expect(story.items.songs?.map((i) => i?.id)).toEqual(['s1', 's2']);
  expect(story.slides[9]).toMatchObject({ lead: 'March' });
  expect(story.playlistId).toBe('pl.rp-1');
});

test('a year with nothing in it still tells a short story, with no empty slides', () => {
  const kinds = buildYearStory(summary({ year: 2026 }), [], 'auto').slides.map((s) => s.kind);
  expect(kinds).toEqual(['intro', 'outro']);
});

test('no slide carries a null, which the host would strip', () => {
  const json = JSON.stringify(buildYearStory(rich, months, 'auto').slides);
  expect(json).not.toContain(':null');
});

test('all time becomes a year-by-year story', () => {
  const all = buildAllTime([
    { summary: rich, months },
    { summary: summary({ year: 2025, listenTimeInMinutes: 6000 }), months: [] },
  ]);
  const story = buildAllTimeStory(all, 'hours');
  expect(story.slides.find((s) => s.kind === 'months')).toMatchObject({ heading: 'Year by year', lead: '2026' });
});

test('a song’s minutes are plays times its length', () => {
  expect(estimatedMinutes(entry('x', 99, 0, item('1', 'x', 'A', 'songs', 200_000)))).toBeCloseTo(330);
  expect(estimatedMinutes(entry('x', 99))).toBe(0);
});

test('time is pictured in days only when it is days', () => {
  expect(dayCaption(60 * 24 * 12)).toContain('12 days');
  expect(dayCaption(30)).toBe('');
});

// ---- In Elbert ------------------------------------------------------------------------

const stats: HistoryStats = {
  listenedMs: 7_200_000,
  plays: 30,
  topArtists: [{ name: 'Band', listenedMs: 3_600_000, plays: 12 }],
  topAlbums: [{ name: 'LP', artist: 'Band', listenedMs: 3_000_000, plays: 10 }],
  topTracks: [
    { title: 'Top', artist: 'Band', album: 'LP', listenedMs: 1_200_000, plays: 6 },
    { title: 'Unknown', artist: 'Nobody', listenedMs: 60_000, plays: 1 },
  ],
  buckets: [
    { label: '1', listenedMs: 600_000, plays: 3 },
    { label: '2', listenedMs: 0, plays: 0 },
  ],
};

test('Elbert’s rows borrow Apple’s catalog item by name, and only tap when found', () => {
  const art = new ArtIndex().add(rich);
  const { rows, items } = detailRows(stats, art, 'minutes');
  expect(rows.songs[0]).toMatchObject({ title: 'Top', id: 's1', disabled: false, caption: '20 min · 6 plays' });
  expect(rows.songs[1]).toMatchObject({ title: 'Unknown', id: '', disabled: true, caption: '1 min · 1 play' });
  expect(rows.artists[0]).toMatchObject({ id: 'a1', caption: '60 min · 12 plays' });
  expect(items.albums[0]?.id).toBe('b1');
});

test('the day chart is in minutes whatever the unit, labelled in it', () => {
  expect(detailBars(stats, 'hours', 'd')[0]).toMatchObject({ id: 'd0', label: '1', value: 10, tooltip: '1: 0.2 hr' });
});

test('a song streamed and downloaded is one row', () => {
  const merged = mergeTracks([
    { title: 'Top', artist: 'Band', listenedMs: 60_000, plays: 1 },
    { title: 'Other', artist: 'Band', listenedMs: 90_000, plays: 1 },
    { title: 'top', artist: 'BAND', listenedMs: 60_000, plays: 2 },
  ]);
  expect(merged.map((t) => [t.title, t.listenedMs, t.plays])).toEqual([
    ['Top', 120_000, 3],
    ['Other', 90_000, 1],
  ]);
});
