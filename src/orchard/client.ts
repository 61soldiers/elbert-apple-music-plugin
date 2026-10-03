// The Orchard REST client — everything Apple Music goes through.
//
// Orchard (github.com/61soldiers/orchard) is a self-hosted server that signs
// in to a real Apple Music subscription; this plugin only ever talks to its
// REST API, never to Apple. Shapes mirror orchard/docs/reference.md.
//
// The API key is a bearer token in a header for requests, and an `api_key`
// query parameter in stream URLs (Orchard's auth middleware accepts either),
// which is why a stream URL must never be persisted or logged.

import type { HttpResponse } from '@evolvedmesh/elbert-plugin-sdk';
import { errorCode, errorText } from '../errors';

export class OrchardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OrchardError';
  }
}

// ---- Models -------------------------------------------------------------------

export interface Artwork {
  url: string;
  thumbUrl?: string;
}

export function bestArtwork(a?: Artwork | null): string | undefined {
  if (!a) return undefined;
  return a.thumbUrl || a.url || undefined;
}

/** Apple's `{w}x{h}` template filled for [px]; ask for the size you draw. */
export function sizedArtwork(a: Artwork | null | undefined, px: number): string | undefined {
  if (!a) return undefined;
  if (!a.url) return bestArtwork(a);
  const filled = a.url.replace(/\{w\}/g, `${px}`).replace(/\{h\}/g, `${px}`);
  return filled.includes('{') ? bestArtwork(a) : filled;
}

export interface Quality {
  lossless: boolean;
  hiRes: boolean;
  atmos: boolean;
  spatial: boolean;
}

export interface Song {
  id: string;
  name: string;
  artistName: string;
  artistId?: string;
  albumId?: string;
  albumName?: string;
  discNumber: number;
  trackNumber: number;
  durationMs: number;
  hasLyrics: boolean;
  hasTimeSyncedLyrics: boolean;
  isrc?: string;
  composerName?: string;
  releaseDate?: string;
  genres: string[];
  contentRating?: string;
  quality: Quality;
  artwork?: Artwork;
}

export interface Album {
  id: string;
  name: string;
  artistName: string;
  artistId?: string;
  trackCount: number;
  releaseDate?: string;
  recordLabel?: string;
  copyright?: string;
  notes?: string;
  genres: string[];
  quality: Quality;
  artwork?: Artwork;
  tracks: Song[];
}

export interface Playlist {
  id: string;
  name: string;
  curatorName?: string;
  description?: string;
  lastModified?: string;
  artwork?: Artwork;
  tracks: Song[];
  tracksNextCursor?: string;
}

export interface LibraryPlaylist {
  id: string;
  catalogId?: string;
  name: string;
  description?: string;
  canEdit: boolean;
  trackCount: number;
  artwork?: Artwork;
  tracks: Song[];
  tracksNextCursor?: string;
}

export interface Artist {
  id: string;
  name: string;
  notes?: string;
  origin?: string;
  bornOrFormed?: string;
  genres: string[];
  artwork?: Artwork;
  albums: Album[];
  latestRelease?: Album;
  singles: Album[];
  compilations: Album[];
  appearsOn: Album[];
  topSongs: Song[];
  similarArtists: Artist[];
  artistPlaylists: Playlist[];
}

export type ItemType = 'songs' | 'albums' | 'playlists' | 'artists' | 'stations' | string;

export interface Item {
  id: string;
  type: ItemType;
  name: string;
  artistName?: string;
  curatorName?: string;
  artwork?: Artwork;
  albumName?: string;
  durationMs: number;
}

export const itemSubtitle = (i: { artistName?: string; curatorName?: string }) => i.artistName ?? i.curatorName ?? '';

export interface RecommendationGroup {
  id: string;
  title: string;
  reason?: string;
  items: Item[];
}

export interface Pin {
  type: string;
  id: string;
  catalogId?: string;
  libraryId?: string;
  name: string;
  artistName?: string;
  curatorName?: string;
  artwork?: Artwork;
}

export interface SearchResults {
  songs: Song[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
}

export interface SummaryEntry {
  name: string;
  playCount: number;
  listenTimeInMinutes: number;
  item?: Item;
}

export interface Milestone {
  id: string;
  kind: string;
  value: string;
  dateReached?: string;
  listenTimeInMinutes: number;
  artworkLight: string;
  artworkDark: string;
}

export interface Summary {
  id: string;
  period: 'year' | 'month' | string;
  name: string;
  year: number;
  month: number;
  listenTimeInMinutes: number;
  uniqueSongCount: number;
  uniqueAlbumCount: number;
  uniqueArtistCount: number;
  uniqueGenreCount: number;
  playlistId?: string;
  playlistName?: string;
  topSongs: SummaryEntry[];
  topAlbums: SummaryEntry[];
  topArtists: SummaryEntry[];
  topGenres: SummaryEntry[];
  topPlaylists: SummaryEntry[];
  topStations: SummaryEntry[];
  milestones: Milestone[];
}

export interface SummaryIndex {
  summaries: Summary[];
  latestYear: number;
  isEndOfYear: boolean;
}

export interface AppleStatus {
  /** unconfigured | starting | awaiting_2fa | ready | failed */
  state: string;
  storefront?: string;
  subscribed: boolean;
  error?: string;
  /** The Apple Music component: absent | installing | ready | failed | unsupported */
  wrapper: { state: string; tag?: string; error?: string };
}

export interface JobTrack {
  trackId: string;
  /** queued | manifest | download | decrypt | remux | tag | done | failed */
  phase: string;
  bytesDone: number;
  bytesTotal: number;
  error?: string;
}

export interface DownloadJob {
  id: string;
  type: string;
  catalogId: string;
  codec: string;
  /** queued | running | done | failed | cancelled */
  state: string;
  error?: string;
  tracks: JobTrack[];
}

export const jobIsTerminal = (j: { state: string }) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled';

export interface Lyrics {
  songId: string;
  format: string;
  ttml: string;
  lrc?: string;
  syncLevel?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export const hasMore = (p: { nextCursor?: string }) => !!p.nextCursor;

// ---- Normalising Orchard's JSON ---------------------------------------------
//
// Orchard omits empty fields; the UI wants defaults, not undefined checks
// everywhere. These mirror the Dart client's fromJson constructors.

// biome-ignore lint/suspicious/noExplicitAny: Orchard's JSON, read field by field into typed models below.
type J = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const optStr = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const arr = (v: unknown): J[] => (Array.isArray(v) ? v : []);
const art = (v: unknown): Artwork | undefined => (v && typeof v === 'object' ? { url: str((v as J).url), thumbUrl: optStr((v as J).thumbUrl) } : undefined);

const quality = (q: J | undefined): Quality => ({
  lossless: !!q?.lossless,
  hiRes: !!q?.hiRes,
  atmos: !!q?.atmos,
  spatial: !!q?.spatial,
});

export const song = (j: J): Song => ({
  id: str(j.id),
  name: str(j.name),
  artistName: str(j.artistName),
  artistId: optStr(j.artistId),
  albumId: optStr(j.albumId),
  albumName: optStr(j.albumName),
  discNumber: num(j.discNumber),
  trackNumber: num(j.trackNumber),
  durationMs: num(j.durationMs),
  hasLyrics: !!j.hasLyrics,
  hasTimeSyncedLyrics: !!j.hasTimeSyncedLyrics,
  isrc: optStr(j.isrc),
  composerName: optStr(j.composerName),
  releaseDate: optStr(j.releaseDate),
  genres: arr(j.genres).map(String),
  contentRating: optStr(j.contentRating),
  quality: quality(j.quality),
  artwork: art(j.artwork),
});

export const album = (j: J): Album => ({
  id: str(j.id),
  name: str(j.name),
  artistName: str(j.artistName),
  artistId: optStr(j.artistId),
  trackCount: num(j.trackCount),
  releaseDate: optStr(j.releaseDate),
  recordLabel: optStr(j.recordLabel),
  copyright: optStr(j.copyright),
  notes: optStr(j.notes),
  genres: arr(j.genres).map(String),
  quality: quality(j.quality),
  artwork: art(j.artwork),
  tracks: arr(j.tracks).map(song),
});

export const playlist = (j: J): Playlist => ({
  id: str(j.id),
  name: str(j.name),
  curatorName: optStr(j.curatorName),
  description: optStr(j.description),
  lastModified: optStr(j.lastModified),
  artwork: art(j.artwork),
  tracks: arr(j.tracks).map(song),
  tracksNextCursor: optStr(j.tracksNextCursor),
});

export const libraryPlaylist = (j: J): LibraryPlaylist => ({
  id: str(j.id),
  catalogId: optStr(j.catalogId),
  name: str(j.name),
  description: optStr(j.description),
  canEdit: !!j.canEdit,
  trackCount: num(j.trackCount),
  artwork: art(j.artwork),
  tracks: arr(j.tracks).map(song),
  tracksNextCursor: optStr(j.tracksNextCursor),
});

export const artist = (j: J): Artist => ({
  id: str(j.id),
  name: str(j.name),
  notes: optStr(j.notes),
  origin: optStr(j.origin),
  bornOrFormed: optStr(j.bornOrFormed),
  genres: arr(j.genres).map(String),
  artwork: art(j.artwork),
  albums: arr(j.albums).map(album),
  latestRelease: j.latestRelease && typeof j.latestRelease === 'object' ? album(j.latestRelease) : undefined,
  singles: arr(j.singles).map(album),
  compilations: arr(j.compilations).map(album),
  appearsOn: arr(j.appearsOn).map(album),
  topSongs: arr(j.topSongs).map(song),
  similarArtists: arr(j.similarArtists).map(artist),
  artistPlaylists: arr(j.artistPlaylists).map(playlist),
});

export const item = (j: J): Item => ({
  id: str(j.id),
  type: str(j.type),
  name: str(j.name),
  artistName: optStr(j.artistName),
  curatorName: optStr(j.curatorName),
  artwork: art(j.artwork),
  albumName: optStr(j.albumName),
  durationMs: num(j.durationMs),
});

const pin = (j: J): Pin => ({
  type: str(j.type),
  id: str(j.id),
  catalogId: optStr(j.catalogId),
  libraryId: optStr(j.libraryId),
  name: str(j.name),
  artistName: optStr(j.artistName),
  curatorName: optStr(j.curatorName),
  artwork: art(j.artwork),
});

const entry = (j: J): SummaryEntry => ({
  name: str(j.name),
  playCount: num(j.playCount),
  listenTimeInMinutes: num(j.listenTimeInMinutes),
  item: j.item && typeof j.item === 'object' ? item(j.item) : undefined,
});

const milestone = (j: J): Milestone => ({
  id: str(j.id),
  kind: str(j.kind),
  value: str(j.value),
  dateReached: optStr(j.dateReached),
  listenTimeInMinutes: num(j.listenTimeInMinutes),
  artworkLight: str(j.artworkLight),
  artworkDark: str(j.artworkDark),
});

export const summary = (j: J): Summary => ({
  id: str(j.id),
  period: str(j.period) || 'year',
  name: str(j.name),
  year: num(j.year),
  month: num(j.month),
  listenTimeInMinutes: num(j.listenTimeInMinutes),
  uniqueSongCount: num(j.uniqueSongCount),
  uniqueAlbumCount: num(j.uniqueAlbumCount),
  uniqueArtistCount: num(j.uniqueArtistCount),
  uniqueGenreCount: num(j.uniqueGenreCount),
  playlistId: optStr(j.playlistId),
  playlistName: optStr(j.playlistName),
  topSongs: arr(j.topSongs).map(entry),
  topAlbums: arr(j.topAlbums).map(entry),
  topArtists: arr(j.topArtists).map(entry),
  topGenres: arr(j.topGenres).map(entry),
  topPlaylists: arr(j.topPlaylists).map(entry),
  topStations: arr(j.topStations).map(entry),
  milestones: arr(j.milestones).map(milestone),
});

const status = (j: J): AppleStatus => ({
  state: str(j.state) || 'unconfigured',
  storefront: optStr(j.storefront),
  subscribed: !!j.subscribed,
  error: optStr(j.error),
  wrapper: {
    state: str(j.wrapper?.state) || 'absent',
    tag: optStr(j.wrapper?.tag),
    error: optStr(j.wrapper?.error),
  },
});

const job = (j: J): DownloadJob => ({
  id: str(j.id),
  type: str(j.type),
  catalogId: str(j.catalogId),
  codec: str(j.codec),
  state: str(j.state) || 'queued',
  error: optStr(j.error),
  tracks: arr(j.tracks).map((t: J) => ({
    trackId: str(t.trackId),
    phase: str(t.phase),
    bytesDone: num(t.bytesDone),
    bytesTotal: num(t.bytesTotal),
    error: optStr(t.error),
  })),
});

const page = <T>(j: J, key: string, map: (x: J) => T): Page<T> => ({
  items: arr(j[key]).map(map),
  nextCursor: optStr(j.nextCursor),
});

// ---- Client ---------------------------------------------------------------------

const enc = encodeURIComponent;

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export class Orchard {
  private serverUrl: string | null = null;
  private apiKey: string | null = null;

  get isConfigured(): boolean {
    return !!this.serverUrl && !!this.apiKey;
  }

  get url(): string | null {
    return this.serverUrl;
  }

  configure(serverUrl: string, apiKey: string) {
    let url = serverUrl.trim();
    if (url && !url.includes('://')) url = `https://${url}`;
    while (url.endsWith('/')) url = url.slice(0, -1);
    this.serverUrl = url;
    this.apiKey = apiKey;
  }

  clearConfig() {
    this.serverUrl = null;
    this.apiKey = null;
  }

  private require() {
    if (!this.isConfigured) throw new OrchardError('not_configured', 'Apple Music is not connected.');
  }

  private async send<T = J>(method: string, path: string, body?: unknown, timeoutMs = 60000): Promise<T> {
    this.require();
    let res: HttpResponse<J>;
    try {
      res = await elbert.http.request<J>({
        url: `${this.serverUrl}${path}`,
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        ...(body === undefined ? {} : { json: body as object }),
        responseType: 'json',
        timeoutMs,
      });
    } catch (e) {
      throw new OrchardError(errorCode(e) === 'timeout' ? 'timeout' : 'network_error', e instanceof Error ? e.message : 'Request failed');
    }
    const data = res.body;
    if (res.status >= 200 && res.status < 300) return (data ?? {}) as T;
    const err = data && typeof data === 'object' ? data.error : undefined;
    if (err && typeof err === 'object') {
      throw new OrchardError(String(err.code ?? 'error'), String(err.message ?? 'Request failed'), res.status);
    }
    // A sign-in call answers a failed attempt with its status object.
    if (data && typeof data === 'object' && typeof data.state === 'string') return data as T;
    throw new OrchardError(res.status === 404 ? 'not_found' : 'http_error', `Orchard answered ${res.status}.`, res.status);
  }

  private get<T = J>(path: string, params?: Record<string, string | number | boolean | undefined | null>) {
    return this.send<T>('GET', `${path}${params ? query(params) : ''}`);
  }

  // ---- Connection & session -----------------------------------------------

  async ping(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.getStatus();
      return { success: true };
    } catch (e) {
      return { success: false, error: errorText(e) };
    }
  }

  async getStatus() {
    return status(await this.get('/v1/apple/status'));
  }

  async login(appleId: string, password: string) {
    return status(await this.send('POST', '/v1/apple/login', { appleId, password }, 120000));
  }

  async submit2FA(code: string) {
    return status(await this.send('POST', '/v1/apple/2fa', { code }, 120000));
  }

  async logout() {
    return status(await this.send('DELETE', '/v1/apple/session'));
  }

  // ---- Personalization ----------------------------------------------------------

  async getRecommendations(): Promise<RecommendationGroup[]> {
    const j = await this.get('/v1/me/recommendations');
    return arr(j.groups).map((g: J) => ({
      id: str(g.id),
      title: str(g.title),
      reason: optStr(g.reason),
      items: arr(g.items).map(item),
    }));
  }

  async getRecentlyPlayed(limit = 10): Promise<Item[]> {
    return arr((await this.get('/v1/me/recent/played', { limit })).items).map(item);
  }

  async getPins(): Promise<Pin[]> {
    return arr((await this.get('/v1/me/library/pins')).pins).map(pin);
  }

  // ---- Replay ---------------------------------------------------------------------

  async getSummaries(year?: number): Promise<SummaryIndex> {
    const j = await this.get('/v1/me/summaries', year == null ? { period: 'year' } : { period: 'month', year });
    return { summaries: arr(j.summaries).map(summary), latestYear: num(j.latestYear), isEndOfYear: !!j.isEndOfYear };
  }

  async getSummary(id: string) {
    return summary(await this.get(`/v1/me/summaries/${enc(id)}`));
  }

  // ---- Catalog ---------------------------------------------------------------------

  async search(term: string, limit = 20, types = ['songs', 'albums', 'artists', 'playlists']): Promise<SearchResults> {
    const j = await this.get('/v1/search', { term, types: types.join(','), limit });
    return {
      songs: arr(j.songs).map(song),
      albums: arr(j.albums).map(album),
      artists: arr(j.artists).map(artist),
      playlists: arr(j.playlists).map(playlist),
    };
  }

  async getPlaylist(id: string) {
    return playlist(await this.get(`/v1/playlists/${enc(id)}`));
  }

  async getPlaylistTracks(id: string, cursor: string) {
    return page(await this.get(`/v1/playlists/${enc(id)}/tracks`, { cursor }), 'songs', song);
  }

  async getAlbum(id: string) {
    return album(await this.get(`/v1/albums/${enc(id)}`));
  }

  async getSong(id: string) {
    return song(await this.get(`/v1/songs/${enc(id)}`));
  }

  async getArtist(id: string) {
    return artist(await this.get(`/v1/artists/${enc(id)}`));
  }

  /** Null when Apple has no lyrics for the song. */
  async getLyrics(id: string): Promise<Lyrics | null> {
    try {
      const j = await this.get(`/v1/songs/${enc(id)}/lyrics`);
      return { songId: str(j.songId), format: str(j.format) || 'ttml', ttml: str(j.ttml), lrc: optStr(j.lrc), syncLevel: optStr(j.syncLevel) };
    } catch (e) {
      if (e instanceof OrchardError && e.code === 'not_found') return null;
      throw e;
    }
  }

  /** The next batch of a personalized station. Each call advances it. */
  async getStationTracks(id: string, limit = 10): Promise<Song[]> {
    return arr((await this.send('POST', `/v1/stations/${enc(id)}/next-tracks${query({ limit })}`)).songs).map(song);
  }

  // ---- The account's library ---------------------------------------------------------
  //
  // Lists come a page (100 items) at a time with a nextCursor, echoed back
  // exactly as received.

  async getLibraryPlaylists(cursor?: string) {
    return page(await this.get('/v1/me/library/playlists', { cursor }), 'playlists', libraryPlaylist);
  }

  async getLibraryPlaylist(id: string) {
    return libraryPlaylist(await this.get(`/v1/me/library/playlists/${enc(id)}`));
  }

  async getLibraryPlaylistTracks(id: string, cursor: string) {
    return page(await this.get(`/v1/me/library/playlists/${enc(id)}/tracks`, { cursor }), 'songs', song);
  }

  async getLibrarySongs(cursor?: string) {
    return page(await this.get('/v1/me/library/songs', { cursor }), 'songs', song);
  }

  /**
   * `recent` asks for newest-first (Apple's default is alphabetical). `limit`
   * must go on every request including cursor ones — Apple drops it from its
   * `next` links.
   */
  async getLibraryAlbums(opts: { cursor?: string; limit?: number; recent?: boolean } = {}) {
    return page(await this.get('/v1/me/library/albums', { cursor: opts.cursor, limit: opts.limit, sort: opts.recent ? 'recent' : undefined }), 'albums', album);
  }

  async getLibraryArtists(cursor?: string) {
    return page(await this.get('/v1/me/library/artists', { cursor }), 'artists', artist);
  }

  // Writes. Track ids are catalog song ids. Apple silently drops an id it
  // can't resolve and still answers 200.

  async createLibraryPlaylist(name: string, trackIds: string[] = [], description?: string) {
    return libraryPlaylist(
      await this.send('POST', '/v1/me/library/playlists', {
        name,
        ...(description ? { description } : {}),
        ...(trackIds.length ? { trackIds } : {}),
      }),
    );
  }

  async updateLibraryPlaylist(id: string, opts: { name?: string; description?: string }) {
    await this.send('PATCH', `/v1/me/library/playlists/${enc(id)}`, {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    });
  }

  async deleteLibraryPlaylist(id: string) {
    await this.send('DELETE', `/v1/me/library/playlists/${enc(id)}`);
  }

  async addTracksToLibraryPlaylist(id: string, trackIds: string[]) {
    if (!trackIds.length) return;
    await this.send('POST', `/v1/me/library/playlists/${enc(id)}/tracks`, { trackIds });
  }

  /**
   * Replaces the whole list — reorder and remove are both this, since Apple
   * offers neither. A paginated playlist must be fully loaded first, or the
   * pages never loaded are dropped. An empty list needs [allowEmpty].
   */
  async setLibraryPlaylistTracks(id: string, trackIds: string[], allowEmpty = false) {
    if (!trackIds.length && !allowEmpty) return;
    await this.send('PUT', `/v1/me/library/playlists/${enc(id)}/tracks`, { trackIds, allowEmpty });
  }

  // ---- Play activity ------------------------------------------------------------------

  async reportPlayActivity(opts: {
    event: 'start' | 'end';
    songId: string;
    durationMs: number;
    endPositionMs?: number;
    endReason?: string;
    containerType?: string;
    containerId?: string;
  }) {
    await this.send('POST', '/v1/me/play-activity', {
      event: opts.event,
      song_id: opts.songId,
      duration_ms: opts.durationMs,
      start_position_ms: 0,
      end_position_ms: opts.endPositionMs ?? 0,
      end_reason: opts.endReason ?? 'natural',
      ...(opts.containerType ? { container_type: opts.containerType } : {}),
      ...(opts.containerId ? { container_id: opts.containerId } : {}),
    });
  }

  // ---- Downloads ----------------------------------------------------------------------

  async createDownload(type: string, id: string, codec = 'alac') {
    return job(await this.send('POST', '/v1/downloads', { type, id, codec }));
  }

  async getJob(id: string) {
    return job(await this.get(`/v1/downloads/${enc(id)}`));
  }

  async cancelJob(id: string) {
    await this.send('DELETE', `/v1/downloads/${enc(id)}`);
  }

  /** The finished file of a job's track, written natively to [path]. */
  async downloadTrackFile(trackId: string, path: string) {
    this.require();
    await elbert.http.download({
      url: `${this.serverUrl}/v1/tracks/${enc(trackId)}/file`,
      path,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeoutMs: 600000,
    });
  }

  // ---- Streaming ------------------------------------------------------------------------

  /** Decrypted on the fly by Orchard. Not seekable. Carries the key: never persist it. */
  streamUrl(songId: string, codec = 'alac') {
    this.require();
    return `${this.serverUrl}/v1/songs/${enc(songId)}/stream${query({ codec, api_key: this.apiKey })}`;
  }
}

/** The one client the plugin uses. */
export const orchard = new Orchard();
