// The Downloads tab: search the catalog or paste a music.apple.com link, send
// it to disk, and watch every job — including ones started from an album or
// playlist page — until it lands.
//
// Albums download as one Orchard `album` job. Playlists never do: they fan
// out into one `song` job per track (far more reliable), from here as from
// everywhere else.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { album as fetchAlbum } from '../data';
import {
  allRecords,
  cancel,
  clearFinished,
  type DownloadRecord,
  dismiss,
  downloadSongs,
  failedTracks,
  onDownloadsChange,
  recordIsActive,
  recordIsTerminal,
  recordProgress,
  savedFolder,
  savedTracks,
  songJob,
  startDownload,
  type TrackProgress,
} from '../downloads';
import { type AppleMusicLink, parseAppleMusicLink } from '../link';
import { bestArtwork, OrchardError, orchard, type Song } from '../orchard/client';
import { definePage, errorText, onClose, type PageData, SECTION, sectionChrome, update } from './common';

type Kind = 'song' | 'album' | 'playlist';

interface Result {
  kind: Kind;
  id: string;
  name: string;
  subtitle: string;
  cover?: string;
  /** Songs carry everything a download needs already. */
  song?: Song;
}

interface State {
  results: Result[];
  link: Result | null;
  fetching: Set<string>;
  timer: number | null;
  seq: number;
  resets: number;
}

type P = Page<PageData, State>;

const TYPE_ICON: Record<Kind, string> = { song: 'music', album: 'disc', playlist: 'list-music' };
const TYPE_LABEL: Record<Kind, string> = { song: 'Song', album: 'Album', playlist: 'Playlist' };

const fromSong = (s: Song): Result => ({ kind: 'song', id: s.id, name: s.name, subtitle: s.artistName, cover: bestArtwork(s.artwork), song: s });

/**
 * A bare numeric id is ambiguous between a song and an album, so it is
 * probed: album first, then song on a 404.
 */
async function resolveLink(link: AppleMusicLink): Promise<Result> {
  switch (link.kind) {
    case 'song':
      return fromSong(await orchard.getSong(link.id));
    case 'album': {
      const a = await orchard.getAlbum(link.id);
      return { kind: 'album', id: a.id, name: a.name, subtitle: a.artistName, cover: bestArtwork(a.artwork) };
    }
    case 'playlist': {
      const p = await orchard.getPlaylist(link.id);
      return { kind: 'playlist', id: p.id, name: p.name, subtitle: p.curatorName ?? 'Playlist', cover: bestArtwork(p.artwork) };
    }
    default:
      try {
        const a = await orchard.getAlbum(link.id);
        return { kind: 'album', id: a.id, name: a.name, subtitle: a.artistName, cover: bestArtwork(a.artwork) };
      } catch (e) {
        if (!(e instanceof OrchardError) || e.code !== 'not_found') throw e;
        return fromSong(await orchard.getSong(link.id));
      }
  }
}

// ---- Rendering ---------------------------------------------------------------------------

const PHASE_LABEL: Record<string, string> = {
  queued: 'Queued',
  manifest: 'Resolving',
  download: 'Downloading',
  decrypt: 'Decrypting',
  remux: 'Tagging',
  tag: 'Tagging',
  done: 'Saving',
};

function trackLine(t: TrackProgress) {
  const failed = t.saveError != null || t.phase === 'failed';
  if (failed) return { icon: 'circle-x', tone: 'error', text: t.name, trailing: 'Failed' };
  if (t.savedToDisk) return { icon: 'circle-check', tone: 'primary', text: t.name, trailing: 'Saved' };
  return { icon: 'loader-circle', tone: 'onSurfaceVariant', text: t.name, trailing: PHASE_LABEL[t.phase] ?? t.phase };
}

function recordCard(r: DownloadRecord) {
  const failed = failedTracks(r);
  const [icon, tone, label] =
    r.state === 'queued'
      ? ['clock', 'onSurfaceVariant', 'Queued']
      : r.state === 'running'
        ? ['loader-circle', 'primary', 'Downloading']
        : r.state === 'done' && failed > 0
          ? ['circle-alert', 'error', `${failed} track(s) failed`]
          : r.state === 'done'
            ? ['circle-check', 'primary', 'Done']
            : r.state === 'failed'
              ? ['circle-x', 'error', r.error ?? 'Failed']
              : r.state === 'cancelled'
                ? ['circle-x', 'onSurfaceVariant', 'Cancelled']
                : ['clock', 'onSurfaceVariant', r.state];
  const total = r.tracks.size;
  const active = recordIsActive(r);
  const folder = active ? null : savedFolder(r);
  return {
    id: r.jobId,
    title: r.label,
    subtitle: r.subtitle ?? '',
    cover: r.artworkUrl,
    status: total > 1 ? `${label} · ${savedTracks(r)}/${total} tracks` : label,
    statusIcon: icon,
    statusTone: tone,
    // Indeterminate while queued.
    ...(r.state === 'queued' ? {} : { progress: recordProgress(r) }),
    failed: r.state === 'failed',
    lines: total > 1 ? [...r.tracks.values()].map(trackLine) : [],
    active,
    hasFolder: folder != null,
  };
}

function resultData(r: Result, busy: boolean) {
  return { id: r.id, title: r.name, subtitle: r.subtitle, cover: r.cover, typeIcon: TYPE_ICON[r.kind], busy };
}

function renderRecords(page: P) {
  const records = allRecords();
  update(page, {
    records: records.map(recordCard),
    hasRecords: records.length > 0,
    actions: [{ id: 'clear', label: 'Clear completed', icon: 'trash-2', disabled: !records.some((r) => recordIsTerminal(r) && !recordIsActive(r)) }],
  });
}

function renderResults(page: P) {
  const s = page.state;
  update(page, {
    results: s.results.map((r, index) => ({ ...resultData(r, s.fetching.has(r.id)), index })),
    ...(s.link
      ? {
          hasLink: true,
          link: {
            ...resultData(s.link, s.fetching.has(s.link.id)),
            badge: TYPE_LABEL[s.link.kind],
            ...(s.link.kind === 'playlist' ? { note: 'Downloads as individual tracks' } : {}),
          },
        }
      : { hasLink: false }),
  });
}

// ---- Searching -------------------------------------------------------------------------------

function reset(page: P) {
  const s = page.state;
  s.results = [];
  s.link = null;
  s.seq++;
  update(page, { mode: 'idle', resetKey: `r${++s.resets}` });
  renderResults(page);
}

async function runSearch(page: P, term: string, seq: number) {
  const s = page.state;
  try {
    const res = await orchard.search(term);
    if (seq !== s.seq) return;
    s.results = [
      ...res.songs.map(fromSong),
      ...res.albums.map((a): Result => ({ kind: 'album', id: a.id, name: a.name, subtitle: a.artistName, cover: bestArtwork(a.artwork) })),
      ...res.playlists.map((p): Result => ({ kind: 'playlist', id: p.id, name: p.name, subtitle: p.curatorName ?? 'Playlist', cover: bestArtwork(p.artwork) })),
    ];
    update(page, { mode: 'results' });
    renderResults(page);
  } catch (e) {
    if (seq === s.seq) update(page, { mode: 'error', error: errorText(e) });
  }
}

async function runLink(page: P, link: AppleMusicLink, seq: number) {
  const s = page.state;
  try {
    const r = await resolveLink(link);
    if (seq !== s.seq) return;
    s.link = r;
    update(page, { mode: 'link' });
    renderResults(page);
  } catch (e) {
    if (seq !== s.seq) return;
    update(page, {
      mode: 'error',
      error: e instanceof OrchardError && e.code === 'not_found' ? "Couldn't find that link — double check it and try again." : errorText(e),
    });
  }
}

async function download(page: P, r: Result) {
  const s = page.state;
  s.fetching.add(r.id);
  renderResults(page);
  try {
    switch (r.kind) {
      case 'song':
        if (r.song) await startDownload(songJob(r.song, { subtitle: r.subtitle, artworkUrl: r.cover }));
        break;
      case 'album': {
        const a = await fetchAlbum(r.id);
        await startDownload({ type: 'album', catalogId: r.id, label: r.name, subtitle: r.subtitle, artworkUrl: r.cover, tracks: a.tracks });
        break;
      }
      case 'playlist': {
        // The whole playlist, not its first page.
        const p = await orchard.getPlaylist(r.id);
        const tracks = [...p.tracks];
        let cursor = p.tracksNextCursor;
        while (cursor) {
          const next = await orchard.getPlaylistTracks(r.id, cursor);
          tracks.push(...next.items);
          cursor = next.nextCursor;
        }
        await downloadSongs(tracks, { label: p.name, artworkUrl: r.cover });
        await elbert.ui.toast(`Downloading "${p.name}" as ${tracks.length} individual track(s)…`);
      }
    }
    if (s.link) reset(page);
  } catch (e) {
    await elbert.ui.toast(`Could not start download: ${errorText(e)}`);
  } finally {
    s.fetching.delete(r.id);
    renderResults(page);
  }
}

definePage<PageData, State>('downloads', {
  open(page) {
    const s = page.state;
    s.results = [];
    s.link = null;
    s.fetching = new Set();
    s.timer = null;
    s.seq = 0;
    s.resets = 0;
    onClose(
      page,
      onDownloadsChange(() => renderRecords(page)),
    );
    onClose(page, () => {
      if (s.timer != null) clearTimeout(s.timer);
    });
    setTimeout(() => renderRecords(page), 0);
    return { ...sectionChrome(page, `${SECTION}/downloads`), mode: 'idle', results: [], hasLink: false, records: [], hasRecords: false, actions: [] };
  },
  events: {
    query(page, { query }) {
      const s = page.state;
      const value = String(query ?? '');
      if (s.timer != null) clearTimeout(s.timer);
      const seq = ++s.seq;
      const link = parseAppleMusicLink(value);
      if (!link) {
        s.link = null;
        if (value.trim().length < 2) {
          s.results = [];
          update(page, { mode: 'idle' });
          renderResults(page);
          return;
        }
        s.timer = setTimeout(() => {
          update(page, { mode: 'busy' });
          void runSearch(page, value.trim(), seq);
        }, 500);
        return;
      }
      // A pasted link replaces the search with one resolved preview card.
      s.results = [];
      s.link = null;
      renderResults(page);
      s.timer = setTimeout(() => {
        update(page, { mode: 'busy' });
        void runLink(page, link, seq);
      }, 300);
    },
    clear(page) {
      reset(page);
    },
    download(page, { index }) {
      const r = page.state.results[index];
      if (r) return download(page, r);
    },
    downloadLink(page) {
      if (page.state.link) return download(page, page.state.link);
    },
    cancel(_page, { id }) {
      return cancel(id);
    },
    dismiss(_page, { id }) {
      dismiss(id);
    },
    viewFiles(_page, { id }) {
      const r = allRecords().find((x) => x.jobId === id);
      const folder = r && savedFolder(r);
      if (folder) return elbert.ui.reveal(folder);
    },
    action(_page, { id }) {
      if (id === 'clear') clearFinished();
    },
  },
});
