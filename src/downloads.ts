// Runs Apple Music download jobs to completion and saves the finished files.
//
// Every entry point — a row's Download, an album's Download all, the
// Downloads page's search and pasted links, playlist sync — goes through this
// one module, so there is exactly one place that decides where a file lands.
// Once saved, a track is an ordinary local file in Elbert's library
// (`applemusic:<catalog id>`), with a `.lrc` beside it when Apple has lyrics.
//
// Albums download as one Orchard `album` job. Playlists never do: the
// downloader resolves and decrypts a playlist's tracks far more reliably one
// at a time, so a playlist fans out into one `song` job per track.

import type { LibraryTrack } from '@evolvedmesh/elbert-plugin-sdk';
import { errorText } from './errors';
import { sanitize } from './format';
import { DOWNLOADED_PREFIX, downloadedTrackId } from './ids';
import { bestArtwork, type DownloadJob, jobIsTerminal, OrchardError, orchard, type Song } from './orchard/client';
import { localMatches, SECTION } from './playback';

export interface TrackProgress {
  trackId: string;
  name: string;
  /** queued | manifest | download | decrypt | remux | tag | done | failed */
  phase: string;
  bytesDone: number;
  bytesTotal: number;
  error?: string;
  savedToDisk: boolean;
  saveError?: string;
  savedPath?: string;
}

export interface DownloadRecord {
  jobId: string;
  /** song | album | artist | playlist */
  type: string;
  catalogId: string;
  label: string;
  subtitle?: string;
  artworkUrl?: string;
  /** queued | running | done | failed | cancelled */
  state: string;
  error?: string;
  tracks: Map<string, TrackProgress>;
  createdAt: number;
}

const isDone = (t: TrackProgress) => t.phase === 'done';
const isFailed = (t: TrackProgress) => t.phase === 'failed' || t.saveError != null;

export const recordIsTerminal = (r: DownloadRecord) => jobIsTerminal(r);
export const savedTracks = (r: DownloadRecord) => [...r.tracks.values()].filter((t) => t.savedToDisk).length;
export const failedTracks = (r: DownloadRecord) => [...r.tracks.values()].filter((t) => isFailed(t) && !t.savedToDisk).length;

/** Where "View files" opens: every saved track of a job lands in one folder. */
export function savedFolder(r: DownloadRecord): string | null {
  for (const t of r.tracks.values()) {
    if (t.savedPath) return t.savedPath.replace(/[\\/][^\\/]*$/, '');
  }
  return null;
}

/**
 * Two units per track — Orchard finishing it, then the file landing here — so
 * the bar keeps moving through the (often slower) local save instead of
 * parking at 100%.
 */
export function recordProgress(r: DownloadRecord): number {
  const total = r.tracks.size;
  if (total === 0) return recordIsTerminal(r) ? 1 : 0;
  let units = 0;
  for (const t of r.tracks.values()) {
    if (isDone(t) || isFailed(t)) units += 1;
    if (t.savedToDisk || t.saveError != null) units += 1;
  }
  return Math.max(0, Math.min(1, units / (total * 2)));
}

export const recordIsActive = (r: DownloadRecord) => !recordIsTerminal(r) || recordProgress(r) < 1;

const records = new Map<string, DownloadRecord>();
const listeners = new Set<() => void>();

export function onDownloadsChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let notifyScheduled = false;
function changed() {
  // Coalesced: a big album polls dozens of track updates a second.
  if (notifyScheduled) return;
  notifyScheduled = true;
  setTimeout(() => {
    notifyScheduled = false;
    void elbert.ui.setBadge(`${SECTION}/downloads`, activeCount()).catch(() => {});
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        console.error('downloads listener failed', e);
      }
    }
  }, 120);
}

/** Every record, newest first. */
export const allRecords = () => [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
export const recordFor = (jobId: string) => records.get(jobId);
export const activeCount = () => [...records.values()].filter(recordIsActive).length;

export interface StartOptions {
  type: 'song' | 'album' | 'artist' | 'playlist';
  catalogId: string;
  label: string;
  subtitle?: string;
  artworkUrl?: string;
  /** The songs the caller already has, so tracks are named without another round trip. */
  tracks: Song[];
  codec?: string;
  /** Overrides the default root — playlist sync, which must land inside a music folder. */
  destinationRoot?: string;
  /** Replaces exactly this file (re-download). */
  overwriteFilePath?: string;
  /**
   * "Download again": replace the library's own file of the same recording.
   * Off for bulk entry points — an album's Download all must not overwrite
   * files the user owns. A file this plugin downloaded is replaced regardless.
   */
  replaceLocalMatch?: boolean;
  /** Add saved files to the library (default true). */
  addToLibrary?: boolean;
}

/** Starts a job and tracks it until every track has saved or failed. Returns the job id. */
export async function startDownload(o: StartOptions): Promise<string> {
  const job = await orchard.createDownload(o.type, o.catalogId, o.codec ?? 'alac');
  const known = new Map(o.tracks.map((t) => [t.id, t]));
  records.set(job.id, {
    jobId: job.id,
    type: o.type,
    catalogId: o.catalogId,
    label: o.label,
    subtitle: o.subtitle,
    artworkUrl: o.artworkUrl,
    state: job.state,
    tracks: new Map(
      job.tracks.map((t) => [
        t.trackId,
        { trackId: t.trackId, name: known.get(t.trackId)?.name ?? t.trackId, phase: t.phase, bytesDone: 0, bytesTotal: 0, savedToDisk: false },
      ]),
    ),
    createdAt: Date.now(),
  });
  changed();
  void run(job.id, known, o);
  return job.id;
}

/**
 * Downloads a set of songs: an album as one job, anything else (a playlist,
 * a selection) as one job per song. Returns every job id started.
 */
export async function downloadSongs(
  songs: Song[],
  opts: { albumId?: string; label: string; subtitle?: string; artworkUrl?: string; destinationRoot?: string },
): Promise<string[]> {
  if (opts.albumId) {
    return [
      await startDownload({
        type: 'album',
        catalogId: opts.albumId,
        label: opts.label,
        subtitle: opts.subtitle,
        artworkUrl: opts.artworkUrl,
        tracks: songs,
        destinationRoot: opts.destinationRoot,
      }),
    ];
  }
  const ids: string[] = [];
  for (const s of songs) {
    try {
      ids.push(await startDownload(songJob(s, { subtitle: `${s.artistName} · ${opts.label}`, destinationRoot: opts.destinationRoot })));
    } catch (e) {
      console.warn(`could not start a download for ${s.id}`, e);
    }
  }
  return ids;
}

export function songJob(s: Song, extra: Partial<StartOptions> = {}): StartOptions {
  return {
    type: 'song',
    catalogId: s.id,
    label: s.name,
    subtitle: s.artistName,
    artworkUrl: bestArtwork(s.artwork),
    tracks: [s],
    ...extra,
  };
}

/** Resolves once [jobId] has finished (or at once, when there is no such job). */
export async function waitForCompletion(jobId: string, timeoutMs = 30 * 60_000): Promise<DownloadRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = records.get(jobId);
    if (!r || !recordIsActive(r) || Date.now() > deadline) return r;
    await new Promise((res) => setTimeout(res, 400));
  }
}

export async function cancel(jobId: string) {
  try {
    await orchard.cancelJob(jobId);
  } catch {
    // Already finished; nothing more to do either way.
  }
}

export function dismiss(jobId: string) {
  records.delete(jobId);
  changed();
}

export function clearFinished() {
  for (const [id, r] of records) if (recordIsTerminal(r) && !recordIsActive(r)) records.delete(id);
  changed();
}

function mutateTrack(jobId: string, trackId: string, name: string, patch: Partial<TrackProgress>) {
  const r = records.get(jobId);
  if (!r) return;
  const current = r.tracks.get(trackId) ?? { trackId, name, phase: 'queued', bytesDone: 0, bytesTotal: 0, savedToDisk: false };
  r.tracks.set(trackId, { ...current, ...patch });
  changed();
}

async function run(jobId: string, known: Map<string, Song>, o: StartOptions) {
  let job: DownloadJob;
  for (;;) {
    try {
      job = await orchard.getJob(jobId);
    } catch (e) {
      const r = records.get(jobId);
      if (r) {
        r.state = 'failed';
        r.error = errorText(e);
        changed();
      }
      return;
    }
    const r = records.get(jobId);
    if (!r) return;
    r.state = job.state;
    r.error = job.error;
    for (const t of job.tracks) {
      const prev = r.tracks.get(t.trackId) ?? {
        trackId: t.trackId,
        name: known.get(t.trackId)?.name ?? t.trackId,
        phase: 'queued',
        bytesDone: 0,
        bytesTotal: 0,
        savedToDisk: false,
      };
      r.tracks.set(t.trackId, { ...prev, phase: t.phase, bytesDone: t.bytesDone, bytesTotal: t.bytesTotal, error: t.error });
    }
    changed();
    if (jobIsTerminal(job)) break;
    await new Promise((res) => setTimeout(res, 1000));
  }

  for (const jt of job.tracks) {
    if (jt.phase !== 'done') continue;
    let name = known.get(jt.trackId)?.name ?? jt.trackId;
    try {
      const song = known.get(jt.trackId) ?? (await orchard.getSong(jt.trackId));
      name = song.name;
      const existing = await replaceableTrack(song, !!o.replaceLocalMatch);
      const path = await saveFile(song, o, existing);
      const gotLyrics = await saveLyricsSidecar(song, path);
      mutateTrack(jobId, jt.trackId, name, { savedToDisk: true, savedPath: path });
      if (o.addToLibrary !== false) {
        await elbert.library.add({
          // Keep the library's id when replacing its file, so playlists that
          // reference the track keep pointing at it.
          id: existing?.id ?? downloadedTrackId(song.id),
          path,
          title: song.name,
          artist: song.artistName,
          album: song.albumName ?? '',
          albumArtist: song.artistName,
          durationMs: song.durationMs,
          trackNumber: song.trackNumber || undefined,
          discNumber: song.discNumber || undefined,
          hasLyrics: gotLyrics,
          coverUrl: bestArtwork(song.artwork),
          isrc: song.isrc,
        });
      }
    } catch (e) {
      mutateTrack(jobId, jt.trackId, name, { saveError: errorText(e) });
    }
  }
}

// ---- Filesystem ---------------------------------------------------------------------

/** Downloads/Elbert. */
async function downloadsRoot(): Promise<string> {
  const paths = await elbert.fs.paths();
  return elbert.fs.join(paths.downloads ?? paths.appSupport, 'Elbert');
}

const extOf = (p: string) => (/\.[^.\\/]*$/.exec(p)?.[0] ?? '').toLowerCase();
const withoutExt = (p: string) => p.replace(/\.[^.\\/]*$/, '');
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

async function saveFile(song: Song, o: StartOptions, existing: LibraryTrack | null): Promise<string> {
  // An explicit target wins; failing that, the library's own file for this
  // song is replaced wherever it lives.
  const replace = o.overwriteFilePath || existing?.path;
  if (replace) {
    // Orchard only sends .m4a. Writing that over a .flac/.mp3 path would leave
    // an extension that lies, so the replacement takes the same name with the
    // right extension and the old file goes once the new one has landed.
    let target = extOf(replace) === '.m4a' ? replace : `${withoutExt(replace)}.m4a`;
    if (target !== replace && (await elbert.fs.exists(target))) target = `${withoutExt(replace)} (Apple Music).m4a`;
    await elbert.fs.mkdir(dirOf(target));
    await downloadReplacing(song.id, target);
    if (target !== replace) await elbert.fs.remove(replace).catch(() => false);
    return target;
  }

  const root = o.destinationRoot || (await downloadsRoot());
  const album = song.albumName?.trim() || 'Unknown Album';
  const dir = elbert.fs.join(root, sanitize(album));
  await elbert.fs.mkdir(dir);
  const name = song.trackNumber > 0 ? `${String(song.trackNumber).padStart(2, '0')} - ${sanitize(song.name)}.m4a` : `${sanitize(song.name)}.m4a`;
  const path = elbert.fs.join(dir, name);
  await orchard.downloadTrackFile(song.id, path);
  return path;
}

/** Into a sibling, then renamed over — a failed transfer must not take the original with it. */
async function downloadReplacing(songId: string, target: string) {
  const part = `${target}.elbert-part`;
  try {
    await orchard.downloadTrackFile(songId, part);
    await elbert.fs.rename(part, target);
  } catch (e) {
    await elbert.fs.remove(part).catch(() => false);
    throw e;
  }
}

/**
 * The library track a download of [song] should replace, or null. One this
 * plugin downloaded always qualifies; a file the user brought only on an
 * explicit "Download again". A path that has gone missing is ignored.
 */
async function replaceableTrack(song: Song, replaceLocalMatch: boolean): Promise<LibraryTrack | null> {
  const [match] = await localMatches([song]);
  if (!match?.isLocalFile || !match.path) return null;
  if (!replaceLocalMatch && !match.id.startsWith(DOWNLOADED_PREFIX)) return null;
  return (await elbert.fs.exists(match.path)) ? match : null;
}

/**
 * A `.lrc` beside the file — the best tier Orchard managed (word, line, plain).
 * Reports whether one was written, so the track's hasLyrics is the truth on
 * disk. Never throws: lyrics are a nicety.
 */
async function saveLyricsSidecar(song: Song, audioPath: string): Promise<boolean> {
  if (!song.hasLyrics) return false;
  try {
    const lyrics = await orchard.getLyrics(song.id);
    if (!lyrics?.lrc) return false;
    await elbert.fs.writeText(`${withoutExt(audioPath)}.lrc`, lyrics.lrc);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-download: fetches a downloaded track again over its own file — same
 * path, same id — for when Apple has gained something since (lyrics, usually).
 */
export async function redownload(track: LibraryTrack): Promise<string> {
  const catalogId = track.id.startsWith(DOWNLOADED_PREFIX) ? track.id.slice(DOWNLOADED_PREFIX.length) : null;
  if (!catalogId) throw new OrchardError('not_apple_music', 'This track did not come from Apple Music.');
  const song = await orchard.getSong(catalogId);
  return startDownload(songJob(song, { overwriteFilePath: track.path, replaceLocalMatch: true }));
}
