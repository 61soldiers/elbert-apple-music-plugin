// The Wrapped story: a year of Apple Replay told as full-screen slides. This
// builds the slides' data (pure, tested); `ui/wrapped.rfwtxt` draws them and
// Elbert's `StoryPager` animates each one as it comes into view.
//
// Every slide carries only what its `kind` needs, never a null, and a slide
// with nothing to say is left out rather than shown empty.

import { groupDigits } from '../format';
import { type Item, itemSubtitle, type Milestone, type Summary, type SummaryEntry, sizedArtwork } from '../orchard/client';
import type { AllTime } from './alltime';
import { formatMinutes, storyTime, type TimeUnit } from './time';

export type SlideKind = 'intro' | 'time' | 'counts' | 'topSong' | 'songs' | 'topArtist' | 'artists' | 'albums' | 'genres' | 'months' | 'milestones' | 'outro';

export interface Slide {
  kind: SlideKind;
  /** Colour roles for the backdrop gradient and the text on it. */
  bg1: string;
  bg2: string;
  fg: string;
  [field: string]: unknown;
}

/** What opens when a ranked row is tapped. */
export interface StoryRef {
  item?: Item;
}

export interface Story {
  slides: Slide[];
  /** `slides[i].refs[j]` → the catalog item, for taps. */
  items: Record<string, (Item | undefined)[]>;
  playlistId?: string;
}

/** Backdrop and text colour roles per slide. Slides holding charts keep to container tones, so the host's own chart text stays readable. */
const PALETTES: Record<SlideKind, [string, string, string]> = {
  intro: ['primary', 'tertiary', 'onPrimary'],
  time: ['tertiary', 'primary', 'onTertiary'],
  counts: ['secondaryContainer', 'surface', 'onSecondaryContainer'],
  topSong: ['primary', 'secondary', 'onPrimary'],
  songs: ['primaryContainer', 'surface', 'onPrimaryContainer'],
  topArtist: ['secondary', 'tertiary', 'onSecondary'],
  artists: ['tertiaryContainer', 'surface', 'onTertiaryContainer'],
  albums: ['secondaryContainer', 'surface', 'onSecondaryContainer'],
  genres: ['primaryContainer', 'surface', 'onPrimaryContainer'],
  months: ['tertiaryContainer', 'surface', 'onTertiaryContainer'],
  milestones: ['secondaryContainer', 'surface', 'onSecondaryContainer'],
  outro: ['primary', 'tertiary', 'onPrimary'],
};

const COVER_PX = 640;
const ROW_PX = 120;

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, one: string, many = `${one}s`) => `${groupDigits(n)} ${n === 1 ? one : many}`;

/** "Mar 3, 2026" from Apple's date, read as a calendar date. */
export function calendarDate(iso: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${MONTH_ABBR[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
}

/** Plays × the song's length: what Apple doesn't give for a song. */
export const estimatedMinutes = (e: SummaryEntry) => (e.item && e.item.durationMs > 0 ? (e.playCount * e.item.durationMs) / 60000 : 0);

/** "nearly 12 days of non-stop music" — a size you can picture. */
export function dayCaption(minutes: number): string {
  const days = minutes / 1440;
  if (days >= 2) return `That's ${Math.round(days)} days of non-stop music.`;
  if (days >= 1) return "That's more than a whole day of non-stop music.";
  const hours = Math.round(minutes / 60);
  return hours >= 2 ? `That's ${hours} hours without a break.` : '';
}

const rankRows = (entries: SummaryEntry[], unit: TimeUnit, songs = false) =>
  entries.map((e, i) => {
    const est = songs ? estimatedMinutes(e) : 0;
    const plays = plural(e.playCount, 'play');
    return {
      rank: `${i + 1}`,
      index: i,
      delayMs: 350 + i * 130,
      title: e.name,
      subtitle: e.item ? itemSubtitle(e.item) : '',
      cover: sizedArtwork(e.item?.artwork, ROW_PX) ?? '',
      caption: songs
        ? est > 0
          ? `${plays} · ≈ ${formatMinutes(est, unit)}`
          : plays
        : e.listenTimeInMinutes > 0
          ? formatMinutes(e.listenTimeInMinutes, unit)
          : plays,
    };
  });

export const milestoneLabel = (m: Milestone) => {
  const n = Number.parseInt(m.value || `${m.listenTimeInMinutes}`, 10);
  const pretty = Number.isFinite(n) && n > 0 ? groupDigits(n) : m.value;
  const noun: Record<string, string> = { 'listen-time': 'minutes', song: 'songs', artist: 'artists', album: 'albums', genre: 'genres' };
  return noun[m.kind] ? `${pretty} ${noun[m.kind]}` : pretty;
};

export const milestoneArt = (template: string) => (template ? template.replace(/\{w\}/g, '256').replace(/\{h\}/g, '256').replace(/\{f\}/g, 'png') : '');

/** The slides for one year (`months` are its monthly summaries, for the busiest-month chart). */
export function buildYearStory(s: Summary, months: Summary[], unit: TimeUnit): Story {
  const monthsTotal = months.reduce((sum, m) => sum + m.listenTimeInMinutes, 0);
  const minutes = s.listenTimeInMinutes > 0 ? s.listenTimeInMinutes : monthsTotal;
  return buildStory({
    title: `${s.year}`,
    label: `Replay ${s.year}`,
    minutes,
    unit,
    counts: [
      { label: 'songs', value: s.uniqueSongCount },
      { label: 'artists', value: s.uniqueArtistCount },
      { label: 'albums', value: s.uniqueAlbumCount },
      { label: 'genres', value: s.uniqueGenreCount },
    ],
    songs: s.topSongs,
    artists: s.topArtists,
    albums: s.topAlbums,
    genres: s.topGenres,
    milestones: s.milestones,
    bars: months.map((m) => ({ label: m.name.slice(0, 3), full: m.name, minutes: m.listenTimeInMinutes })),
    barsTitle: 'Month by month',
    playlistId: s.playlistId,
    inProgress: s.listenTimeInMinutes <= 0,
  });
}

/** The same story told over every year. */
export function buildAllTimeStory(a: AllTime, unit: TimeUnit): Story {
  return buildStory({
    title: 'All time',
    label: 'Replay, all time',
    minutes: a.minutes,
    unit,
    counts: [{ label: 'years of Replay', value: a.years.length }],
    songs: a.songs,
    artists: a.artists,
    albums: a.albums,
    genres: a.genres,
    milestones: a.milestones,
    bars: a.years.map((y) => ({ label: `${y.summary.year}`, full: `${y.summary.year}`, minutes: y.minutes })),
    barsTitle: 'Year by year',
    inProgress: false,
  });
}

interface StoryInput {
  title: string;
  label: string;
  minutes: number;
  unit: TimeUnit;
  counts: { label: string; value: number }[];
  songs: SummaryEntry[];
  artists: SummaryEntry[];
  albums: SummaryEntry[];
  genres: SummaryEntry[];
  milestones: Milestone[];
  bars: { label: string; full: string; minutes: number }[];
  barsTitle: string;
  playlistId?: string;
  inProgress: boolean;
}

function buildStory(i: StoryInput): Story {
  const slides: Slide[] = [];
  const items: Story['items'] = {};
  const add = (kind: SlideKind, fields: Record<string, unknown>) => {
    const [bg1, bg2, fg] = PALETTES[kind];
    slides.push({ kind, bg1, bg2, fg, ...fields });
  };

  add('intro', {
    title: i.title,
    caption: 'YOUR APPLE MUSIC',
    line: i.inProgress ? 'The year so far, in music.' : 'A year of music, told in numbers.',
  });

  if (i.minutes > 0) {
    const t = storyTime(i.minutes, i.unit);
    add('time', { value: t.value, noun: t.noun, line: dayCaption(i.minutes) || 'spent with your music.' });
  }

  const counts = i.counts.filter((c) => c.value > 0);
  if (counts.length) add('counts', { tiles: counts.map((c) => ({ label: c.label, value: c.value })) });

  const topSong = i.songs[0];
  if (topSong) {
    const est = estimatedMinutes(topSong);
    const since = [
      calendarDate(topSong.firstPlayed) && `First played ${calendarDate(topSong.firstPlayed)}`,
      calendarDate(topSong.lastPlayed) && `latest ${calendarDate(topSong.lastPlayed)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    items.topSong = [topSong.item];
    add('topSong', {
      title: topSong.name,
      subtitle: topSong.item ? itemSubtitle(topSong.item) : '',
      cover: sizedArtwork(topSong.item?.artwork, COVER_PX) ?? '',
      plays: topSong.playCount,
      line: est > 0 ? `That's about ${formatMinutes(est, i.unit)} on repeat.` : 'Your most played song.',
      since,
      hasSince: since.length > 0,
    });
  }
  if (i.songs.length > 1) {
    const list = i.songs.slice(0, 5);
    items.songs = list.map((e) => e.item);
    add('songs', { heading: 'Your top songs', rows: rankRows(list, i.unit, true) });
  }

  const topArtist = i.artists[0];
  if (topArtist) {
    items.topArtist = [topArtist.item];
    add('topArtist', {
      title: topArtist.name,
      cover: sizedArtwork(topArtist.item?.artwork, COVER_PX) ?? '',
      caption: topArtist.listenTimeInMinutes > 0 ? formatMinutes(topArtist.listenTimeInMinutes, i.unit) : `${plural(topArtist.playCount, 'play')}`,
      line: 'was the artist you spent the most time with.',
    });
  }
  if (i.artists.length > 1) {
    const list = i.artists.slice(0, 5);
    items.artists = list.map((e) => e.item);
    add('artists', { heading: 'Your top artists', rows: rankRows(list, i.unit) });
  }

  if (i.albums.length) {
    const list = i.albums.slice(0, 5);
    items.albums = list.map((e) => e.item);
    add('albums', {
      heading: 'Your top albums',
      rows: rankRows(list, i.unit),
      lead: list[0].name,
      leadCover: sizedArtwork(list[0].item?.artwork, COVER_PX) ?? '',
    });
  }

  if (i.genres.length) {
    const top = i.genres[0].listenTimeInMinutes || i.genres[0].playCount;
    add('genres', {
      heading: 'Your sound',
      lead: i.genres[0].name,
      bars: i.genres.slice(0, 5).map((g) => ({
        name: g.name,
        caption: g.listenTimeInMinutes > 0 ? formatMinutes(g.listenTimeInMinutes, i.unit) : plural(g.playCount, 'play'),
        value: top > 0 ? g.listenTimeInMinutes || g.playCount : 0,
      })),
    });
  }

  const busiest = i.bars.reduce<(typeof i.bars)[number] | undefined>((best, b) => (!best || b.minutes > best.minutes ? b : best), undefined);
  if (i.bars.length > 1 && busiest && busiest.minutes > 0) {
    add('months', {
      heading: i.barsTitle,
      lead: busiest.full,
      line: `was your busiest — ${formatMinutes(busiest.minutes, i.unit)}.`,
      bars: i.bars.map((b, idx) => ({ id: `${idx}`, label: b.label, tooltip: `${b.full}: ${formatMinutes(b.minutes, i.unit)}`, value: b.minutes })),
      animationKey: i.title,
    });
  }

  const marks = i.milestones.filter((m) => m.artworkLight || m.artworkDark).slice(0, 12);
  if (marks.length) {
    add('milestones', {
      heading: 'Milestones',
      badges: marks.map((m) => ({
        art: milestoneArt(m.artworkLight || m.artworkDark),
        artDark: milestoneArt(m.artworkDark || m.artworkLight),
        label: milestoneLabel(m),
        caption: calendarDate(m.dateReached),
      })),
    });
  }

  const t = storyTime(i.minutes, i.unit);
  add('outro', {
    title: i.label,
    line: i.minutes > 0 ? `${groupDigits(t.value)} ${t.noun} of music${i.songs[0] ? `, led by ${i.songs[0].name}` : ''}.` : 'Thanks for listening.',
    hasPlaylist: !!i.playlistId,
  });

  return { slides, items, playlistId: i.playlistId };
}
