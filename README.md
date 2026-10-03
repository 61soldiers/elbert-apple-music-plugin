# Elbert Apple Music

Apple Music for [Elbert](https://github.com/evolvedmesh/elbert), as a plugin. It talks to
**Orchard**, a self-hosted server that signs in to your own Apple Music subscription, and gives
Elbert catalog browsing, streaming, downloads, library and playlist editing, Replay and play
history.

> **For personal use only.** Don't share what it downloads, and don't use it commercially. Read the
> [disclaimer](DISCLAIMER.md) first.

- **Desktop only** (Linux, Windows, macOS). The plugin builds and runs Orchard in Docker for you,
  or you point it at an Orchard you already run.
- It also imports your Apple Music listening history from Apple's privacy export into Elbert's
  statistics. (Not Last.fm: it refuses plays older than 14 days, and an export is always older.)

## Install

Download `io.github.61soldiers.elbert.apple-music-<version>.elbx` from the latest release and use
**Settings → Plugins → Install from file** in Elbert.

## Develop

```shell
bun install
bun run check            # tsc, bun test, Biome lint/format, manifest and template checks
bun run fix              # apply Biome's fixes and formatting
bun run dev              # rebuild on every change
bun run pack             # release/<id>-<version>.elbx
```

Everything runs on [Bun](https://bun.sh): package manager, runtime, bundler and test runner. The
SDK is installed from `../elbert-plugin-sdk`. The Orchard source is bundled from a checkout:
`ORCHARD_SRC_DIR=../orchard bash tool/fetch_orchard_src.sh`. Load `dist/` in Elbert with
**Settings → Plugins → Load development folder**. See [CLAUDE.md](CLAUDE.md) for how the plugin is
put together.

## License

MIT
