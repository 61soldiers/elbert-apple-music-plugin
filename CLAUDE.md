# Elbert Apple Music plugin

Apple Music for [Elbert](../elbert), as an Elbert plugin. Elbert never talks to Apple: this plugin
talks to **Orchard** (`61soldiers/orchard`, branch `main`), a self-hosted server that signs in to a
real Apple Music subscription and can stream, download and edit the library. This code used to be
compiled into Elbert behind `ENABLE_APPLE_MUSIC`. It must keep looking and behaving exactly as it
did then, and existing users' setups must carry on untouched.

- Plugin id `io.github.61soldiers.elbert.apple-music`; section route `/apple-music`.
- **Desktop only** (manifest `platforms`: linux, windows, macos). Apple Music on phones was dropped
  on purpose; Elbert refuses to install the plugin elsewhere. Don't reintroduce mobile code paths.
- TypeScript, bundled by `@evolvedmesh/elbert-plugin-sdk` (`../elbert-plugin-sdk`, installed via
  `file:`) into one `plugin.js` that runs in QuickJS. There are **no** Node, browser or `URL`
  globals; everything outside the sandbox goes through the global `elbert`.
- UI is RFW templates in `ui/*.rfwtxt` rendering Elbert's own widgets (`import elbert;`). The
  widget arguments are defined in `../elbert/lib/plugins/ui/widgets/lib_*.dart` and documented in
  the SDK's `docs/`.
- **Bun is the whole toolchain** (package manager, the SDK CLI's runtime and bundler, test runner);
  don't add npm/pnpm/Node tooling or esbuild. Biome lints and formats (`biome.json`); keep it clean,
  and give any `biome-ignore` a reason. `src/` must not see Bun types — it runs in QuickJS.
- Commit messages are Conventional Commits (semantic-release). Don't commit or push unless asked.

```shell
bun install
bun run typecheck         # tsc over src/ (sandbox types only) and test/ (Bun types)
bun test                  # the privacy-export parser
bun run lint              # biome check; `bun run fix` applies fixes and formatting
bun run check             # all of the above + manifest/template lint — what CI runs
bun run build             # dist/plugin.js
bun run pack              # release/<id>-<version>.elbx
```

To try it, use Elbert → Settings → Plugins → "Load development folder" on this repo. Elbert
watches the folder and restarts the plugin on rebuild. Use `bun run dev` for watch mode.

## Layout

```
src/
  orchard/client.ts    Orchard REST client + models (mirrors orchard/docs/reference.md)
  orchard/managed.ts   running Orchard for the user as a child process (no Docker)
  connection.ts        settings, API key, connect/disconnect, session-status polling
  cache.ts             TTL cache + Paged<T> (loadMore swallows errors, loadAll throws)
  data.ts              every cached fetch the pages make (one per old Riverpod provider)
  downloads.ts         download manager: jobs → files on disk → library.add, badge, .lrc sidecars
  activity.ts          play-activity reporting to Apple + the station player
  playlists.ts         editing the account's playlists, Sync to library (.m3u), resync
  playback.ts          stream tracks, local-copy substitution, playSongs
  privacy/parse.ts     Apple's privacy export → plays (pure; tested in test/privacy.test.ts)
  privacy/import.ts    streams the export's files in (fs.openCsv) and hands plays to history.import
  ids.ts link.ts html.ts format.ts
  pages/               one module per page (common.ts, songs.ts, setup.ts, home.ts, …)
  index.ts             onActivate wiring: nav, routes, settings, actions, lyrics
ui/                    common.rfwtxt (setup flow, sign-in, picker) + one file per page
assets/runtime.json    pins the runtime packs by sha256 (generated, gitignored); assets/runtime/ holds them in dev builds
tool/                  build_runtime.sh (packs + manifest), qemu/build.sh (QEMU from source, per OS)
test/                  bun test suites (pure modules only; own tsconfig with Bun types)
```

**Status:** every page, `index.ts`, the manifest, the tools, the release workflow and
semantic-release config are written; `bun run check` (tsc, tests, Biome, manifest) and `bun run build` are
clean and every template parses under Elbert's RFW runtime. The original Dart code was the
reference; recover it from Elbert's git history if needed (`lib/apple_music/`,
`lib/pages/apple_music/`, `lib/providers/apple_music_*`, `lib/services/{orchard_*,
managed_orchard_service,apple_music_*}`, `lib/widgets/settings/apple_music_settings_section.dart`,
and the privacy import's `lib/utils/apple_privacy_import.dart`).

**Releases.** semantic-release on `main`/`dev`/`mvp` bumps the manifest, fetches the Orchard source,
packs the `.elbx` and attaches it. The
workflow checks out `@evolvedmesh/elbert-plugin-sdk` beside this repo, because `package.json` depends on
`file:../elbert-plugin-sdk`.

## Compatibility with the built-in version (do not break)

- **Settings** keep their old `settings.json` names. The manifest's `migrate.settingsKeys`
  (`orchardEnabled`, `orchardServerUrl`, `orchardManaged`, `orchardPlayHistoryEnabled`) moves them
  into this plugin's storage on first start.
- **The API key** is secure-storage only, under `orchard_api_key` (`migrate.secureKeys`). It never
  goes in storage or logs.
- **Linked playlists**: `migrate.playlistLinks` adopts the old `appleMusicPlaylistId` links
  (Elbert reads any pre-plugin `<service>PlaylistId` key as an unowned link).
- **Listening history**: lines written before plugins say source `appleMusic` with no provider.
  `migrate.legacySources: ["appleMusic"]` refiles them under the plugin's name, `Apple Music`, on
  every start — the same provider streamed plays and imported plays use, so `/stats` counts one
  source. The plugin's **name must stay `Apple Music`** for that reason.
- **Track ids:**
  - A streamed song is `applemusic-stream:<catalog id>`.
  - A downloaded file is `applemusic:<catalog id>`.
  - Libraries and listening logs already hold both, so they must never change.
- **Managed server:**
  - Lives in `<appSupport>/orchard`: `bin/` (the unpacked program), `data/` (Orchard's data dir:
    `orchard.db`, `library/`, `wrapper/`) and the API key in `.env`. A Docker-era key in
    `src/.env` is adopted so clients that hold it carry on.
  - The signed-in Apple session is `data/wrapper/rootfs/data`.
  - **Moving from Docker.** The first start on a machine that has the old `elbert-orchard_orchard-data`
    volume copies the session, database and library out of it once (`migrateLegacy`), stops the old
    container and sets `--restart=no` so it can't take the port back, and leaves the volume as a backup.
    Docker is only ever *read* for this, and a machine without it skips the step.
- **Orchard changes** are committed to orchard `main`, and then the bundle is regenerated
  (`tool/build_runtime.sh` builds the working tree, dirty or not — commit first).

## Orchard, managed

`orchard/managed.ts` starts Orchard as a child process of Elbert (`NoBackend` where the daemon has no host, so
a remote server still works). There is no Docker anywhere in the plugin, by decision, and nothing for the user
to install.

- **The package is thin (~250 KB).** Orchard, QEMU and the guest are *runtime packs* the plugin downloads, for
  the user's own platform only, from the GitHub release it came from. `assets/runtime.json` (generated by
  `tool/build_runtime.sh`) pins each by sha256; the plugin checks it with the OS's own tool (`sha256sum`,
  `shasum`, `certutil`; there is no hashing in the plugin API). A development build bundles the packs in
  `assets/runtime/` and skips the download. Packs: `orchard-<os>-<arch>` (~7.5 MB, everywhere) and
  `vm-<os>-<arch>` (QEMU + the guest kernel/image, ~18 MB, macOS and Windows only).
- **Linux** sandboxes the daemon with user namespaces (Orchard does it) and downloads only the orchard pack.
  There is **no VM pack for Linux**: where namespaces are blocked (`orchard __check-sandbox` fails: Ubuntu
  24.04+ by default) the plugin shows the one `sysctl` line that allows it (`SANDBOX_HELP`). (Orchard can still
  host the daemon in a VM on Linux if a host supplies QEMU, and migrates a file session into the guest; the
  plugin just doesn't ship that fallback, to save a QEMU build, a 19 MB pack and ~400 MB of RAM.)
  **macOS (Apple silicon) and Windows** always use the VM. **Intel Macs are not supported** (no pack): they get
  a clear "connect to a remote Orchard" message. QEMU is built from source with only what the guest needs
  (`tool/qemu/build.sh`; Windows ~4 MB and macOS ~3.7 MB compressed; TCG only on both). Details and the traps
  are in Orchard's CLAUDE.md.
- **Only Linux has a Docker volume to move over**; macOS/Windows users sign in again. (If an old Docker
  container is still holding port 8080 there, it is used as it is, like any hand-run Orchard.)
- **Android is not wired up yet** (the SDK's runtime-pack path; Orchard's proot launch exists).
- Writes the `.env` key, runs `__check-sandbox`, starts Orchard with `ORCHARD_DATA_DIR`,
  `ORCHARD_ADDR=127.0.0.1:8080` and `ORCHARD_EXIT_WITH_PARENT=1` (so a crashed Elbert can't leave a signed-in
  daemon behind), and polls `/healthz`. `fs.extract` drops file modes, so executables are `chmod`ed.
- The first start also downloads the Apple daemon (~50 MB) before Orchard listens: the health wait is
  5 minutes.
- If Orchard dies on its own it is restarted, at most 3 times in 5 minutes, then the error shows.
- A server already answering on the port that this plugin didn't start is someone's hand-run Orchard,
  and is used as it is.

**Session status** (`unconfigured | starting | awaiting_2fa | ready | failed`) belongs to Orchard.
- `connection.watchStatus()` polls every 4 s while a page holds it.
- The first `failed` triggers **one silent managed restart** before being shown. It usually means
  the daemon died inside a live container, and the Apple session itself is still fine.

## Behaviour that is load-bearing

**Local copy over stream.**
- Every queue goes through `playableQueue`, which swaps in the library's copy (ISRC, else
  title/artist/±5 s) — seekable, offline, free, and not reported to Apple.
- So pick the tapped entry **by index**, never by `applemusic-stream:<id>`: that id only exists
  for songs that stream.
- Rows pass `matchIds` + `localId` so the now-playing bars find either.

**Streams.**
- An Orchard stream is a non-seekable fragmented MP4. Elbert re-opens one that ends early.
- The URL carries `?api_key=`, so it is never persisted or logged.

**Downloads.**
- **Albums** are one Orchard `album` job. **Playlists never are**: they fan out into one `song`
  job per track, because the downloader is far more reliable one track at a time.
- Files land in `Downloads/Elbert/<Album>/`.
- Every saved file gets a `.lrc` sidecar when Apple has lyrics, and `hasLyrics` reflects what was
  actually written.
- **Download again** (`replaceLocalMatch`) overwrites the user's own matching file, keeping its
  library id. The new file is written to a `.elbert-part` sibling and then renamed over the
  original, so a failed transfer can't take the original with it.
- An `.m4a` replaces a `.flac`/`.mp3` under the same name.
- Bulk entry points never replace user files. A song this plugin downloaded is always replaced
  in place.

**Playlist edits.**
- Reorder and remove are one call (the whole list, `PUT …/tracks`). A paginated playlist must be
  `loadAll()`-ed before editing, or the unloaded pages are deleted from Apple's copy.
- Clearing needs explicit `allowEmpty`.
- Apple silently drops ids it can't resolve and still answers 200.
- Where a library playlist opens turns on **`canEdit`**, not on having a catalog id. Apple gives
  shareable catalog ids to your own playlists too.
- Catalog pages find ownership with `ownedPlaylist(catalogId)`, and show no edit actions when
  there's no match.

**Sync to library.**
- Matches every song, downloads only what's missing into `<first music folder>/Apple Music/`, and
  *waits* for the downloads.
- Then writes a `.m3u` (relative, `/`-separated paths) and calls `playlists.upsertLinked`.
- The playlist action "Sync" re-syncs from the library side.

**Play activity.**
- Streamed tracks only.
- Report a start once really playing, and an end when the track stops being current: `natural`
  within 5 s of the end, else `skipped_forward`.
- Apple keys Recently Played on the **container**, so pages call `rememberContext(songIds,
  {kind, id})` when their data loads.
- Opt-out via `orchardPlayHistoryEnabled` (default on). Failures are swallowed.
- Flushed on `app.lifecycle`.

**Stations.**
- Each `next-tracks` call advances the station, so there is no list to open: a station card
  *plays*.
- Fetch 10 at a time (Apple's hard cap; its default is 2) and top up when ≤3 tracks remain.
- Station mode stops by itself once a non-station track plays.
- Live radio channels come back as `422 station_not_playable`.

**Caching.**
- 5 min for lists and details, 2 min for search, 1 h for Replay. Never cache a failure.
- Pull-to-refresh invalidates.
- `limit` goes on *every* request, cursor ones included, because Apple drops it from `next`
  links.
- "Recently Added" is `recent: true, limit: 30`. The full album list stays alphabetical.

**Home** is deliberately just the account's own music.
- The "New Music" hero sits with the pins beside it on desktop. A phone shows the hero alone,
  and its pins live on Library.
- Below that come Made For You and Recently Played.
- The hero is found by searching item **names** across every recommendation group.
- Charts and editorial Browse rows were removed on purpose (hundreds of extra covers, 429s). Don't
  reinstate them without a plan for the request volume.

**Replay** is Apple's summary, not Elbert's `/stats`, and the two are never merged.
- Songs have plays but **no listen time**.
- The year in progress has **no totals**, so sum its months and say so.
- Genres have no catalog page and are not tappable.

**Phone dock.** Inside `/apple-music` the dock is Home · Search · Library · Replay · Settings
(`setNavigation` compact). Settings is `/apple-music/settings`, Elbert's own Settings mounted under
the section. Enter the section with `navigate(…, {mode: 'go'})`, never push.

**Artwork.** Ask for the size you draw: `sizedArtwork(a, 400)` for rails (~24 KB against ~41 KB
for the largest). Use `bestArtwork` only for art shown large.

## Writing pages

- Pages are `definePage(name, {open, events, close})` (`pages/common.ts`). `open` returns initial
  data fast and loads the rest async with `update(page, …)`, which is a no-op once the page closed.
- Register cleanups with `onClose` (status watchers, download listeners, timers).
- Section pages put `sectionChrome(page, route)` in their data; that keeps the Downloads badge on
  the tabs live.
- Song rows use `songRow()`/`songMenu()`, and menu picks go to `songAction()` (`pages/songs.ts`).
- RFW template rules, all of which fail at runtime rather than at build:
  - Only `...for` can be spread. Use a `switch` element with a `default: SizedBox()` instead of
    `...switch`.
  - `null` is not a switch key, so send booleans (`hasX`).
  - Doubles are written `14.0`.
  - Never send null values.
- Parse-check templates after editing them.
- Templates may `import common;` because every `ui` manifest key is a library name.

## Importing Apple's own history (privacy export)

Settings → Apple Music → "Import play activity CSV". Needs no Orchard. It moved here from Elbert,
which now only offers general APIs: `ui.pickFiles`, `fs.openCsv` (streamed CSV) and
`history.query`/`history.import` (the `history` permission).

**Apple Music's own history gets in through Apple's own data export, not a live API call** —
`/stats` and the scrobbler only ever see what played *here*, and Apple's apps have no scrobbling
at all, which is the whole motivation for issue #39. amp-api itself has no per-play log to read
(Replay's top-100-of-the-year tallies were tried first and dropped for exactly that reason — real
per-play timestamps beat a reconstruction), but privacy.apple.com's **"Request a copy of your
data" → Apple Media Services information** export includes `Apple Music Play Activity.csv`, one
row per playback event with real start/end timestamps. That file is the input.

`src/privacy/parse.ts` parses it — pure, no `elbert` global, so the row-to-play mapping is
tested directly (`test/privacy.test.ts`). The CSV grammar itself is Elbert's (`fs.openCsv`). It reads headers **by name**, tolerant of Apple's past
spelling changes, and refuses to guess: a file missing the song-name/timestamp columns comes back
with an error naming what it did find rather than misreading arbitrary columns as the wrong
fields. Needs **no Orchard**: it is a file the user already has, so the settings row shows whether
or not a server is set up. The UI is the `privacyImport` sheet (`src/pages/privacy.ts`,
`ui/privacy.rfwtxt`).

Measured on a real 2022–2026 export (145 MB, 111k rows, ~145 columns), and none of it safe to
"fix":

- **Apple's current Play Activity file has no artist column at all** — `Song Name` and `Album
  Name` only (`Container Artist Name` is the playlist/album's, and ~empty). The artist comes from
  `Apple Music - Play History Daily Tracks.csv` in the same export, whose `Track Description` is
  "Artist - Title" per day: `ArtistIndex` matches title + day (±1, UTC vs local midnight),
  then title alone, and **leaves an ambiguous title out rather than guessing** (a wrong artist is a
  wrong scrobble). That resolved 97.7% of plays. `import.ts` finds the Daily Tracks file beside
  Play Activity on its own; without it the import stops with an error naming the file, which is
  what "nothing worth importing" used to be hiding.
- **A row is a segment, not a listen.** Apple writes a `PLAY_END` every time playback *stops* — a
  pause, a scrub, backgrounding — so one listen can be four rows, two of which each passed the
  half-the-track rule (one listen, two scrobbles), while a listen paused halfway was two pieces
  that each fell short and never counted. `stitch` sorts segments by end time and joins
  them per `Device Identifier` while the track is the same, the previous segment ended in a
  *pause* reason (`SCRUB_BEGIN`/`SCRUB_END`/`PLAYBACK_MANUALLY_PAUSED`/`PLAYBACK_SUSPENDED`/
  `EXITED_APPLICATION`) and the gap is under 30 min; every other reason, unknown ones included,
  closes the listen, because merging is the direction that can invent a play. Only then is the
  play rule applied. 65.5k segments → 43.7k listens → 21.1k plays.
- **`Play Duration Milliseconds` is how far the playhead moved**, and the start timestamp is just
  end minus that — only end times are real clock readings. For a `SCRUB_END` segment that
  distance is the scrub itself (its end time equals the previous segment's in 1,148 of 1,557
  cases), so it joins the listen but adds no listening time.
- **Only `PLAY_END` rows are playback** (`PLAY_START`, `LYRIC_DISPLAY` are counted and skipped); a
  file with no event-type values is taken as all playback.
- **It streams.** `fs.openCsv` reads the file host-side a chunk at a time, `read(5000, cols)` hands
  over only the dozen columns used, and `PlayActivityImporter` keeps segments rather than the
  145-column table. `fs.readText` on this file would put ~145 MB in the engine's heap — never.
  Each batch is a short call; keep processing between `read`s, the engine has a per-call budget.
- **It excludes plays Elbert plausibly already reported to Apple itself**, matched by title/artist
  within three minutes of a play under provider `Apple Music` (`IMPORT_PROVIDER`) in Elbert's
  own history (`history.query`) (a downloaded Apple Music track is never
  reported, so only *streamed* plays can collide). Imported listens are filed under that same
  provider. No track id survives into a CSV row, so this is a heuristic, not an id match; it only
  ever drops a row, never adds a false one to what's sent.
- **It goes to Elbert's history only, never Last.fm.** Last.fm refuses any scrobble that started
  more than 14 days ago (measured: of 21,120 plays from 2022–2026, exactly the 133 from the last two
  weeks were accepted), and an export is weeks old by the time Apple sends it. Don't add a Last.fm
  option back.

It goes through `history.import(plays)`. Elbert deduplicates against what's already logged (same
source, title, artist, start within a minute) and reports how many were new, so a re-import is
safe. The play rule (`countsAsPlay` in `parse.ts`) restates Elbert's `PlayEvent.countsAsPlay` /
`isScrobbleEligible` — keep the two in step. It never runs on its own, only from the settings row.