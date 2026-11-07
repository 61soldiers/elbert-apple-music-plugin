// Reorder or remove songs / Rename / Sync to library / Delete for one of the account's own
// playlists — shared by both pages a playlist can open on. The catalog page
// and the library page are reached by different routes depending on where it
// was tapped (a pin, a Home rail, a search result and the Playlists page
// don't all agree), and the actions must be there either way.
//
// Every action needs the **library** id (`p.*`): Apple's write routes refuse
// a catalog id, so the catalog page resolves one first (`ownedPlaylist`).

import type { Song } from '../orchard/client';
import { deletePlaylist, renamePlaylist, syncMessage, syncToLibrary } from '../playlists';
import { errorText, routes } from './common';

export interface PlaylistActionTarget {
  libraryId: string;
  name: string;
  /** The playlist's *complete* track list: a sync writes exactly what it's given. */
  loadAll: () => Promise<Song[]>;
  /** Reorder in place; when absent, reordering opens the library page that can. */
  editOrder?: () => Promise<void>;
  /** Hide reordering entirely (an empty playlist). */
  noOrder?: boolean;
  setBusy: (busy: boolean) => void;
  renamed: (name: string) => void;
  /** Leaves the page once the playlist is gone. */
  deleted: () => void;
}

/**
 * The items of the page header's ⋯ menu (`StickyHeader.menu`), worded and
 * ordered as on Elbert's own playlist page. [editing] turns "Reorder or remove
 * songs" into "Done editing".
 */
export function playlistActions(busy: boolean, withOrder: boolean, editing = false) {
  return [
    ...(withOrder
      ? [
          editing
            ? { id: 'order', label: 'Done editing', icon: 'circle-check', disabled: busy }
            : { id: 'order', label: 'Reorder or remove songs', icon: 'list-checks', disabled: busy },
        ]
      : []),
    { id: 'rename', label: 'Rename', icon: 'pencil-line', disabled: busy },
    { id: 'sync', label: 'Sync to library', icon: 'folder-sync', busy, disabled: busy },
    { id: 'delete', label: 'Delete playlist', icon: 'trash-2', destructive: true, disabled: busy },
  ];
}

export async function runPlaylistAction(id: string, t: PlaylistActionTarget) {
  switch (id) {
    case 'rename': {
      const name = await elbert.ui.prompt({ title: 'Rename playlist', hint: 'Playlist name', initial: t.name, confirmLabel: 'Rename' });
      if (!name?.trim()) return;
      const error = await renamePlaylist(t.libraryId, name);
      if (!error) t.renamed(name.trim());
      return elbert.ui.toast(error ?? `Renamed to "${name.trim()}".`);
    }
    case 'order':
      if (t.editOrder) return t.editOrder();
      return elbert.ui.navigate(routes.libraryPlaylist(t.libraryId));
    case 'sync': {
      t.setBusy(true);
      try {
        const songs = await t.loadAll();
        await elbert.ui.toast(`Syncing "${t.name}" to your library…`);
        const result = await syncToLibrary(t.libraryId, t.name, songs);
        await elbert.ui.toast(syncMessage(t.name, result));
      } catch (e) {
        await elbert.ui.toast(errorText(e));
      } finally {
        t.setBusy(false);
      }
      return;
    }
    case 'delete': {
      const ok = await elbert.ui.confirm({
        title: 'Delete playlist?',
        message: `This removes "${t.name}" from your Apple Music library on every device signed in to this account.`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      const error = await deletePlaylist(t.libraryId);
      if (error) return elbert.ui.toast(error);
      t.deleted();
    }
  }
}
