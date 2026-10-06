#!/usr/bin/env bash
# Builds the Orchard server into assets/orchard/orchard-<os>-<arch>.tar.gz, so
# the plugin can run Orchard for the user with nothing else installed:
# src/orchard/managed.ts extracts the archive for the host on first run and
# starts the program.
#
# The Orchard source is deliberately NOT checked in here. Run this before
# `bun run build`/`bun run pack`, and in release CI. It needs Go.
#
#   ORCHARD_SRC_REPO   git URL to clone   (default: the public Orchard repo)
#   ORCHARD_SRC_REF    branch/tag/commit  (default: main)
#   ORCHARD_SRC_DIR    use this local checkout instead of cloning (offline dev)
#   TARGETS            space-separated os/arch list
#                      (default: every platform the plugin runs on)
#
# It also builds the virtual machine's guest image (assets/guest, needs mke2fs).
# QEMU itself is packaged by tool/package_qemu_windows.sh and
# tool/package_qemu_macos.sh, which run before and beside this one.
set -euo pipefail

REPO=${ORCHARD_SRC_REPO:-https://github.com/61soldiers/orchard.git}
REF=${ORCHARD_SRC_REF:-main}
TARGETS=${TARGETS:-"linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64"}

here=$(cd "$(dirname "$0")/.." && pwd)
out_dir="$here/assets/orchard"
out_ref="$out_dir/.orchard-bin-ref"
mkdir -p "$out_dir"
rm -f "$out_dir"/orchard-*.tar.gz "$out_dir/.orchard-src-ref" "$out_dir/orchard-src.tar.gz"
rm -rf "$here/assets/guest"

work=$(mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if [ -n "${ORCHARD_SRC_DIR:-}" ]; then
	src=$(cd "$ORCHARD_SRC_DIR" && pwd)
	echo "Using local Orchard checkout: $src"
	src_head=$(cd "$src" && git rev-parse --short HEAD 2>/dev/null || echo unknown)
	# This path builds the WORKING TREE, uncommitted changes included, so the
	# commit id alone can name a build that exists nowhere in git. Say so
	# loudly: a dirty bundle once shipped a fix that lived only in the bundle
	# and was later wiped from the checkout by a `git reset`. (CI never hits
	# this — it clones a clean ref.)
	if [ "$src_head" != "unknown" ] && ! (cd "$src" && git diff --quiet HEAD -- 2>/dev/null); then
		src_head="$src_head-dirty"
		echo "warning: $src has uncommitted changes — they are going into the build." >&2
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
for f in go.mod cmd/orchard/main.go; do
	[ -e "$src/$f" ] || { echo "error: $src is missing $f — not an Orchard checkout" >&2; exit 1; }
done
command -v go >/dev/null || { echo "error: Go is required to build Orchard (https://go.dev/dl/)" >&2; exit 1; }

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

if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$@"; }
else
	sha256() { shasum -a 256 "$@"; }
fi

for target in $TARGETS; do
	goos=${target%/*}
	goarch=${target#*/}
	exe=orchard
	[ "$goos" = windows ] && exe=orchard.exe
	stage="$work/stage-$goos-$goarch"
	mkdir -p "$stage"
	echo "Building $goos/$goarch"
	(cd "$src" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
		go build -trimpath -ldflags="-s -w" -o "$stage/$exe" ./cmd/orchard)
	# A fixed mtime and owner keep the bytes — and so the ref below — the same
	# for the same source.
	COPYFILE_DISABLE=1 tar ${tar_meta_opts[@]+"${tar_meta_opts[@]}"} -czf "$out_dir/orchard-$goos-$goarch.tar.gz" \
		--mtime='2020-01-01 00:00:00' --owner=0 --group=0 --numeric-owner \
		-C "$stage" "$exe" 2>/dev/null ||
		COPYFILE_DISABLE=1 tar ${tar_meta_opts[@]+"${tar_meta_opts[@]}"} -czf "$out_dir/orchard-$goos-$goarch.tar.gz" -C "$stage" "$exe"
done

# The guest the virtual machine boots (kernel, base initramfs, empty data disk).
# Needs Linux and mke2fs; elsewhere, or without it, the plugin just has no VM.
if command -v mkfs.ext4 >/dev/null 2>&1; then
	echo "Building the VM guest"
	(cd "$src" && go run ./cmd/guestbuild -arch x86_64 -out "$here/assets/guest" -cache "$work/guest-cache")
else
	echo "warning: mkfs.ext4 not found — building without the VM guest (macOS and Windows won't work)" >&2
fi

# The runtime keys its "are the unpacked programs current?" checks on this
# marker, so it must change whenever the bundled bytes change. Hash the archives
# and the guest rather than trusting a commit id (the source may be dirty or not
# in git).
digest=$( (cd "$out_dir" && cat orchard-*.tar.gz; [ -d "$here/assets/guest" ] && cat "$here"/assets/guest/*; cat "$out_dir"/../qemu/*.tar.gz 2>/dev/null; true) | sha256 | cut -c1-16)
printf '%s\n' "$ref_id sha256:$digest" >"$out_ref"
echo "Wrote $out_dir ($(du -sh "$out_dir" | cut -f1)) — ref: $ref_id sha256:$digest"
