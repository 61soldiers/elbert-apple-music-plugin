// Reads the listening history out of Apple's "Data & Privacy" export.
//
// Pure — no `elbert` global, no I/O — so the judgements that decide what
// lands in someone's listening history are tested directly
// (`test/privacy.test.ts`, `npm test`). `import.ts` streams the files'
// rows in through `fs.openCsv`; nothing here knows where they came from.
//
// **Where the files come from.** privacy.apple.com → "Request a copy of your
// data" → *Apple Media Services information*. Two files in it matter:
//
// - `Apple Music Play Activity.csv` — one row per playback event with real
//   start and end timestamps, the thing Replay never had. It is large (a few
//   years of listening is well over 100 MB and ~145 columns), which is why it
//   is streamed, only the columns read here are requested, and only segments
//   are kept, never the table.
// - `Apple Music - Play History Daily Tracks.csv` — per-day tallies whose
//   `Track Description` is "Artist - Title". Needed because **Apple's current
//   Play Activity export has no artist column at all** (measured on a real
//   2022–2026 export: `Song Name` and `Album Name`, no `Artist Name`), so the
//   artist is recovered by matching the day and title here. On that export
//   this resolved ~97% of plays; the rest are counted, not guessed.
//
// Headers are read by *name*, tolerantly, and a file that lacks what is
// needed says which headers it did have — Apple has changed this export's
// shape before, and nothing here may guess at columns it cannot find.

/** The Daily Tracks file's usual name, for finding it beside Play Activity. */
export const DAILY_TRACKS_FILE = 'Apple Music - Play History Daily Tracks.csv';

/**
 * The provider imported listens are filed under — the plugin's own name, so
 * Elbert's statistics count them with the songs it streamed as one source.
 */
export const IMPORT_PROVIDER = 'Apple Music';

/** One play, as `history.import` takes it. Times are epoch milliseconds. */
export interface Play {
  title: string;
  artist: string;
  album: string;
  startedAtMs: number;
  playedAtMs: number;
  listenedMs: number;
  durationMs: number;
}

export interface ParseResult {
  /** The plays that would be sent, oldest first. */
  plays: Play[];
  /** Data rows read, across every file. */
  rows: number;
  /** Listens those rows came to once each one's segments were joined back up. */
  listens: number;
  /** Rows that were not a play at all (lyric views, play starts, other event types). */
  notPlays: number;
  /** Listens too short to count as a play — skipped tracks. */
  tooShort: number;
  /** Plays with no artist anywhere: none in the row, none unambiguous in Daily Tracks. */
  noArtist: number;
  /** Rows with no usable title or time. */
  unreadable: number;
  /** Repeats: a segment logged twice, a file given twice, or a play Elbert already recorded. */
  duplicates: number;
  /** Set when nothing could be read, e.g. the columns are not there. */
  error?: string;
}

export const emptyResult = (error?: string): ParseResult => ({
  plays: [],
  rows: 0,
  listens: 0,
  notPlays: 0,
  tooShort: 0,
  noArtist: 0,
  unreadable: 0,
  duplicates: 0,
  ...(error ? { error } : {}),
});

const were = (n: number) => (n === 1 ? 'was' : 'were');

/**
 * Why nothing (or less than expected) came through, in words — for a result
 * with no plays, where a bare "nothing to import" says nothing.
 */
export function breakdown(r: ParseResult): string {
  if (r.rows === 0) return 'The file had no rows.';
  const parts = [
    r.tooShort > 0 && `${r.tooShort} ${were(r.tooShort)} too short to count`,
    r.noArtist > 0 && `${r.noArtist} had no artist Elbert could find`,
    r.duplicates > 0 && `${r.duplicates} ${were(r.duplicates)} already counted`,
  ].filter(Boolean);
  const skipped = [r.notPlays > 0 && `${r.notPlays} ${were(r.notPlays)} not plays`, r.unreadable > 0 && `${r.unreadable} could not be read`].filter(Boolean);
  return (
    `The ${r.rows} rows add up to ${r.listens} listens.` +
    (parts.length ? ` Of those, ${parts.join(', ')}.` : '') +
    (skipped.length ? ` Of the rows, ${skipped.join(' and ')}.` : '')
  );
}

/** Plays per calendar year (local time), oldest first. */
export function playsByYear(r: ParseResult): [year: number, plays: number][] {
  const byYear = new Map<number, number>();
  for (const p of r.plays) {
    const y = new Date(p.startedAtMs).getFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  return [...byYear.entries()].sort((a, b) => a[0] - b[0]);
}

// ---- The play rule ------------------------------------------------------------------
//
// Elbert's own: half the track or four minutes, whichever comes first — the
// scrobbler rule — plus Last.fm's floor of 30 seconds and a name on both
// sides. Restated here because a plugin can't call into the host's Dart; keep
// it in step with `isScrobbleEligible`/`PlayEvent.countsAsPlay` in Elbert.

const MIN_SCROBBLE_MS = 30_000;

export function countsAsPlay(listenedMs: number, durationMs: number): boolean {
  if (listenedMs >= 4 * 60_000) return true;
  if (durationMs <= 0) return listenedMs >= MIN_SCROBBLE_MS;
  return listenedMs * 2 >= durationMs;
}

function eligible(listenedMs: number, durationMs: number): boolean {
  if (durationMs > 0) {
    if (durationMs < MIN_SCROBBLE_MS) return false;
  } else if (listenedMs < MIN_SCROBBLE_MS) {
    return false;
  }
  return countsAsPlay(listenedMs, durationMs);
}

// ---- Headers --------------------------------------------------------------------------

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

function finder(header: string[]) {
  const names = header.map(normalise);
  return (candidates: string[]) => {
    for (const c of candidates) {
      const i = names.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };
}

// ---- Daily Tracks: title → artist -------------------------------------------------------

/**
 * Title → artist, from `Apple Music - Play History Daily Tracks.csv`.
 *
 * A description is "Artist - Title", but either half may itself contain
 * " - ", so every split point is indexed: the lookup is by the exact title
 * the Play Activity row carries, and only the split whose right half *is*
 * that title can match it.
 */
export class ArtistIndex {
  private byTitle = new Map<string, Set<string>>();
  private byDayTitle = new Map<string, Set<string>>();

  get size() {
    return this.byTitle.size;
  }

  static isDailyTracksHeader(header: string[]) {
    const names = new Set(header.map(normalise));
    return names.has('trackdescription') && names.has('dateplayed');
  }

  /** The columns to read from a Daily Tracks file — `[description, day]` — or null when it isn't one. */
  static columns(header: string[]): number[] | null {
    if (!ArtistIndex.isDailyTracksHeader(header)) return null;
    const find = finder(header);
    return [find(['trackdescription']), find(['dateplayed'])];
  }

  /** One row, as `[description, day]`. */
  add([description = '', date = '']: string[]) {
    const desc = description.trim();
    const day = date.trim();
    let at = desc.indexOf(' - ');
    while (at > 0) {
      const artist = desc.slice(0, at).trim();
      const title = key(desc.slice(at + 3));
      if (artist && title) {
        add(this.byTitle, title, artist);
        if (day) add(this.byDayTitle, `${day}|${title}`, artist);
      }
      at = desc.indexOf(' - ', at + 3);
    }
  }

  /**
   * The artist of [title] played around [atMs], or null when there is none
   * or more than one candidate — a wrong artist is a wrong scrobble, so an
   * ambiguous title is left unresolved rather than guessed.
   *
   * The play's own (UTC) day is tried first, then either side of it, since
   * the Daily Tracks day and the event's timestamp need not agree near
   * midnight. Only then the title on its own, across every day.
   */
  artistFor(title: string, atMs: number): string | null {
    const k = key(title);
    for (const offset of [0, -1, 1]) {
      const d = new Date(atMs + offset * 86_400_000);
      const stamp = `${String(d.getUTCFullYear()).padStart(4, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      const artists = this.byDayTitle.get(`${stamp}|${k}`);
      if (!artists) continue;
      if (artists.size === 1) return [...artists][0];
      break; // Ambiguous on its own day: the day can't settle it.
    }
    const artists = this.byTitle.get(k);
    return artists && artists.size === 1 ? [...artists][0] : null;
  }
}

const key = (title: string) => title.trim().toLowerCase();

function add(map: Map<string, Set<string>>, k: string, v: string) {
  const set = map.get(k);
  if (set) set.add(v);
  else map.set(k, new Set([v]));
}

// ---- Play Activity ------------------------------------------------------------------------

/** The Play Activity columns read, in the order `addRow` receives them. */
const C = {
  title: 0,
  trackDescription: 1,
  artist: 2,
  album: 3,
  start: 4,
  end: 5,
  playDuration: 6,
  mediaDuration: 7,
  eventType: 8,
  endReason: 9,
  device: 10,
  eventId: 11,
} as const;

function activityColumns(header: string[]): number[] {
  const find = finder(header);
  return [
    find(['songname', 'title', 'trackname']),
    find(['trackdescription']),
    // Deliberately not "Container Artist Name": that is the artist of the
    // album or playlist being played, which for a playlist is nobody's.
    find(['artistname', 'artist']),
    find(['albumname', 'album']),
    find(['eventstarttimestamp', 'starttimestamp']),
    find(['eventendtimestamp', 'endtimestamp', 'eventreceivedtimestamp']),
    find(['playdurationmilliseconds', 'playdurationmillis', 'playdurationinmilliseconds']),
    find(['mediadurationinmilliseconds', 'mediadurationmilliseconds', 'trackdurationmilliseconds']),
    find(['eventtype']),
    find(['endreasontype']),
    find(['deviceidentifier']),
    find(['eventid']),
  ];
}

/** One `PLAY_END` row: a stretch of playback between two stops. */
interface Segment {
  title: string;
  artist: string;
  album: string;
  startedAtMs: number;
  endedAtMs: number;
  /** Apple's "play duration": how far the playhead moved — time listened for every end reason but `SCRUB_END`. */
  playedMs: number;
  durationMs: number;
  endReason: string;
  device: string;
  eventId: string;
}

const identity = (s: Segment) => s.eventId || `${s.endedAtMs}|${s.device}|${s.title}|${s.album}|${s.playedMs}`;

/**
 * End reasons that pause a listen rather than finish it: the next segment of
 * the same track on the same device, soon after, is the same listen.
 *
 * Anything else — a natural end, a skip, picking another track, a failure to
 * load, a reason never seen before, or none at all — closes the listen.
 * Merging is the risky direction (two real plays joined into one, or two
 * short pieces added up into a play that never happened), so only reasons
 * measured to mean "paused" may do it.
 */
const PAUSE_REASONS = new Set(['SCRUB_BEGIN', 'SCRUB_END', 'PLAYBACK_MANUALLY_PAUSED', 'PLAYBACK_SUSPENDED', 'EXITED_APPLICATION']);

/** A longer pause starts a new listen even on the same track — coming back after lunch is listening again. */
const MAX_PAUSE_WITHIN_LISTEN_MS = 30 * 60_000;

/** A listen being reassembled from its segments. */
interface Listen {
  title: string;
  album: string;
  artist: string;
  startedAtMs: number;
  playedAtMs: number;
  listenedMs: number;
  durationMs: number;
}

const sameTrack = (l: Listen, s: Segment) =>
  s.title.toLowerCase() === l.title.toLowerCase() &&
  s.album.toLowerCase() === l.album.toLowerCase() &&
  (!s.artist || !l.artist || s.artist.toLowerCase() === l.artist.toLowerCase());

function addSegment(l: Listen, s: Segment) {
  // A scrub's "duration" is the distance scrubbed, not listening (its end
  // time equals the previous segment's in 1,148 of 1,557 cases measured).
  if (s.endReason !== 'SCRUB_END') l.listenedMs += s.playedMs;
  if (s.endedAtMs > l.playedAtMs) l.playedAtMs = s.endedAtMs;
  if (l.durationMs <= 0) l.durationMs = s.durationMs;
  if (!l.artist) l.artist = s.artist;
}

/**
 * Reassembles listens from Apple's segments.
 *
 * Apple writes a `PLAY_END` row every time playback *stops*, not every time a
 * track does: a pause, a scrub, backgrounding the app. On a real export one
 * listen with a pause and a scrub came out as four rows, two of which each
 * passed the half-the-track rule — one listen, two scrobbles — while a listen
 * paused halfway was two pieces that each fell short and never counted. So
 * segments are sorted by when they ended and joined per device while the
 * track stays the same and the previous segment ended in a pause.
 */
function stitch(segments: Segment[]): Listen[] {
  segments.sort((a, b) => a.endedAtMs - b.endedAtMs);
  const open = new Map<string, Listen>();
  const done: Listen[] = [];
  for (const s of segments) {
    let l = open.get(s.device);
    if (l && !(sameTrack(l, s) && s.startedAtMs - l.playedAtMs < MAX_PAUSE_WITHIN_LISTEN_MS)) {
      done.push(l);
      l = undefined;
    }
    l ??= { title: s.title, album: s.album, artist: s.artist, startedAtMs: s.startedAtMs, playedAtMs: s.endedAtMs, listenedMs: 0, durationMs: s.durationMs };
    addSegment(l, s);
    if (PAUSE_REASONS.has(s.endReason)) {
      open.set(s.device, l);
    } else {
      open.delete(s.device);
      done.push(l);
    }
  }
  done.push(...open.values());
  return done;
}

/**
 * ISO-8601, an epoch in milliseconds or seconds, or a bare
 * `yyyy-MM-dd HH:mm:ss`. Apple's export is UTC, so a stamp with no zone is
 * read as UTC rather than as this device's zone.
 */
export function parseTime(raw: string): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n <= 0) return null;
    return n > 100_000_000_000 ? n : n * 1000;
  }
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(raw);
  const ms = Date.parse(hasZone ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Streams one or more Play Activity files into plays: for each file call
 * [startFile] with its header and request the columns it returns, then
 * [addRow] each row as those columns; finally [finish]. Only segments are
 * kept, never the table.
 */
export class PlayActivityImporter {
  private segments: Segment[] = [];
  private seenSegments = new Set<string>();
  private rows = 0;
  private notPlays = 0;
  private unreadable = 0;
  private duplicates = 0;
  private error: string | null = null;
  private readonly artists: ArtistIndex | null;
  private readonly notAfterMs: number | null;

  constructor(opts: { artists?: ArtistIndex | null; notAfterMs?: number | null } = {}) {
    this.artists = opts.artists ?? null;
    this.notAfterMs = opts.notAfterMs ?? null;
  }

  get failed() {
    return this.error != null;
  }

  /**
   * Checks a file's header. Returns the column indices to read (missing ones
   * are -1, which `fs.readCsv` answers with ''), or null when the file can't
   * be read — the reason is in the result.
   */
  startFile(header: string[]): number[] | null {
    if (this.error) return null;
    const cols = activityColumns(header);
    const hasName = cols[C.title] >= 0 || cols[C.trackDescription] >= 0;
    const hasWhen = cols[C.start] >= 0 || cols[C.end] >= 0;
    const hasArtist = cols[C.artist] >= 0 || cols[C.trackDescription] >= 0;
    const named = header.filter((h) => h.trim());
    const found = `${named.slice(0, 12).join(', ')}${named.length > 12 ? ', …' : ''}`;
    if (ArtistIndex.isDailyTracksHeader(header)) {
      this.error = `That's the Daily Tracks file. Please pick "Apple Music Play Activity.csv" from the same folder instead. Elbert reads the Daily Tracks file by itself.`;
    } else if (!hasName || !hasWhen) {
      const missing = [!hasName && 'song name or track description column', !hasWhen && 'start or end timestamp column'].filter(Boolean).join(' or ');
      this.error = `That doesn't look like Apple's Play Activity file. It has no ${missing}. Columns found: ${found}.`;
    } else if (!hasArtist && (!this.artists || this.artists.size === 0)) {
      this.error = `Apple's file doesn't list artists, so Elbert needs "${DAILY_TRACKS_FILE}" as well. Keep it in the same folder as the file you picked, or pick both files together.`;
    }
    return this.error ? null : cols;
  }

  /** One row, as the columns [startFile] asked for. */
  addRow(row: string[]) {
    if (this.error) return;
    const cell = (c: number) => (row[c] ?? '').trim();
    if (row.every((c) => !c.trim())) return;
    this.rows++;

    // A segment is recorded once, at its end. Lyric views and start markers
    // are not listening; a row with no event type at all is taken as one.
    const type = cell(C.eventType);
    if (type && !type.includes('PLAY_END')) {
      this.notPlays++;
      return;
    }

    let name = cell(C.title);
    let by = cell(C.artist);
    if (!name || !by) {
      // "Artist - Title". A hyphen inside either half makes the split
      // ambiguous, so this is only a fallback, and the *first* " - " is the
      // boundary because artist names hyphenate less often than titles.
      const description = cell(C.trackDescription);
      const at = description.indexOf(' - ');
      if (at > 0) {
        if (!by) by = description.slice(0, at).trim();
        if (!name) name = description.slice(at + 3).trim();
      }
    }
    const begin = parseTime(cell(C.start));
    const finish = parseTime(cell(C.end));
    if (!name || (begin == null && finish == null)) {
      this.unreadable++;
      return;
    }
    // At least one end is known; the other is it, moved by the time played.

    // A zero-length segment is kept: it is a skip or a scrub, and still
    // closes (or continues) the listen around it. It only fails to be a play.
    const rawPlayed = cell(C.playDuration);
    let playedMs = /^-?\d+$/.test(rawPlayed) ? Number(rawPlayed) : -1;
    if (playedMs < 0 && begin != null && finish != null) playedMs = finish - begin;
    if (playedMs < 0) playedMs = 0;
    const rawDuration = cell(C.mediaDuration);
    const durationMs = /^\d+$/.test(rawDuration) ? Number(rawDuration) : 0;

    const segment: Segment = {
      title: name,
      artist: by,
      album: cell(C.album),
      startedAtMs: begin ?? (finish ?? 0) - playedMs,
      endedAtMs: finish ?? (begin ?? 0) + playedMs,
      playedMs,
      durationMs,
      endReason: cell(C.endReason),
      device: cell(C.device),
      eventId: cell(C.eventId),
    };
    // Apple can log one segment twice (a retried upload), and a user can hand
    // over the same file twice; a doubled segment would double a listen.
    const id = identity(segment);
    if (this.seenSegments.has(id)) {
      this.duplicates++;
      return;
    }
    this.seenSegments.add(id);
    this.segments.push(segment);
  }

  /**
   * Joins the segments into listens, then decides which listens are plays.
   * Nothing is judged row by row: a row is a *segment*, so the
   * half-the-track rule can only apply once the pieces are back together.
   */
  finish(): ParseResult {
    if (this.error) return emptyResult(this.error);
    const listens = stitch(this.segments);
    const plays: Play[] = [];
    const seen = new Set<string>();
    let tooShort = 0;
    let noArtist = 0;
    let duplicates = this.duplicates;

    for (const l of listens) {
      if (this.notAfterMs != null && l.startedAtMs >= this.notAfterMs) continue;
      // Judged before the artist is looked up: whether a listen is a play
      // doesn't depend on who it was by, and this keeps "no artist" about
      // plays that would otherwise have been sent.
      if (!eligible(l.listenedMs, l.durationMs)) {
        tooShort++;
        continue;
      }
      const artist = l.artist || this.artists?.artistFor(l.title, l.startedAtMs) || '';
      if (!artist) {
        noArtist++;
        continue;
      }
      const k = `${Math.floor(l.startedAtMs / 1000)}|${artist.toLowerCase()}|${l.title.toLowerCase()}`;
      if (seen.has(k)) {
        duplicates++;
        continue;
      }
      seen.add(k);
      plays.push({
        title: l.title,
        artist,
        album: l.album,
        startedAtMs: l.startedAtMs,
        playedAtMs: l.playedAtMs,
        listenedMs: l.listenedMs,
        durationMs: l.durationMs,
      });
    }

    plays.sort((a, b) => a.startedAtMs - b.startedAtMs);
    return { plays, rows: this.rows, listens: listens.length, notPlays: this.notPlays, tooShort, noArtist, unreadable: this.unreadable, duplicates };
  }
}

// ---- Plays Elbert already reported --------------------------------------------------------

const ownKey = (title: string, artist: string) => `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`;

/**
 * Drops plays this plugin streamed *in Elbert*, which it reported to Apple
 * and so are in the export too: matched by title/artist and a start within
 * three minutes. No track id survives into a CSV row, so this is a
 * heuristic — but it only ever drops a play, never adds a false one.
 */
export function excludeOwnPlays(result: ParseResult, own: { title: string; artist: string; startedAtMs: number }[]): ParseResult {
  if (!own.length || !result.plays.length) return result;
  const starts = new Map<string, number[]>();
  for (const o of own) {
    const k = ownKey(o.title, o.artist);
    const list = starts.get(k);
    if (list) list.push(o.startedAtMs);
    else starts.set(k, [o.startedAtMs]);
  }
  const kept = result.plays.filter((p) => !(starts.get(ownKey(p.title, p.artist)) ?? []).some((at) => Math.abs(p.startedAtMs - at) <= 3 * 60_000));
  const excluded = result.plays.length - kept.length;
  return excluded ? { ...result, plays: kept, duplicates: result.duplicates + excluded } : result;
}
