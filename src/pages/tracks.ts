// What a page listing Apple Music songs keeps track of: which songs are
// already on disk (and under which library id), and the download jobs it
// started — so each row can say "working", "failed" or "in your library".
//
// Pages call `watch` once with a redraw function; local matches are redone
// whenever the library changes (a download landing makes a row local), and
// row statuses whenever a download progresses.

import type { LibraryTrack, Page } from '@evolvedmesh/elbert-plugin-sdk';
import {
  downloadSongs,
  failedTracks,
  onDownloadsChange,
  recordFor,
  recordIsActive,
  recordProgress,
  savedFolder,
  savedTracks,
  songJob,
  startDownload,
  type TrackProgress,
} from '../downloads';
import type { Song } from '../orchard/client';
import { localMatches } from '../playback';
import { errorText, onClose, songRow } from './common';
import { songAction } from './songs';

type RowStatus = 'none' | 'working' | 'failed' | 'saved';

function statusOf(p: TrackProgress | undefined): RowStatus {
  if (!p) return 'none';
  if (p.saveError != null || p.phase === 'failed') return 'failed';
  if (p.savedToDisk) return 'saved';
  return 'working';
}

export class SongList {
  songs: Song[] = [];
  local: (LibraryTrack | null)[] = [];
  /** A whole-collection download: one album job, or one job per playlist track. */
  bulkJobs: string[] = [];
  private perTrack = new Map<string, string>();
  private matching = 0;

  constructor(private readonly redraw: () => void) {}

  /** Keeps rows current while [page] is open. */
  watch<D extends object, S extends object>(page: Page<D, S>) {
    onClose(
      page,
      onDownloadsChange(() => this.redraw()),
    );
    onClose(
      page,
      elbert.library.onChange(() => void this.match()),
    );
  }

  /** Replaces the songs and re-matches them against the library. */
  async set(songs: Song[]) {
    this.songs = songs;
    this.local = songs.map(() => null);
    await this.match();
  }

  async match() {
    const run = ++this.matching;
    const songs = this.songs;
    const local = await localMatches(songs);
    if (run !== this.matching) return;
    this.local = local;
    this.redraw();
  }

  progressFor(songId: string): TrackProgress | undefined {
    for (const id of this.bulkJobs) {
      const p = recordFor(id)?.tracks.get(songId);
      if (p) return p;
    }
    const job = this.perTrack.get(songId);
    return job ? recordFor(job)?.tracks.get(songId) : undefined;
  }

  rows(opts: { showCover?: boolean; fallbackCover?: string } = {}) {
    return this.songs.map((s, i) => {
      const p = this.progressFor(s.id);
      const status = statusOf(p);
      const localId = this.local[i]?.id ?? null;
      const row = songRow(s, { localId, status: status === 'none' && localId ? 'saved' : status, showCover: opts.showCover });
      return {
        ...row,
        cover: row.cover ?? opts.fallbackCover,
        ...(status === 'failed' ? { statusError: p?.saveError ?? p?.error ?? 'Download failed — retry from the ⋯ menu' } : {}),
        isLocal: localId != null,
      };
    });
  }

  /** A row's ⋯ pick. A download from a row replaces a local copy ("Download again"). */
  menu(index: number, action: string) {
    return songAction(this.songs, index, action, {
      local: this.local,
      onDownload: async (song) => {
        try {
          const job = await startDownload(songJob(song, { replaceLocalMatch: true }));
          this.perTrack.set(song.id, job);
          this.redraw();
        } catch (e) {
          await elbert.ui.toast(errorText(e));
        }
      },
    });
  }

  // ---- Download all ----------------------------------------------------------------

  get bulkActive() {
    return this.bulkJobs.some((id) => {
      const r = recordFor(id);
      return r != null && recordIsActive(r);
    });
  }

  /** Progress data for a `ProgressLine` under the buttons, or nothing. */
  bulkData() {
    const records = this.bulkJobs.map(recordFor).filter((r) => r != null);
    if (!records.length) return { hasBulk: false, bulkActive: false };
    const progress = records.reduce((sum, r) => sum + recordProgress(r), 0) / records.length;
    const saved = records.reduce((sum, r) => sum + savedTracks(r), 0);
    const total = records.reduce((sum, r) => sum + r.tracks.size, 0);
    const failed = records.reduce((sum, r) => sum + failedTracks(r), 0);
    const active = this.bulkActive;
    // A playlist's tracks can land in several album folders: this is one of
    // them, still more use than none once the batch is done.
    const folder = active ? null : (records.map(savedFolder).find((f) => f != null) ?? null);
    return {
      hasBulk: true,
      bulkActive: active,
      bulkProgress: progress,
      bulkCaption: `${saved}/${total} saved${failed > 0 ? ` · ${failed} failed` : ''}`,
      hasBulkFolder: folder != null,
      bulkFolder: folder ?? '',
    };
  }

  /**
   * Download all: an album is one Orchard `album` job; anything else fans
   * out into one `song` job per track (far more reliable). [songs] must be
   * the complete list — callers drain pagination first.
   */
  async downloadAll(songs: Song[], opts: { albumId?: string; label: string; subtitle?: string; artworkUrl?: string }) {
    if (!songs.length) return;
    try {
      this.bulkJobs = await downloadSongs(songs, opts);
      this.redraw();
    } catch (e) {
      await elbert.ui.toast(`Download failed: ${errorText(e)}`);
    }
  }
}
