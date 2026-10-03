// The Apple privacy-export parser, against the cases measured on a real
// 2022–2026 export. Run with `bun test`.

import { expect, test } from 'bun:test';
import { ArtistIndex, DAILY_TRACKS_FILE, excludeOwnPlays, type ParseResult, PlayActivityImporter, playsByYear } from '../src/privacy/parse';

const HEADER =
  'Track Description,Artist Name,Song Name,Album Name,Event Type,Event Start Timestamp,Event End Timestamp,' +
  'Play Duration Milliseconds,Media Duration In Milliseconds,End Reason Type,Device Identifier';

function row(
  o: Partial<Record<'description' | 'artist' | 'song' | 'album' | 'eventType' | 'start' | 'end' | 'playMs' | 'mediaMs' | 'reason' | 'device', string>> = {},
) {
  const v = {
    description: '',
    artist: 'Gracie Abrams',
    song: 'I Told You Things',
    album: 'The Secret of Us',
    eventType: 'PLAY_END',
    start: '2024-03-01T10:00:00Z',
    end: '2024-03-01T10:03:41Z',
    playMs: '221000',
    mediaMs: '221207',
    reason: 'NATURAL_END_OF_TRACK',
    device: 'phone',
    ...o,
  };
  return [v.description, v.artist, v.song, v.album, v.eventType, v.start, v.end, v.playMs, v.mediaMs, v.reason, v.device].join(',');
}

const csv = (rows: string[], header = HEADER) => [header, ...rows].join('\n');

/** What the plugin does with `fs.openCsv`, over plain text (no quoting in these fixtures). */
function parse(files: string[], opts: { artists?: ArtistIndex; notAfterMs?: number } = {}): ParseResult {
  const importer = new PlayActivityImporter(opts);
  for (const text of files) {
    const [header, ...rows] = text.split('\n').map((l) => l.split(','));
    const cols = importer.startFile(header);
    if (!cols) break;
    for (const r of rows) importer.addRow(cols.map((i) => (i >= 0 && i < r.length ? r[i] : '')));
  }
  return importer.finish();
}

function index(rows: string[]) {
  const ix = new ArtistIndex();
  const header = ['Date Played', 'Track Description'];
  const cols = ArtistIndex.columns(header);
  if (!cols) throw new Error('not a Daily Tracks header');
  for (const line of rows) {
    const comma = line.indexOf(',');
    const r = [line.slice(0, comma), line.slice(comma + 1)];
    ix.add(cols.map((i) => r[i]));
  }
  return ix;
}

test('reads a play with real start/end timestamps', () => {
  const r = parse([csv([row()])]);
  expect(r.error).toBe(undefined);
  expect(r.plays.length).toBe(1);
  const p = r.plays[0];
  expect(p.title).toBe('I Told You Things');
  expect(p.artist).toBe('Gracie Abrams');
  expect(p.startedAtMs).toBe(Date.UTC(2024, 2, 1, 10, 0, 0));
  expect(p.listenedMs).toBe(221000);
});

test('skips non-PLAY_END rows', () => {
  const r = parse([csv([row({ eventType: 'LYRIC_DISPLAY' }), row()])]);
  expect(r.plays.length).toBe(1);
  expect(r.notPlays).toBe(1);
});

test('drops a play too short to count', () => {
  const r = parse([csv([row({ playMs: '5000' })])]);
  expect(r.plays.length).toBe(0);
  expect(r.tooShort).toBe(1);
});

test('falls back to Track Description when Song/Artist are blank', () => {
  const r = parse([csv([row({ artist: '', song: '', description: 'Gracie Abrams - I Told You Things' })])]);
  expect(r.plays[0].artist).toBe('Gracie Abrams');
  expect(r.plays[0].title).toBe('I Told You Things');
});

test('counts a zero-length segment as too short, not unreadable', () => {
  const r = parse([csv([row({ playMs: '0', reason: 'TRACK_SKIPPED_FORWARDS' })])]);
  expect(r.tooShort).toBe(1);
  expect(r.unreadable).toBe(0);
});

test('drops an unreadable row without losing the rest', () => {
  const r = parse([csv([row({ artist: '', song: '', description: '' }), row()])]);
  expect(r.plays.length).toBe(1);
  expect(r.unreadable).toBe(1);
});

test('deduplicates the same play repeated across files', () => {
  const one = csv([row()]);
  const r = parse([one, one]);
  expect(r.plays.length).toBe(1);
  expect(r.duplicates).toBe(1);
});

test('honours notAfter', () => {
  const r = parse([csv([row({ start: '2025-06-01T00:00:00Z', end: '2025-06-01T00:03:41Z' })])], { notAfterMs: Date.UTC(2025, 0, 1) });
  expect(r.plays.length).toBe(0);
});

test('reports which columns are missing rather than guessing', () => {
  const r = parse(['Some Other Column\nvalue']);
  expect(r.error ?? '').toMatch(/song name/);
});

test('playsByYear groups oldest first', () => {
  const r = parse([
    csv([row({ start: '2023-05-01T00:00:00Z', end: '2023-05-01T00:03:41Z' }), row({ start: '2022-05-01T00:00:00Z', end: '2022-05-01T00:03:41Z' })]),
  ]);
  expect(playsByYear(r).map(([y]) => y)).toEqual([2022, 2023]);
});

// One listen of a 5:42 track, paused at 2:55, scrubbed, and paused again at
// 5:01 — four rows, two of which passed the half-the-track rule on their own.
const pausedAndScrubbed = () => [
  row({
    song: 'Can I come home',
    album: 'Mother',
    start: '2022-05-12T08:28:22.524Z',
    end: '2022-05-12T08:31:17.441Z',
    playMs: '174917',
    mediaMs: '342000',
    reason: 'PLAYBACK_MANUALLY_PAUSED',
  }),
  row({
    song: 'Can I come home',
    album: 'Mother',
    start: '2022-05-12T08:32:06.072Z',
    end: '2022-05-12T08:32:15.176Z',
    playMs: '9104',
    mediaMs: '342000',
    reason: 'SCRUB_BEGIN',
  }),
  row({
    song: 'Can I come home',
    album: 'Mother',
    start: '2022-05-12T08:28:40.596Z',
    end: '2022-05-12T08:32:15.176Z',
    playMs: '214580',
    mediaMs: '342000',
    reason: 'SCRUB_END',
  }),
  row({
    song: 'Can I come home',
    album: 'Mother',
    start: '2022-05-12T08:32:15.600Z',
    end: '2022-05-12T08:33:32.819Z',
    playMs: '77219',
    mediaMs: '342000',
    reason: 'PLAYBACK_MANUALLY_PAUSED',
  }),
];

test('joins a paused and scrubbed listen into one play', () => {
  const r = parse([csv(pausedAndScrubbed())]);
  expect(r.rows).toBe(4);
  expect(r.listens).toBe(1);
  expect(r.plays.length).toBe(1);
  expect(r.plays[0].listenedMs).toBe(174917 + 9104 + 77219);
  expect(r.plays[0].startedAtMs).toBe(Date.UTC(2022, 4, 12, 8, 28, 22, 524));
});

test('pieces that each fall short add up to a play', () => {
  const r = parse([
    csv([
      row({ start: '2024-03-01T10:00:00Z', end: '2024-03-01T10:01:30Z', playMs: '90000', reason: 'PLAYBACK_MANUALLY_PAUSED' }),
      row({ start: '2024-03-01T10:05:00Z', end: '2024-03-01T10:06:30Z', playMs: '90000' }),
    ]),
  ]);
  expect(r.listens).toBe(1);
  expect(r.plays[0].listenedMs).toBe(180000);
});

test('a natural end closes the listen, so a repeat is a second play', () => {
  const r = parse([
    csv([row({ start: '2024-03-01T10:00:00Z', end: '2024-03-01T10:03:41Z' }), row({ start: '2024-03-01T10:03:41Z', end: '2024-03-01T10:07:22Z' })]),
  ]);
  expect(r.listens).toBe(2);
  expect(r.plays.length).toBe(2);
});

test('a long pause starts a new listen', () => {
  const r = parse([
    csv([
      row({ start: '2024-03-01T10:00:00Z', end: '2024-03-01T10:01:30Z', playMs: '90000', reason: 'PLAYBACK_MANUALLY_PAUSED' }),
      row({ start: '2024-03-01T12:00:00Z', end: '2024-03-01T12:01:30Z', playMs: '90000' }),
    ]),
  ]);
  expect(r.listens).toBe(2);
  expect(r.plays.length).toBe(0);
});

test('keeps two devices apart', () => {
  const r = parse([
    csv([
      row({ start: '2024-03-01T10:00:00Z', end: '2024-03-01T10:01:30Z', playMs: '90000', reason: 'PLAYBACK_MANUALLY_PAUSED', device: 'phone' }),
      row({ start: '2024-03-01T10:02:00Z', end: '2024-03-01T10:03:30Z', playMs: '90000', device: 'mac' }),
    ]),
  ]);
  expect(r.listens).toBe(2);
  expect(r.plays.length).toBe(0);
});

const ACTIVITY_HEADER =
  'Song Name,Album Name,Event Type,Event Start Timestamp,Event End Timestamp,Play Duration Milliseconds,Media Duration In Milliseconds,End Reason Type';
const play = (song: string, day: string) => `${song},Album,PLAY_END,${day}T10:00:00Z,${day}T10:03:00Z,180000,180000,NATURAL_END_OF_TRACK`;

test('an export with no artist column needs the Daily Tracks file', () => {
  const r = parse([`${ACTIVITY_HEADER}\n${play('Stranger', '2022-05-11')}`]);
  expect((r.error ?? '').includes(DAILY_TRACKS_FILE)).toBe(true);
});

test('matches the artist by title and day', () => {
  const r = parse([`${ACTIVITY_HEADER}\n${play('Stranger', '2022-05-11')}`], { artists: index(['20220511,Hannah Storm - Stranger']) });
  expect(r.plays[0].artist).toBe('Hannah Storm');
});

test('uses the day to settle a title two artists share', () => {
  const r = parse([`${ACTIVITY_HEADER}\n${play('Home', '2023-01-02')}`], { artists: index(['20230102,Artist A - Home', '20230905,Artist B - Home']) });
  expect(r.plays[0].artist).toBe('Artist A');
});

test('leaves a title it cannot settle out rather than guessing', () => {
  const r = parse([`${ACTIVITY_HEADER}\n${play('Home', '2024-06-01')}`], { artists: index(['20230102,Artist A - Home', '20230905,Artist B - Home']) });
  expect(r.plays.length).toBe(0);
  expect(r.noArtist).toBe(1);
});

test('handles " - " inside the artist or the title', () => {
  const r = parse([`${ACTIVITY_HEADER}\n${play('Ragnarok - Twilight of the Gods', '2023-09-10')}`], {
    artists: index(['20230910,Einar Selvik - Ragnarok - Twilight of the Gods']),
  });
  expect(r.plays[0].artist).toBe('Einar Selvik');
});

test('drops plays Elbert already streamed and reported', () => {
  const r = parse([csv([row()])]);
  const out = excludeOwnPlays(r, [{ title: 'i told you things', artist: 'gracie abrams', startedAtMs: Date.UTC(2024, 2, 1, 10, 1, 0) }]);
  expect(out.plays.length).toBe(0);
  expect(out.duplicates).toBe(1);
});
