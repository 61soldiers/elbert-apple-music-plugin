// "Import play activity CSV": the sheet that picks Apple's privacy export,
// says what is in it, and adds it to Elbert's own listening history. Not to
// Last.fm: it refuses plays older than 14 days, which an export always is.

import type { Page } from '@evolvedmesh/elbert-plugin-sdk';
import { importPlays, readExport } from '../privacy/import';
import { breakdown, type ParseResult, playsByYear } from '../privacy/parse';
import { definePage, errorText, type PageData, update } from './common';

interface State {
  result: ParseResult;
}

type P = Page<PageData, State>;

function points(r: ParseResult) {
  const out: { icon: string; text: string }[] = [
    {
      icon: 'layers',
      text: `Apple saves a new row every time you pause or skip ahead, so one song can take up several rows. The ${r.rows} rows in the file add up to ${r.listens} listens.`,
    },
  ];
  if (r.tooShort > 0)
    out.push({ icon: 'skip-forward', text: `${r.tooShort} listens were too short to count. A song counts once you hear half of it, or four minutes of it.` });
  if (r.noArtist > 0)
    out.push({
      icon: 'user-x',
      text: `${r.noArtist} plays were left out because Elbert couldn't tell who the artist was. Apple's file doesn't include artists, so Elbert looks them up by song title. If a title belongs to more than one artist, it is skipped.`,
    });
  if (r.duplicates > 0)
    out.push({
      icon: 'copy',
      text: `${r.duplicates} were skipped because they were already counted. Some songs you played in Elbert also show up in Apple's file.`,
    });
  if (r.unreadable > 0) out.push({ icon: 'circle-alert', text: `${r.unreadable} rows were missing a song title or time, so they were skipped.` });
  out.push({ icon: 'info', text: "They go to Elbert's statistics page. Last.fm only accepts plays from the last 14 days, so they aren't sent there." });
  return out;
}

function render(page: P) {
  const s = page.state;
  const r = s.result;
  const years = playsByYear(r);
  const span = years.length === 0 ? '' : years.length === 1 ? `${years[0][0]}` : `${years[0][0]}–${years[years.length - 1][0]}`;
  update(page, {
    status: 'confirm',
    headline: `Found ${r.plays.length} plays from ${span}, each with the date and time it was played.`,
    points: points(r),
    importLabel: `Import ${r.plays.length}`,
  });
}

async function start(page: P) {
  const paths = await elbert.ui.pickFiles({ extensions: ['csv'], multiple: true, title: 'Apple Music Play Activity.csv' });
  if (!paths.length) return page.dismiss(null);
  update(page, { status: 'reading', progress: 'Reading the export…' });
  let result: ParseResult;
  try {
    result = await readExport(paths, (rows) => update(page, { progress: `Reading the export… ${rows.toLocaleString()} rows` }));
  } catch (e) {
    return page.dismiss(`Could not read the export: ${errorText(e)}`);
  }
  // Say *why* when nothing came through — "nothing to import" alone is what
  // made a missing artist column look like an empty file.
  if (result.error) return page.dismiss(result.error);
  if (!result.plays.length) return page.dismiss(`Nothing in the export could be imported. ${breakdown(result)}`);

  page.state.result = result;
  render(page);
}

definePage<PageData, State>('privacyImport', {
  open(page) {
    setTimeout(() => void start(page), 0);
    return { status: 'reading', progress: 'Choose the export to import…', points: [] };
  },
  events: {
    cancel(page) {
      return page.dismiss(null);
    },
    async import(page) {
      update(page, { status: 'reading', progress: 'Importing…' });
      try {
        const message = await importPlays(page.state.result.plays);
        await page.dismiss(message);
      } catch (e) {
        await page.dismiss(errorText(e));
      }
    },
  },
});

/** Opens the import; shows what came of it. */
export async function runPrivacyImport() {
  const message = await elbert.ui.sheet<string>({ page: 'privacyImport', widget: 'privacy:ImportSheet' });
  if (message) await elbert.ui.toast(message);
}
