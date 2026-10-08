// The Apple Music Home tab, laid out like the Apple Music app's own: a top
// strip with the "New Music" hero and the account's pins beside it (a phone
// shows the hero alone — pins live on its Library tab), then a feed of shelves
// — Recently Played, Playlists Made for You, Stations for You, New Releases
// for You, Acoustic, … — and Replay last. Until a session is ready it shows
// the setup flow instead.
//
// Request budget. Home costs three requests however many shelves Apple has:
// `/v1/me/recommendations` (MusicKit's Get Recommendations — the whole feed in
// one answer, cached 15 min), Recently Played, and the pins; Replay adds one
// when it scrolls into view. The shelves are already in hand, so revealing
// them as you scroll saves widgets and cover downloads (a few dozen at a
// time, not ~200), not requests. A pull-to-refresh within REFRESH_COOLDOWN of
// the last one is served from the cache.
//
// Apple's charts and editorial Browse rows used to live here and were removed
// on purpose: ~260 more cover downloads and two heavy calls per open (both
// seen returning 429), for generic filler. Don't reinstate them.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { invalidate } from '../cache';
import { settings } from '../connection';
import { pins, recentlyPlayed, recommendations, replayYears } from '../data';
import type { Item, Pin, RecommendationGroup } from '../orchard/client';
import { sizedArtwork } from '../orchard/client';
import { managed } from '../orchard/managed';
import { buildShelves, replayCard, type Shelf, shelfData, shelfItem } from '../shelves';
import { definePage, errorText, onClose, openItem, openPin, type PageData, pinCard, RAIL_PX, SECTION, sectionChrome, update } from './common';
import { SetupFlow } from './setup';

/** Shelves drawn on open, and added each time the end of the feed scrolls into view. */
const FIRST_SHELVES = 4;
const MORE_SHELVES = 3;

/** A pull-to-refresh sooner than this after the last real one re-reads the cache. */
const REFRESH_COOLDOWN = 20_000;

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

type Load = 'loading' | 'ready' | 'error';

interface State {
  setup: SetupFlow;
  groups: RecommendationGroup[];
  recent: Item[];
  pins: Pin[];
  hero: Item | null;
  shelves: Shelf[];
  revealed: number;
  recs: Load;
  recentLoad: Load;
  replayRequested: boolean;
  lastRefresh: number;
  loaded: boolean;
}

/** Draws the revealed shelves, and — once the feed is exhausted — asks for Replay. */
function showShelves(page: Page<PageData, State>) {
  const s = page.state;
  s.shelves = buildShelves(s.groups, s.recent);
  const visible = s.shelves.slice(0, s.revealed);
  const settled = s.recs !== 'loading' && s.recentLoad !== 'loading';
  const exhausted = settled && s.revealed >= s.shelves.length;
  update(page, {
    shelvesStatus: visible.length ? 'ready' : settled ? 'empty' : 'loading',
    shelves: visible.map((shelf, i) => shelfData(shelf, i < FIRST_SHELVES ? i * 50 : 0)),
    hasMoreShelves: settled && !exhausted,
  });
  if (exhausted && !s.replayRequested) {
    s.replayRequested = true;
    void loadReplay(page);
  }
}

async function loadReplay(page: Page<PageData, State>) {
  update(page, { replayStatus: 'loading' });
  try {
    const card = replayCard(await replayYears());
    if (page.closed) return;
    update(page, card ? { replayStatus: 'ready', replay: card } : { replayStatus: 'none' });
  } catch {
    // Replay is a bonus on Home; the Replay tab shows the real error.
    update(page, { replayStatus: 'none' });
  }
}

async function load(page: Page<PageData, State>, force = false) {
  const s = page.state;
  if (force && Date.now() - s.lastRefresh >= REFRESH_COOLDOWN) {
    s.lastRefresh = Date.now();
    invalidate('recs');
    invalidate('recent');
    invalidate('pins');
    invalidate('replay:index');
  }
  s.revealed = FIRST_SHELVES;
  s.replayRequested = false;
  update(page, { replayStatus: 'idle' });

  const recs = recommendations()
    .then((groups) => {
      s.groups = groups;
      s.hero = findNewMusic(groups);
      s.recs = 'ready';
      update(page, {
        recsStatus: 'ready',
        hasHero: !!s.hero,
        hero: s.hero ? { title: s.hero.name, caption: 'Your weekly mix of new releases', cover: sizedArtwork(s.hero.artwork, RAIL_PX) } : undefined,
      });
    })
    .catch((e) => {
      s.recs = 'error';
      update(page, { recsStatus: 'error', recsError: errorText(e) });
    });
  const recent = recentlyPlayed()
    .then((items) => {
      s.recent = items;
      s.recentLoad = 'ready';
    })
    .catch(() => {
      // Apple's own Recently Played group (in the recommendations) stands in.
      s.recent = [];
      s.recentLoad = 'error';
    });
  const pinned = pins()
    .then((list) => {
      s.pins = list;
      update(page, { pins: list.map(pinCard) });
    })
    .catch(() => {});

  // Draw as soon as either feed lands; the order is rebuilt when the other does.
  const draw = () => showShelves(page);
  await Promise.all([recs.then(draw), recent.then(draw), pinned]);
}

definePage<PageData, State>('home', {
  open(page) {
    const s = page.state as State;
    s.groups = [];
    s.recent = [];
    s.pins = [];
    s.hero = null;
    s.shelves = [];
    s.revealed = FIRST_SHELVES;
    s.recs = 'loading';
    s.recentLoad = 'loading';
    s.replayRequested = false;
    s.lastRefresh = 0;
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
      shelvesStatus: 'loading',
      replayStatus: 'idle',
      hasHero: false,
      hasMoreShelves: false,
      shelves: [],
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
    // The end of the feed scrolled into view: draw a few more shelves. The
    // trigger fires once per build of the end marker; the guard covers a
    // late one after the last shelf is already out.
    more(page) {
      const s = page.state;
      if (s.revealed >= s.shelves.length) return;
      s.revealed += MORE_SHELVES;
      showShelves(page);
    },
    hero(page) {
      const hero = page.state.hero;
      if (hero) return openItem(hero);
    },
    pin(page, { index }) {
      const pin = page.state.pins[index];
      if (pin) return openPin(pin);
    },
    shelf(page, { shelf, index }) {
      const item = shelfItem(page.state.shelves, shelf, index);
      if (item) return openItem(item);
    },
    replay() {
      return elbert.ui.navigate(`${SECTION}/replay`, { mode: 'go' });
    },
    library() {
      return elbert.ui.navigate('/', { mode: 'go' });
    },
    downloads() {
      return elbert.ui.navigate(`${SECTION}/downloads`);
    },
  },
});
