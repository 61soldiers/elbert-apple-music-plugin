// Track ids this plugin gives what it plays.
//
// A *streamed* song is `applemusic-stream:<catalog id>` — an ephemeral queue
// entry. A *downloaded* one, once it is an ordinary local file in the library,
// is `applemusic:<catalog id>`. The prefixes are how the plugin recognises its
// own tracks (play reporting, the "Re-download" menu row), so they must never
// change: libraries and listening logs already hold them.

export const STREAM_PREFIX = 'applemusic-stream:';
export const DOWNLOADED_PREFIX = 'applemusic:';

export const streamTrackId = (catalogId: string) => `${STREAM_PREFIX}${catalogId}`;
export const downloadedTrackId = (catalogId: string) => `${DOWNLOADED_PREFIX}${catalogId}`;

/** The catalog id behind either kind of track id, or null for anything else. */
export function catalogIdOf(trackId: string | null | undefined): string | null {
  if (!trackId) return null;
  for (const prefix of [STREAM_PREFIX, DOWNLOADED_PREFIX]) {
    if (trackId.startsWith(prefix)) {
      const id = trackId.slice(prefix.length);
      return id || null;
    }
  }
  return null;
}

/** Only a streamed track is reported to Apple; a downloaded file is the user's own. */
export function streamedCatalogIdOf(trackId: string | null | undefined): string | null {
  if (!trackId?.startsWith(STREAM_PREFIX)) return null;
  return trackId.slice(STREAM_PREFIX.length) || null;
}
