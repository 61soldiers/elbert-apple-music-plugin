// The Apple Music Home tab: deliberately just the account's own music. A top
// strip with the "New Music" hero and the account's pins beside it (a phone
// shows the hero alone — pins live on its Library tab), then Made For You and
// Recently Played. Until a session is ready it shows the setup flow instead.
//
// Apple's charts and editorial Browse rows used to live here and were removed
// on purpose: ~260 more cover downloads and two heavy calls per open (both
// seen returning 429), for generic filler.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { invalidate } from '../cache';
import { settings } from '../connection';
import { pins, recentlyPlayed, recommendations } from '../data';
import type { Item, Pin, RecommendationGroup } from '../orchard/client';
import { sizedArtwork } from '../orchard/client';
import { managed } from '../orchard/managed';
import {
  type Card,
  definePage,
  errorText,
  itemCard,
  onClose,
  openItem,
  openPin,
  type PageData,
  pinCard,
  RAIL_PX,
  SECTION,
  sectionChrome,
  update,
} from './common';
import { SetupFlow } from './setup';

/**
 * The "New Music" mix. A recommendation group rarely is one named mix, so this
 * searches item names flattened across every group, not group titles.
 */
export function findNewMusic(groups: RecommendationGroup[]): Item | null {
  const byId = new Map<string, Item>();
  for (const g of groups) for (const it of g.items) if (!byId.has(it.id)) byId.set(it.id, it);
  let loose: Item | null = null;
  for (const it of byId.values()) {
    if (it.type !== 'playlists') continue;
    const name = it.name.toLowerCase();
    if (name === 'new music') return it;
    if (!loose && name.includes('new music')) loose = it;
  }
  return loose;
}

interface State {
  setup: SetupFlow;
  groups: RecommendationGroup[];
  recent: Item[];
  pins: Pin[];
  hero: Item | null;
  loaded: boolean;
}

function groupCard(g: RecommendationGroup): Card {
  const item = g.items[0];
  return {
    id: g.id,
    title: g.title || item?.name || 'Mix',
    subtitle: g.reason ?? (item ? itemCard(item).subtitle : ''),
    cover: sizedArtwork(item?.artwork, RAIL_PX),
    placeholderIcon: 'sparkles',
  };
}

async function load(page: Page<PageData, State>, force = false) {
  const s = page.state;
  if (force) {
    invalidate('recs');
    invalidate('recent');
    invalidate('pins');
  }
  const recs = recommendations()
    .then((groups) => {
      s.groups = groups;
      s.hero = findNewMusic(groups);
      update(page, {
        recsStatus: 'ready',
        hasHero: !!s.hero,
        hero: s.hero ? { title: s.hero.name, caption: 'Your weekly mix of new releases', cover: sizedArtwork(s.hero.artwork, RAIL_PX) } : undefined,
        hasGroups: groups.length > 0,
        groups: groups.map(groupCard),
      });
    })
    .catch((e) => update(page, { recsStatus: 'error', recsError: errorText(e) }));
  const recent = recentlyPlayed()
    .then((items) => {
      s.recent = items;
      update(page, { recentStatus: items.length ? 'ready' : 'empty', recent: items.map((i) => itemCard(i)) });
    })
    .catch((e) => update(page, { recentStatus: 'error', recentError: errorText(e) }));
  const pinned = pins()
    .then((list) => {
      s.pins = list;
      update(page, { pins: list.map(pinCard) });
    })
    .catch(() => {});
  await Promise.all([recs, recent, pinned]);
}

definePage<PageData, State>('home', {
  open(page) {
    const s = page.state as State;
    s.groups = [];
    s.recent = [];
    s.pins = [];
    s.hero = null;
    s.loaded = false;

    const render = () => {
      const ready = s.setup.ready;
      update(page, { mode: ready ? 'ready' : 'setup', setup: s.setup.data() });
      if (ready && !s.loaded) {
        s.loaded = true;
        void load(page);
      }
    };
    s.setup = new SetupFlow(render);
    onClose(page, () => s.setup.dispose());
    // A managed server out of date with the bundled source is rebuilt on open.
    if (settings.orchardEnabled && settings.orchardManaged) void managed.ensureCurrent();
    setTimeout(render, 0);

    return {
      mode: 'setup',
      setup: s.setup.data(),
      ...sectionChrome(page, SECTION),
      recsStatus: 'loading',
      recentStatus: 'loading',
      hasHero: false,
      hasGroups: false,
      groups: [],
      recent: [],
      pins: [],
    };
  },
  events: {
    setup(page, args) {
      return page.state.setup.handle(args);
    },
    refresh(page) {
      return load(page, true);
    },
    hero(page) {
      const hero = page.state.hero;
      if (hero) return openItem(hero);
    },
    pin(page, { index }) {
      const pin = page.state.pins[index];
      if (pin) return openPin(pin);
    },
    group(page, { index }) {
      const item = page.state.groups[index]?.items[0];
      if (item) return openItem(item);
    },
    recent(page, { index }) {
      const item = page.state.recent[index];
      if (item) return openItem(item);
    },
    library() {
      return elbert.ui.navigate('/', { mode: 'go' });
    },
    downloads() {
      return elbert.ui.navigate(`${SECTION}/downloads`);
    },
  },
});
