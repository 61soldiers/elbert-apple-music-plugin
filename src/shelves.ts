// Which shelves the Home tab shows and in what order. Pure (no `elbert`
// global), so the ordering is tested directly (test/shelves.test.ts).
//
// Every shelf except Recently Played and Replay is one group of Apple's
// `/v1/me/recommendations` — the MusicKit "Get Recommendations" call, which
// answers with the whole feed in a single request. Titles are Apple's own and
// differ per account ("Acoustic", "More Like <artist>", …), so shelves are
// driven by the data, not a fixed list: the well-known ones are just moved to
// the front.

import { type Card, itemCard, RAIL_PX } from './cards';
import { formatListenMinutes, groupDigits } from './format';
import { type Item, itemSubtitle, type RecommendationGroup, type Summary, type SummaryIndex } from './orchard/client';

/** How a shelf is drawn: big cards, ordinary cards, or the narrower station cards. */
export type ShelfKind = 'feature' | 'rail' | 'stations';

export interface Shelf {
  key: string;
  title: string;
  reason: string;
  kind: ShelfKind;
  items: Item[];
}

/** Apple sends a dozen a shelf; this only guards against a surprise. */
const MAX_ITEMS = 20;

/** Feature cards are drawn ~300 px wide, so 600 covers them at 2×. */
const FEATURE_PX = 600;

export const RECENT_KEY = 'recent';

const recentlyPlayedTitle = /^recently played$/i;

interface Role {
  test: RegExp;
  rank: number;
  kind?: ShelfKind;
}

// Lower ranks first; everything else keeps Apple's order after these.
// Recently Played sits at rank 1.
const ROLES: Role[] = [
  { test: /^top picks/i, rank: 0, kind: 'feature' },
  // The account's own mixes (New Music, Heavy Rotation, Chill…): the shelf
  // most worth a big tile.
  { test: /made for you/i, rank: 2, kind: 'feature' },
  { test: /^stations/i, rank: 3, kind: 'stations' },
  { test: /mood/i, rank: 4 },
  { test: /^new releases/i, rank: 5 },
];
const RECENT_RANK = 1;
const OTHER_RANK = 10;

function roleOf(title: string): Role | undefined {
  return ROLES.find((r) => r.test.test(title));
}

function kindOf(title: string, items: Item[]): ShelfKind {
  const role = roleOf(title);
  if (role?.kind) return role.kind;
  return items.every((i) => i.type === 'stations') ? 'stations' : 'rail';
}

/**
 * The shelves in display order. [recent] is the separate (fresher) Recently
 * Played call; Apple's own Recently Played group is only used when that call
 * came back empty, so the shelf never appears twice.
 */
export function buildShelves(groups: RecommendationGroup[], recent: Item[]): Shelf[] {
  const ranked: { shelf: Shelf; rank: number }[] = [];
  const seen = new Set<string>();

  if (recent.length) {
    ranked.push({ rank: RECENT_RANK, shelf: { key: RECENT_KEY, title: 'Recently Played', reason: '', kind: 'rail', items: recent.slice(0, MAX_ITEMS) } });
  }
  for (const g of groups) {
    const title = g.title.trim();
    const isRecent = recentlyPlayedTitle.test(title);
    if (g.items.length === 0 || (isRecent && recent.length)) continue;
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const items = g.items.slice(0, MAX_ITEMS);
    ranked.push({
      rank: isRecent ? RECENT_RANK : (roleOf(title)?.rank ?? OTHER_RANK),
      shelf: { key: g.id, title: title || 'Recommended', reason: g.reason?.trim() ?? '', kind: kindOf(title, items), items },
    });
  }
  // Array#sort is stable, so equal ranks keep Apple's order.
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.shelf);
}

// ---- Spotlight --------------------------------------------------------------------

/**
 * The "New Music" mix. A recommendation group rarely is one named mix, so this
 * searches item names flattened across every group, not group titles.
 */
export function findNewMusic(groups: RecommendationGroup[]): Item | null {
  const byId = new Map<string, Item>();
  for (const g of groups) for (const it of g.items) if (!byId.has(it.id)) byId.set(it.id, it);
  let loose: Item | null = null;
  for (const it of byId.values()) {
    if (it.type !== 'playlists') continue;
    const name = it.name.toLowerCase();
    if (name === 'new music') return it;
    if (!loose && name.includes('new music')) loose = it;
  }
  return loose;
}

export interface Spotlight {
  item: Item;
  /** The small coloured label over the title. */
  eyebrow: string;
  details: string;
}

/**
 * Home's big card: the weekly New Music mix; failing that, the first of the
 * account's own mixes; failing that, what was played last. Null when there
 * is nothing at all.
 */
export function pickSpotlight(groups: RecommendationGroup[], recent: Item[]): Spotlight | null {
  const newMusic = findNewMusic(groups);
  if (newMusic) {
    return { item: newMusic, eyebrow: 'YOUR WEEKLY MIX', details: itemSubtitle(newMusic) || 'New releases, picked for you' };
  }
  const mixes = groups.find((g) => /made for you/i.test(g.title));
  const mix = mixes?.items.find((i) => i.type === 'playlists') ?? mixes?.items[0];
  if (mix) return { item: mix, eyebrow: 'MADE FOR YOU', details: itemSubtitle(mix) };
  const last = recent[0];
  if (last) return { item: last, eyebrow: 'JUMP BACK IN', details: itemSubtitle(last) };
  return null;
}

/** What the template draws for one shelf. [delay] staggers the first batch's entrance. */
export function shelfData(shelf: Shelf, delay = 0) {
  const px = shelf.kind === 'feature' ? FEATURE_PX : RAIL_PX;
  const items: Card[] = shelf.items.map((i) => itemCard(i, px));
  return { key: shelf.key, title: shelf.title, reason: shelf.reason, hasReason: !!shelf.reason, kind: shelf.kind, delay, items };
}

/** The shelf a tap came from, by the key the template echoed back. */
export function shelfItem(shelves: Shelf[], key: unknown, index: unknown): Item | undefined {
  return shelves.find((s) => s.key === key)?.items[Number(index)];
}

// ---- Replay -----------------------------------------------------------------------

export interface ReplayCard {
  title: string;
  headline: string;
  subtitle: string;
  hasHeadline: boolean;
}

const plural = (n: number, one: string, many: string) => `${groupDigits(n)} ${n === 1 ? one : many}`;

/**
 * The Home card for the latest Replay year. Apple only totals a year once it
 * is over, so the year in progress is a teaser with no numbers (the Replay tab
 * sums its months; Home doesn't spend the extra requests).
 */
export function replayCard(index: SummaryIndex): ReplayCard | null {
  const years = index.summaries.filter((s): s is Summary => s.period === 'year');
  const latest = years.reduce<Summary | null>((best, s) => (!best || s.year > best.year ? s : best), null);
  if (!latest) return null;
  const hasTotals = latest.listenTimeInMinutes > 0;
  const counts = [
    latest.uniqueSongCount > 0 ? plural(latest.uniqueSongCount, 'song', 'songs') : '',
    latest.uniqueArtistCount > 0 ? plural(latest.uniqueArtistCount, 'artist', 'artists') : '',
  ].filter(Boolean);
  return {
    title: `Replay ${latest.year}`,
    headline: hasTotals ? formatListenMinutes(latest.listenTimeInMinutes) : '',
    hasHeadline: hasTotals,
    subtitle: hasTotals ? counts.join(' · ') || 'of music' : 'Your year in music, so far',
  };
}
