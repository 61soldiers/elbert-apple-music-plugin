// Apple Music **Wrapped**: a year of Replay (or every year) as a scroll-through
// story. The slides are built by `replay/story.ts`; Elbert's `StoryPager`
// animates each one as it arrives. Needs an Elbert that has it (`elbert.stats`
// is how the Replay page knows), so the entry points are hidden elsewhere.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { replay, replayYears } from '../data';
import type { Item, Summary } from '../orchard/client';
import { loadAllTime, monthsOf } from '../replay/load';
import { buildAllTimeStory, buildYearStory, type Story } from '../replay/story';
import { onTimeUnitChange, timeUnit } from '../replay/unit';
import { definePage, errorText, onClose, openItem, type PageData, routes, SECTION, update } from './common';

interface State {
  story?: Story;
  year: string;
  seq: number;
  inputs?: { summary: Summary; months: Summary[] } | { all: Awaited<ReturnType<typeof loadAllTime>>['all'] };
}

function render(page: Page<PageData, State>) {
  const s = page.state;
  if (!s.inputs) return;
  const unit = timeUnit();
  s.story = 'all' in s.inputs ? buildAllTimeStory(s.inputs.all, unit) : buildYearStory(s.inputs.summary, s.inputs.months, unit);
  update(page, { status: 'ready', story: { slides: s.story.slides }, restartKey: `${s.year}:${unit}` });
}

definePage<PageData, State>('wrapped', {
  open(page) {
    const s = page.state;
    s.year = page.params.year ?? '';
    s.seq = 0;
    s.story = undefined;
    s.inputs = undefined;
    onClose(
      page,
      onTimeUnitChange(() => render(page)),
    );
    void (async () => {
      try {
        if (s.year === 'all') {
          s.inputs = { all: (await loadAllTime()).all };
        } else {
          const years = (await replayYears()).summaries;
          const year = years.find((y) => y.period === 'year' && `${y.year}` === s.year);
          if (!year) throw new Error(`Apple has no Replay for ${s.year}.`);
          const [summary, months] = await Promise.all([replay(year.id), monthsOf(year.year)]);
          s.inputs = { summary, months };
        }
        render(page);
      } catch (e) {
        update(page, { status: 'error', error: errorText(e) });
      }
    })();
    return { status: 'loading', story: { slides: [] }, restartKey: s.year };
  },
  events: {
    open(page, { rail, index }) {
      const item: Item | undefined = page.state.story?.items[String(rail)]?.[Number(index)];
      if (item) return openItem(item);
    },
    playlist(page) {
      const id = page.state.story?.playlistId;
      if (id) return elbert.ui.navigate(routes.playlist(id));
    },
    replay() {
      return elbert.ui.navigate(`${SECTION}/replay`, { mode: 'go' });
    },
  },
});
