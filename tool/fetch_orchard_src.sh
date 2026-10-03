#!/usr/bin/env bash
# Bundles the Orchard server source into assets/orchard/orchard-src.tar.gz, so
# the plugin can run Orchard for the user on desktop: src/orchard/managed.ts
# extracts this tarball on first run and drives `docker compose` against it.
#
# The Orchard source is deliberately NOT checked in here. Run this before
# `npm run build`/`npm run pack`, and in release CI.
#
#   ORCHARD_SRC_REPO   git URL to clone   (default: the public Orchard repo)
#   ORCHARD_SRC_REF    branch/tag/commit  (default: main)
#   ORCHARD_SRC_DIR    use this local checkout instead of cloning (offline dev)
set -euo pipefail

REPO=${ORCHARD_SRC_REPO:-https://github.com/61soldiers/orchard.git}
REF=${ORCHARD_SRC_REF:-main}

here=$(cd "$(dirname "$0")/.." && pwd)
out_dir="$here/assets/orchard"
out_tar="$out_dir/orchard-src.tar.gz"
out_ref="$out_dir/.orchard-src-ref"
mkdir -p "$out_dir"

work=$(mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if [ -n "${ORCHARD_SRC_DIR:-}" ]; then
	src=$(cd "$ORCHARD_SRC_DIR" && pwd)
	echo "Using local Orchard checkout: $src"
	src_head=$(cd "$src" && git rev-parse --short HEAD 2>/dev/null || echo unknown)
	# This path tars the WORKING TREE, uncommitted changes included, so the
	# commit id alone can name a bundle that exists nowhere in git. Say so
	# loudly: a dirty bundle once shipped a fix that lived only in this tarball
	# and in the container it built, and was later wiped from the checkout by a
	# `git reset`. (CI never hits this — it clones a clean ref.)
	if [ "$src_head" != "unknown" ] && ! (cd "$src" && git diff --quiet HEAD -- 2>/dev/null); then
		src_head="$src_head-dirty"
		echo "warning: $src has uncommitted changes — they are going into the bundle." >&2
		echo "         Commit them to orchard before relying on this build." >&2
	fi
	ref_id="local:$src_head"
else
	echo "Cloning $REPO @ $REF"
	git clone --depth 1 --branch "$REF" "$REPO" "$work/orchard" 2>/dev/null ||
		git clone "$REPO" "$work/orchard"
	(cd "$work/orchard" && git checkout --quiet "$REF" 2>/dev/null || true)
	src="$work/orchard"
	ref_id="$REPO@$(cd "$src" && git rev-parse HEAD)"
fi

# Sanity: this must look like the Orchard server tree.
for f in compose.yaml Dockerfile go.mod cmd/orchard/main.go; do
	[ -e "$src/$f" ] || { echo "error: $src is missing $f — not an Orchard checkout" >&2; exit 1; }
done

# Pack the tree at archive root, dropping VCS, tooling and local runtime state.
# What `docker compose build` needs: compose.yaml, Dockerfile, go.*, cmd/,
# internal/, docs/, and the setup scripts — nothing else.
#
# Strip filesystem metadata that would land in the archive as SCHILY.xattr PAX
# records: macOS tags every file it writes with a binary `com.apple.provenance`
# xattr, and the pure-Dart `archive` package Elbert unpacks it with (`fs.extract`)
# does `utf8.decode` on PAX header data and throws on those bytes
# ("unexpected extension byte"). bsdtar (macOS) needs the flags spelled out;
# GNU tar (Linux/CI) omits xattrs unless asked, so only pass what it accepts.
tar_meta_opts=()
if tar --version 2>&1 | grep -qi 'bsdtar'; then
	tar_meta_opts=(--no-xattrs --no-mac-metadata --no-acls --no-fflags)
fi
COPYFILE_DISABLE=1 tar ${tar_meta_opts[@]+"${tar_meta_opts[@]}"} -czf "$out_tar" \
	--exclude='./.git' \
	--exclude='./.github' \
	--exclude='./.claude' \
	--exclude='./.codegraph' \
	--exclude='./.vscode' \
	--exclude='./data' \
	--exclude='./.env' \
	--exclude='*.sock' \
	-C "$src" .

# The runtime keys its "is the extracted tree current?" check on this marker,
# so it must change whenever the bundle's bytes change. Hash the archive
# itself rather than trusting a commit id (the source may be a dirty or
# non-git checkout). macOS has no `sha256sum` — fall back to `shasum -a 256`.
if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1"; }
else
	sha256() { shasum -a 256 "$1"; }
fi
digest=$(sha256 "$out_tar" | cut -c1-16)
printf '%s\n' "$ref_id sha256:$digest" >"$out_ref"
echo "Wrote $out_tar ($(du -h "$out_tar" | cut -f1)) — ref: $ref_id sha256:$digest"
