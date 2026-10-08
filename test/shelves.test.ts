// Home's shelf order, against the group titles seen on a real account.
// Run with `bun test`.

import { expect, test } from 'bun:test';
import type { Item, RecommendationGroup, Summary, SummaryIndex } from '../src/orchard/client';
import { buildShelves, RECENT_KEY, replayCard, shelfData, shelfItem } from '../src/shelves';

const item = (id: string, type = 'albums', name = id): Item => ({ id, type, name, durationMs: 0 });
const group = (id: string, title: string, items: Item[], reason?: string): RecommendationGroup => ({ id, title, items, reason });

// Titles and order as returned by /v1/me/recommendations for a real account.
const GROUPS = [
  group('6', 'Playlists Made for You', [item('p1', 'playlists')]),
  group('7', 'Recently Played', [item('rp1', 'playlists')]),
  group('15a', 'More Like Me Again', [item('a1')]),
  group('20', 'Stations for You', [item('s1', 'stations'), item('s2', 'stations')]),
  group('9', 'New Releases for You', [item('n1')]),
  group('15b', 'Acoustic', [item('c1')]),
];

test('well-known shelves come first, the rest keep Apple’s order', () => {
  const keys = buildShelves(GROUPS, [item('r1')]).map((s) => s.key);
  expect(keys).toEqual([RECENT_KEY, '6', '20', '9', '15a', '15b']);
});

test('Recently Played is the fresher call, and never appears twice', () => {
  const shelves = buildShelves(GROUPS, [item('r1')]);
  expect(shelves.filter((s) => s.title === 'Recently Played')).toHaveLength(1);
  expect(shelves[0].items[0].id).toBe('r1');
});

test('Apple’s own Recently Played group stands in when that call is empty', () => {
  const shelves = buildShelves(GROUPS, []);
  expect(shelves.map((s) => s.key).slice(0, 2)).toEqual(['7', '6']);
});

test('Top Picks leads, as feature cards, when Apple sends it', () => {
  const shelves = buildShelves([...GROUPS, group('1', 'Top Picks for You', [item('t1')])], [item('r1')]);
  expect(shelves[0]).toMatchObject({ key: '1', kind: 'feature' });
});

test('station shelves are drawn as stations, whatever their title', () => {
  const shelves = buildShelves([group('x', 'Your Radio', [item('s1', 'stations')])], []);
  expect(shelves[0].kind).toBe('stations');
});

test('empty and duplicate groups are dropped', () => {
  const shelves = buildShelves([group('e', 'Empty', []), group('d', 'Dup', [item('1')]), group('d', 'Dup', [item('2')])], []);
  expect(shelves.map((s) => s.key)).toEqual(['d']);
  expect(shelves[0].items[0].id).toBe('1');
});

test('a shelf is capped, and an untitled one still has a heading', () => {
  const many = Array.from({ length: 50 }, (_, i) => item(`i${i}`));
  const [shelf] = buildShelves([group('m', ' ', many)], []);
  expect(shelf.items).toHaveLength(20);
  expect(shelf.title).toBe('Recommended');
});

test('a tap resolves to the item on the shelf it came from', () => {
  const shelves = buildShelves(GROUPS, [item('r1')]);
  expect(shelfItem(shelves, '20', 1)?.id).toBe('s2');
  expect(shelfItem(shelves, 'nope', 0)).toBeUndefined();
  expect(shelfItem(shelves, '20', 9)).toBeUndefined();
});

test('shelf data has a reason flag, never a null', () => {
  const [plain] = buildShelves([group('a', 'A', [item('1')])], []);
  expect(shelfData(plain)).toMatchObject({ hasReason: false, reason: '' });
  const [reasoned] = buildShelves([group('b', 'B', [item('1')], 'Because you like it')], []);
  expect(shelfData(reasoned)).toMatchObject({ hasReason: true, reason: 'Because you like it' });
});

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
const index = (summaries: Summary[]): SummaryIndex => ({ summaries, latestYear: 0, isEndOfYear: false });

test('Replay card shows the latest finished year’s totals', () => {
  const card = replayCard(
    index([summary({ year: 2024, listenTimeInMinutes: 100 }), summary({ listenTimeInMinutes: 22208, uniqueSongCount: 2003, uniqueArtistCount: 848 })]),
  );
  expect(card).toEqual({ title: 'Replay 2025', hasHeadline: true, headline: '370 hr', subtitle: '2,003 songs · 848 artists' });
});

test('the year in progress is a teaser with no invented numbers', () => {
  const card = replayCard(index([summary({ year: 2026, name: '2026' })]));
  expect(card).toMatchObject({ title: 'Replay 2026', hasHeadline: false, headline: '', subtitle: 'Your year in music, so far' });
});

test('no Replay years, no card', () => {
  expect(replayCard(index([]))).toBeNull();
  expect(replayCard(index([summary({ period: 'month' })]))).toBeNull();
});
