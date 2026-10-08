// The card shape every rail and grid draws, and how an Orchard item becomes
// one. Pure (no `elbert` global), so shelves can be tested directly.

import { type Item, itemSubtitle, sizedArtwork } from './orchard/client';

/** Rail artwork: Apple sizes it for us, ~24 KB at 400 px against ~41 KB for the largest. */
export const RAIL_PX = 400;

export interface Card {
  id: string;
  title: string;
  subtitle: string;
  cover?: string;
  placeholderIcon?: string;
}

export const itemCard = (i: Item, px = RAIL_PX): Card => ({
  id: i.id,
  title: i.name,
  subtitle: i.type === 'stations' ? itemSubtitle(i) || 'Station' : itemSubtitle(i),
  cover: sizedArtwork(i.artwork, px),
  placeholderIcon: i.type === 'stations' ? 'radio' : 'music',
});
