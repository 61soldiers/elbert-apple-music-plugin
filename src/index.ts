// Apple Music for Elbert. Activation wires everything the plugin contributes:
// the section (navigation, the phone dock, routes), its Settings page, the
// track and playlist actions, and lyrics for streamed songs. The pages
// themselves register as their modules load.

import { startActivity } from './activity';
import { startConnection } from './connection';
import { redownload } from './downloads';
import { DOWNLOADED_PREFIX, streamedCatalogIdOf } from './ids';
import { orchard } from './orchard/client';
import { errorText } from './pages/common';
import { SECTION } from './playback';
import { resync } from './playlists';

import './pages/home';
import './pages/search';
import './pages/library';
import './pages/playlists';
import './pages/library_playlist';
import './pages/detail';
import './pages/artist';
import './pages/replay';
import './pages/downloads';
import './pages/settings';
import './pages/privacy';
import './pages/songs';

elbert.onActivate(async () => {
  await startConnection();
  startActivity();

  await elbert.ui.setNavigation({
    destinations: [{ label: 'Apple Music', icon: 'music-4', route: SECTION }],
    // On a phone the section takes the dock over rather than carrying a tab
    // strip of its own. Playlists and Downloads aren't here — Library opens
    // them. Settings is Elbert's own, mounted under the section so the dock
    // stays Apple Music's while it is open.
    compact: {
      prefix: SECTION,
      destinations: [
        { label: 'Home', icon: 'house', route: SECTION },
        { label: 'Search', icon: 'search', route: `${SECTION}/search` },
        { label: 'Library', icon: 'library', route: `${SECTION}/library` },
        { label: 'Replay', icon: 'chart-no-axes-column', route: `${SECTION}/replay` },
        { label: 'Settings', icon: 'settings', route: `${SECTION}/settings` },
      ],
    },
  });

  await elbert.ui.setRoutes([
    { path: SECTION, page: 'home', widget: 'home:HomePage' },
    { path: `${SECTION}/search`, page: 'search', widget: 'search:SearchPage' },
    { path: `${SECTION}/library`, page: 'library', widget: 'library:LibraryPage' },
    { path: `${SECTION}/library/playlists/:id`, page: 'libraryPlaylist', widget: 'library_playlist:LibraryPlaylistPage', transition: 'slide' },
    { path: `${SECTION}/library/:list`, page: 'libraryList', widget: 'library:LibraryListPage', transition: 'slide' },
    { path: `${SECTION}/playlists`, page: 'playlists', widget: 'playlists:PlaylistsPage', transition: 'slide' },
    { path: `${SECTION}/playlists/:id`, page: 'playlistDetail', widget: 'detail:DetailPage', transition: 'slide' },
    { path: `${SECTION}/albums/:id`, page: 'albumDetail', widget: 'detail:DetailPage', transition: 'slide' },
    { path: `${SECTION}/songs/:id`, page: 'songDetail', widget: 'detail:DetailPage', transition: 'slide' },
    { path: `${SECTION}/artists/:id`, page: 'artist', widget: 'artist:ArtistPage', transition: 'slide' },
    { path: `${SECTION}/replay`, page: 'replay', widget: 'replay:ReplayPage' },
    { path: `${SECTION}/replay/:id`, page: 'replayMonth', widget: 'replay:ReplayMonthPage', transition: 'slide' },
    { path: `${SECTION}/downloads`, page: 'downloads', widget: 'downloads:DownloadsPage' },
    { path: `${SECTION}/settings`, host: 'settings' },
    { path: `${SECTION}/settings/:section`, host: 'settingsSection', transition: 'slide' },
  ]);

  await elbert.ui.setSettings({
    title: 'Apple Music',
    subtitle: 'Orchard server, sign-in and listening history',
    icon: 'music-4',
    page: 'settings',
    widget: 'settings:SettingsPage',
  });

  await elbert.ui.setTrackActions([
    {
      id: 'redownload',
      label: 'Re-download from Apple Music',
      icon: 'refresh-cw',
      when: { idPrefix: [DOWNLOADED_PREFIX] },
      async run(track) {
        try {
          await redownload(track);
          return `Re-downloading "${track.title}" from Apple Music…`;
        } catch (e) {
          return errorText(e);
        }
      },
    },
  ]);

  await elbert.ui.setPlaylistActions([
    {
      id: 'resync',
      label: 'Sync from Apple Music',
      shortLabel: 'Sync',
      icon: 'folder-sync',
      run(playlist) {
        if (!playlist.linkRemoteId) return 'This playlist is not linked to Apple Music.';
        return resync(playlist.linkRemoteId);
      },
    },
  ]);

  // Streams only: a downloaded song's lyrics are the .lrc sidecar written
  // next to its file, which Elbert finds like any other local file's.
  await elbert.lyrics.provide(async (track) => {
    const id = streamedCatalogIdOf(track.id);
    if (!id || !orchard.isConfigured) return null;
    try {
      return (await orchard.getLyrics(id))?.lrc ?? null;
    } catch {
      return null;
    }
  });
});
