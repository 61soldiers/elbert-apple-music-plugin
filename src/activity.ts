// Plays reported back to Apple, and stations that never run out.
//
// Both observe Elbert's player through `player.change` / `player.tick`.

import { settings } from './connection';
import { errorText } from './errors';
import { streamedCatalogIdOf } from './ids';
import { OrchardError, orchard, type Song } from './orchard/client';
import { streamTrack } from './playback';

// ---- Play activity -------------------------------------------------------------------
//
// Anything *streamed* from Apple Music is reported to the account's
// play-activity feed — a start once it is really playing, an end when it stops
// being current — so it shows in Recently Played and feeds Apple's own
// personalization. A downloaded track is never reported: playing a file off
// the user's own disk is not Apple's business. Best-effort throughout: a
// failed report costs a history entry, nothing else.

export type PlayContextKind = 'album' | 'playlist' | 'artist' | 'radio';
export interface PlayContext {
  kind: PlayContextKind;
  id: string;
}

const MAX_CONTEXTS = 2000;
/** A play this close to the end finished naturally rather than being skipped. */
const NATURAL_END_SLACK_MS = 5000;

/** Apple keys Recently Played on the container; pages register theirs here. */
const contexts = new Map<string, PlayContext>();

/**
 * Remembers that these **catalog** song ids were listed under [context], so
 * every play started from that page carries its album/playlist.
 */
export function rememberContext(songIds: Iterable<string>, context: PlayContext | null | undefined) {
  if (!context) return;
  for (const id of songIds) {
    contexts.delete(id);
    contexts.set(id, context);
  }
  for (const oldest of contexts.keys()) {
    if (contexts.size <= MAX_CONTEXTS) break;
    contexts.delete(oldest);
  }
}

export const ranToCompletion = (durationMs: number, positionMs: number, slackMs = NATURAL_END_SLACK_MS) => durationMs > 0 && positionMs >= durationMs - slackMs;

let trackId: string | null = null;
let catalogId: string | null = null;
let durationMs = 0;
let positionMs = 0;
let startReported = false;

/** Dispatches one report; whether it actually went out. */
function send(event: 'start' | 'end', songId: string, endPositionMs = 0, endReason = 'natural'): boolean {
  if (!settings.orchardPlayHistoryEnabled || !orchard.isConfigured) return false;
  const ctx = contexts.get(songId);
  orchard
    .reportPlayActivity({ event, songId, durationMs, endPositionMs, endReason, containerType: ctx?.kind, containerId: ctx?.id })
    .catch((e) => console.debug(`play activity (${event}) failed: ${errorText(e)}`));
  return true;
}

function finishCurrent() {
  if (!catalogId || !startReported) return;
  send('end', catalogId, positionMs, ranToCompletion(durationMs, positionMs) ? 'natural' : 'skipped_forward');
}

function onPlayback(e: { currentId: string | null; playing: boolean; durationMs: number }) {
  if (e.currentId !== trackId) {
    finishCurrent();
    trackId = e.currentId;
    catalogId = streamedCatalogIdOf(e.currentId);
    durationMs = e.durationMs;
    positionMs = 0;
    startReported = false;
  } else if (e.durationMs > 0) {
    durationMs = e.durationMs;
  }
  // Only once genuinely playing, so a track that fails to open is never
  // reported; recorded only if sent, so no end without a start.
  if (!startReported && catalogId && e.playing) startReported = send('start', catalogId);
}

/** Closes out the play in progress — the app is going away. */
export function flushActivity() {
  finishCurrent();
  startReported = false;
}

// ---- Stations ------------------------------------------------------------------------
//
// A personalized station is a rolling queue of catalog songs: each
// `next-tracks` call advances it, so there is no list to open — a station card
// plays. Once ≤3 tracks remain ahead, the next batch is appended. Station mode
// ends by itself the moment something the station didn't queue is playing.

/** Apple's hard cap on this endpoint; its own default is 2. */
const BATCH = 10;
const REFILL_THRESHOLD = 3;

let stationId: string | null = null;
const stationTrackIds = new Set<string>();
let fetching = false;

export const currentStation = () => stationId;

/** Throws OrchardError (`station_not_playable` for live radio) for the caller to show. */
export async function playStation(id: string) {
  const songs = await orchard.getStationTracks(id, BATCH);
  const queue = songs.map(streamTrack);
  if (!queue.length) throw new OrchardError('station_not_playable', 'This station has no playable tracks.');
  stationId = id;
  stationTrackIds.clear();
  for (const t of queue) stationTrackIds.add(t.id);
  rememberStation(songs, id);
  await elbert.player.play(queue, { startIndex: 0 });
}

export function stopStation() {
  stationId = null;
  stationTrackIds.clear();
}

function rememberStation(songs: Song[], id: string) {
  rememberContext(
    songs.map((s) => s.id),
    { kind: 'radio', id },
  );
}

function onStationPlayback(e: { currentId: string | null; queue: string[]; index: number }) {
  if (!stationId || !e.currentId) return;
  if (!stationTrackIds.has(e.currentId)) return stopStation();
  const remaining = e.queue.length - e.index - 1;
  if (e.index >= 0 && remaining <= REFILL_THRESHOLD) void topUp();
}

/** Silent on failure: the queue still has tracks, and the next change retries. */
async function topUp() {
  const id = stationId;
  if (!id || fetching) return;
  fetching = true;
  try {
    const songs = await orchard.getStationTracks(id, BATCH);
    if (stationId !== id) return;
    const fresh = songs.map(streamTrack).filter((t) => {
      if (stationTrackIds.has(t.id)) return false;
      stationTrackIds.add(t.id);
      return true;
    });
    if (!fresh.length) return;
    rememberStation(songs, id);
    await elbert.player.appendToQueue(fresh);
  } catch (e) {
    console.debug(`station top-up failed: ${errorText(e)}`);
  } finally {
    fetching = false;
  }
}

/** Starts observing playback. */
export function startActivity() {
  elbert.player.onChange((e) => {
    onPlayback(e);
    onStationPlayback(e);
  });
  elbert.player.onTick((e) => {
    if (e.currentId === trackId) positionMs = e.positionMs;
  });
  elbert.on('app.lifecycle', () => flushActivity());
}
