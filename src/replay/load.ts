// Loads every year of Replay for the pages that fold them together.

import { replay, replayMonths, replayYears } from '../data';
import type { Summary } from '../orchard/client';
import { type AllTime, buildAllTime } from './alltime';
import { ArtIndex } from './detail';

/** Apple's month summaries for a year, in calendar order. */
export const monthsOf = async (year: number) => (await replayMonths(year).catch(() => [] as Summary[])).sort((a, b) => a.month - b.month);

export const withListening = (months: Summary[]) => months.filter((m) => m.listenTimeInMinutes > 0);

/** Every year's summary and months, added up. Cached through `data.ts`. */
export async function loadAllTime(years?: Summary[]): Promise<{ all: AllTime; art: ArtIndex }> {
  const list = (years ?? (await replayYears()).summaries).filter((y) => y.period === 'year');
  const loaded = await Promise.all(list.map(async (y) => ({ summary: await replay(y.id), months: withListening(await monthsOf(y.year)) })));
  const art = new ArtIndex();
  for (const y of loaded) art.add(y.summary);
  return { all: buildAllTime(loaded), art };
}
