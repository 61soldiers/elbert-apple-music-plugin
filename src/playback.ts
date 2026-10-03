// Turning catalog songs into things Elbert's player can play.
//
// A song the library already has is played from disk — seekable, free of
// bandwidth, offline, and not reported to Apple as a stream — so every queue
// goes through `playableQueue`, which swaps in the local copy where there is
// one. Because of that, a page must pick the tapped entry *by index*, never
// by `applemusic-stream:<id>`: that id only exists for songs that stream.

import type { LibraryTrack, QueueEntry, SongRef, StreamTrack } from '@evolvedmesh/elbert-plugin-sdk';
import { streamTrackId } from './ids';
import { bestArtwork, orchard, type Song } from './orchard/client';

export const PROVIDER = 'Apple Music';
export const SECTION = '/apple-music';

export function songRef(song: Song): SongRef {
  return { id: song.id, title: song.name, artist: song.artistName, album: song.albumName, isrc: song.isrc, durationMs: song.durationMs };
}

/** The ephemeral stream for [song]. Its URL carries the API key — never persist it. */
export function streamTrack(song: Song): StreamTrack {
  return {
    id: streamTrackId(song.id),
    url: orchard.streamUrl(song.id),
    title: song.name,
    artist: song.artistName,
    album: song.albumName ?? '',
    albumArtist: song.artistName,
    durationMs: song.durationMs,
    trackNumber: song.trackNumber || undefined,
    discNumber: song.discNumber || undefined,
    hasLyrics: song.hasLyrics,
    coverUrl: bestArtwork(song.artwork),
    isrc: song.isrc,
    providerName: PROVIDER,
    artistRoute: song.artistId ? `${SECTION}/artists/${encodeURIComponent(song.artistId)}` : undefined,
    albumRoute: song.albumId ? `${SECTION}/albums/${encodeURIComponent(song.albumId)}` : undefined,
  };
}

/** The library track each song resolves to (by ISRC, then title/artist/duration). */
export async function localMatches(songs: Song[]): Promise<(LibraryTrack | null)[]> {
  if (!songs.length) return [];
  try {
    return await elbert.library.match(songs.map(songRef));
  } catch {
    return songs.map(() => null);
  }
}

export async function playableQueue(songs: Song[]): Promise<QueueEntry[]> {
  const matches = await localMatches(songs);
  return songs.map((s, i) => {
    const local = matches[i];
    return local ? { libraryId: local.id } : streamTrack(s);
  });
}

/** Plays [songs] from [index], preferring local copies. */
export async function playSongs(songs: Song[], index = 0, shuffle = false) {
  if (!songs.length) return;
  const queue = await playableQueue(songs);
  if (shuffle) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    index = 0;
  }
  await elbert.player.play(queue, { startIndex: Math.max(0, Math.min(index, queue.length - 1)) });
}
