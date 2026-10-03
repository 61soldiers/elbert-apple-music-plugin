// Reading Apple's export off disk and handing the plays to Elbert. The
// parsing itself is `parse.ts`; this only streams files into it.
//
// Elbert's `/stats` only ever sees what played *in Elbert*, so this is how
// listening done in Apple Music elsewhere gets into Elbert's history.
//
// It never goes to Last.fm. Last.fm refuses any scrobble that started more
// than 14 days ago (measured: of 21,120 plays from 2022–2026, exactly the 133
// from the last two weeks were accepted), and an export is weeks old by the
// time Apple sends it — so sending would be all refusals. Apple's
// live API has no per-play log (Replay's top-100 tallies were tried first and
// dropped: real per-play timestamps beat a reconstruction); the privacy
// export does.

import { ArtistIndex, DAILY_TRACKS_FILE, emptyResult, excludeOwnPlays, IMPORT_PROVIDER, type ParseResult, type Play, PlayActivityImporter } from './parse';

/** Rows per `fs.readCsv` — each batch is one short call into the plugin. */
const BATCH = 5000;

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

async function headerOf(path: string): Promise<string[]> {
  const csv = await elbert.fs.openCsv(path);
  await csv.close();
  return csv.header;
}

/**
 * Parses the picked files: sorts them by what their header says they are,
 * finds the Daily Tracks file beside Play Activity when it wasn't picked
 * (nobody should have to know to pick both), and drops plays this plugin
 * already reported to Apple from inside Elbert.
 */
export async function readExport(paths: string[], onProgress: (rows: number) => void): Promise<ParseResult> {
  const activity: string[] = [];
  const daily: string[] = [];
  for (const path of paths) {
    (ArtistIndex.isDailyTracksHeader(await headerOf(path)) ? daily : activity).push(path);
  }
  if (!activity.length) {
    return emptyResult(`Please pick "Apple Music Play Activity.csv". The file you picked doesn't say when each song was played.`);
  }
  if (!daily.length) {
    for (const path of activity) {
      const sibling = elbert.fs.join(dirOf(path), DAILY_TRACKS_FILE);
      if (!daily.includes(sibling) && (await elbert.fs.exists(sibling))) daily.push(sibling);
    }
  }

  let artists: ArtistIndex | null = null;
  for (const path of daily) {
    const csv = await elbert.fs.openCsv(path);
    const cols = ArtistIndex.columns(csv.header);
    if (!cols) {
      await csv.close();
      continue;
    }
    artists ??= new ArtistIndex();
    for (;;) {
      const { rows, done } = await csv.read(BATCH, cols);
      for (const r of rows) artists.add(r);
      if (done) break;
    }
  }

  const importer = new PlayActivityImporter({ artists });
  let total = 0;
  for (const path of activity) {
    const csv = await elbert.fs.openCsv(path);
    const cols = importer.startFile(csv.header);
    if (!cols) {
      await csv.close();
      break;
    }
    for (;;) {
      const { rows, done } = await csv.read(BATCH, cols);
      for (const r of rows) importer.addRow(r);
      total += rows.length;
      onProgress(total);
      if (done) break;
    }
  }
  const result = importer.finish();
  if (result.error || !result.plays.length) return result;

  // This plugin reports what it streams back to Apple, so those plays are in
  // the export as well. Elbert files them — and earlier imports — under this
  // provider.
  const own = await elbert.history.query({ provider: IMPORT_PROVIDER });
  return excludeOwnPlays(result, own);
}

/** Adds [plays] to Elbert's own listening history; a message to show. */
export async function importPlays(plays: Play[]): Promise<string> {
  if (!plays.length) return 'Nothing to import.';
  const records = plays.map((p) => ({ ...p, provider: IMPORT_PROVIDER }));
  const { added } = await elbert.history.import(records);
  await elbert.storage.set('privacyImportedAt', Date.now());
  return added === plays.length
    ? `${added} plays added to Elbert's listening history.`
    : `${added} of ${plays.length} plays added to Elbert's listening history (the rest were already there).`;
}
