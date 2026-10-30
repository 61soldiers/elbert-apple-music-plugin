// "In Elbert": the month/year/all-time detail Apple does not rank. Apple only
// ranks whole years, so a month's top artists, albums and songs — with the
// minutes spent on each — come from Elbert's own listening history, filtered
// to Apple Music plays (streamed here, plus those imported from Apple's
// privacy export). Elbert computes them (`history.stats`); this only dresses
// them for the page, borrowing artwork from Apple's year rankings by name.

import type { Item, Summary } from '../orchard/client';
import { sizedArtwork } from '../orchard/client';
import { formatMinutes, type TimeUnit } from './time';

/** What `elbert.history.stats` returns (the parts used here). */
export interface HistoryStats {
  listenedMs: number;
  plays: number;
  uniqueTracks?: number;
  uniqueArtists?: number;
  uniqueAlbums?: number;
  topArtists: { name: string; listenedMs: number; plays: number }[];
  topAlbums: { name: string; artist?: string; listenedMs: number; plays: number }[];
  topTracks: { title: string; artist?: string; album?: string; listenedMs: number; plays: number }[];
  buckets?: { label: string; startMs?: number; listenedMs: number; plays: number }[];
}

const norm = (s: string | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Finds Apple's artwork and catalog item for a name Elbert logged. */
export class ArtIndex {
  private songs = new Map<string, Item>();
  private albums = new Map<string, Item>();
  private artists = new Map<string, Item>();

  add(s: Summary) {
    for (const e of s.topSongs) if (e.item) this.songs.set(`${norm(e.item.name)}|${norm(e.item.artistName)}`, e.item);
    for (const e of s.topAlbums) if (e.item) this.albums.set(`${norm(e.item.name)}|${norm(e.item.artistName)}`, e.item);
    for (const e of s.topArtists) if (e.item) this.artists.set(norm(e.item.name), e.item);
    return this;
  }

  song = (title: string, artist?: string) => this.songs.get(`${norm(title)}|${norm(artist)}`);
  album = (name: string, artist?: string) => this.albums.get(`${norm(name)}|${norm(artist)}`);
  artist = (name: string) => this.artists.get(norm(name));
}

export type DetailRail = 'songs' | 'albums' | 'artists';

export interface DetailRow {
  id: string;
  title: string;
  subtitle: string;
  cover: string;
  caption: string;
  disabled: boolean;
}

const minutesOf = (ms: number) => ms / 60000;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const caption = (ms: number, plays: number, unit: TimeUnit) => `${formatMinutes(minutesOf(ms), unit)} · ${plural(plays, 'play')}`;

function row(item: Item | undefined, title: string, subtitle: string, cap: string): DetailRow {
  return { id: item?.id ?? '', title, subtitle, cover: item ? (sizedArtwork(item.artwork, 96) ?? '') : '', caption: cap, disabled: !item };
}

/**
 * A song streamed (`applemusic-stream:`) and the same song downloaded
 * (`applemusic:`) are two rows to Elbert; to a listener they are one song.
 */
export function mergeTracks(tracks: HistoryStats['topTracks']): HistoryStats['topTracks'] {
  const merged = new Map<string, HistoryStats['topTracks'][number]>();
  for (const t of tracks) {
    const key = `${norm(t.title)}|${norm(t.artist)}`;
    const have = merged.get(key);
    if (have) {
      have.listenedMs += t.listenedMs;
      have.plays += t.plays;
    } else {
      merged.set(key, { ...t });
    }
  }
  return [...merged.values()].sort((a, b) => b.listenedMs - a.listenedMs);
}

/** The rows the page draws, and the catalog items behind them (same order) for taps. */
export function detailRows(stats: HistoryStats, art: ArtIndex, unit: TimeUnit, limit = 10) {
  const items: Record<DetailRail, (Item | undefined)[]> = { songs: [], albums: [], artists: [] };
  const songs = mergeTracks(stats.topTracks)
    .slice(0, limit)
    .map((t) => {
      const item = art.song(t.title, t.artist);
      items.songs.push(item);
      return row(item, t.title, [t.artist, t.album].filter(Boolean).join(' · '), caption(t.listenedMs, t.plays, unit));
    });
  const albums = stats.topAlbums.slice(0, limit).map((a) => {
    const item = art.album(a.name, a.artist);
    items.albums.push(item);
    return row(item, a.name, a.artist ?? '', caption(a.listenedMs, a.plays, unit));
  });
  const artists = stats.topArtists.slice(0, limit).map((a) => {
    const item = art.artist(a.name);
    items.artists.push(item);
    return row(item, a.name, '', caption(a.listenedMs, a.plays, unit));
  });
  return { rows: { songs, albums, artists }, items };
}

/** Chart bars from the host's buckets (days of a month, months of a year, years). */
export function detailBars(stats: HistoryStats, unit: TimeUnit, idPrefix: string) {
  return (stats.buckets ?? []).map((b, i) => ({
    id: `${idPrefix}${i}`,
    label: b.label,
    tooltip: `${b.label}: ${formatMinutes(minutesOf(b.listenedMs), unit)}`,
    value: minutesOf(b.listenedMs),
  }));
}

export function detailHero(stats: HistoryStats, unit: TimeUnit) {
  return {
    listened: formatMinutes(minutesOf(stats.listenedMs), unit),
    plays: plural(stats.plays, 'play'),
    tracks: stats.uniqueTracks ?? 0,
  };
}
