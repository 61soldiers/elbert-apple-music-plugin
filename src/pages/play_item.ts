// Playing a card straight from Home — its hover Play button, or the
// spotlight's — without opening its page. Costs the one request the page
// would have made (cached, so opening it afterwards is free), and only when
// tapped.

import { type PlayContext, rememberContext } from '../activity';
import { album, artist, playlist, song } from '../data';
import type { Item, Song } from '../orchard/client';
import { playSongs } from '../playback';
import { errorText, startStation } from './common';

async function songsOf(item: Item): Promise<{ songs: Song[]; context: PlayContext | null }> {
  switch (item.type) {
    case 'albums':
      return { songs: (await album(item.id)).tracks, context: { kind: 'album', id: item.id } };
    case 'playlists':
      return { songs: (await playlist(item.id)).tracks, context: { kind: 'playlist', id: item.id } };
    case 'artists':
      return { songs: (await artist(item.id)).topSongs, context: { kind: 'artist', id: item.id } };
    case 'songs':
      return { songs: [await song(item.id)], context: null };
    default:
      return { songs: [], context: null };
  }
}

/** Plays [item] from the start: a station starts, anything else plays its tracks. */
export async function playItem(item: Item) {
  if (item.type === 'stations') return startStation(item.id, item.name);
  try {
    const { songs, context } = await songsOf(item);
    if (!songs.length) return elbert.ui.toast(`Nothing to play in "${item.name}".`);
    // Plays land in Apple's Recently Played under this album or playlist.
    rememberContext(
      songs.map((s) => s.id),
      context,
    );
    await playSongs(songs, 0);
  } catch (e) {
    await elbert.ui.toast(errorText(e));
  }
}
