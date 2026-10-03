// Parsing a pasted music.apple.com link (or a bare id) into something to
// download. Apple's album-context song links carry the track in `?i=`, which
// wins over the album id in the path.

export type LinkKind = 'song' | 'album' | 'playlist' | 'unknown';
export interface AppleMusicLink {
  kind: LinkKind;
  id: string;
}

const PLAYLIST_ID = /^pl\.[A-Za-z0-9]+$/;
const NUMERIC = /^\d+$/;

export function parseAppleMusicLink(input: string): AppleMusicLink | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (PLAYLIST_ID.test(trimmed)) return { kind: 'playlist', id: trimmed };
  // A bare number is ambiguous between a song and an album; the caller probes.
  if (NUMERIC.test(trimmed)) return { kind: 'unknown', id: trimmed };

  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(trimmed);
  if (!m?.[2].toLowerCase().endsWith('music.apple.com')) return null;
  const query = m[4] ?? '';
  const songId = /[?&]i=([^&]+)/.exec(query)?.[1];
  if (songId) return { kind: 'song', id: decodeURIComponent(songId) };

  const segments = m[3].split('/').filter(Boolean).map(decodeURIComponent);
  const last = segments.at(-1);
  if (!last) return null;
  if (last.startsWith('pl.') || segments.includes('playlist')) return { kind: 'playlist', id: last };
  if (segments.includes('song') && NUMERIC.test(last)) return { kind: 'song', id: last };
  if (segments.includes('album') && NUMERIC.test(last)) return { kind: 'album', id: last };
  if (NUMERIC.test(last)) return { kind: 'unknown', id: last };
  return null;
}
