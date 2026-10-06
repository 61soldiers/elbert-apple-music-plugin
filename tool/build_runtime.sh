#!/usr/bin/env bash
# Builds the runtime packs the plugin downloads on first run, and the manifest
# (assets/runtime.json) that pins them by sha256. The plugin package itself stays a
# few hundred kilobytes: each user fetches only their own platform's packs from this
# release.
#
#   orchard-<os>-<arch>.tar.gz   the Orchard server (about 7 MB)
#   vm-<os>-<arch>.tar.gz        QEMU + the Linux guest, for the platforms that host
#                                Apple's daemon in a virtual machine (about 10 MB)
#
# Needs Go; the guest needs mke2fs. The Orchard source is NOT checked in here.
#
#   build_runtime.sh [version]      version is the release the packs will be attached
#                                   to (default: dev, packs bundled for local use)
#
#   ORCHARD_SRC_REPO / ORCHARD_SRC_REF / ORCHARD_SRC_DIR   where Orchard comes from
#   TARGETS     os/arch list for the Orchard server
#   QEMU_DIR    directory with one <os>-<arch>/ per QEMU build (tool/qemu/build.sh
#               output: qemu-system-x86_64[.exe], share/, lib/)
#   RELEASE_REPO  owner/name the packs are published under (default: this repo)
set -euo pipefail

VERSION=${1:-dev}
REPO=${ORCHARD_SRC_REPO:-https://github.com/61soldiers/orchard.git}
REF=${ORCHARD_SRC_REF:-main}
TARGETS=${TARGETS:-"linux/amd64 linux/arm64 darwin/arm64 windows/amd64"}
RELEASE_REPO=${RELEASE_REPO:-61soldiers/elbert-apple-music-plugin}

here=$(cd "$(dirname "$0")/.." && pwd)
QEMU_DIR=${QEMU_DIR:-$here/tool/qemu/out}
if [ "$VERSION" = dev ]; then
	# Development: the packs ride inside the package, where the plugin looks first.
	dest="$here/assets/runtime"
	base_url=""
else
	# Release: the packs are release assets, not part of the package.
	dest="$here/release/runtime"
	base_url="https://github.com/$RELEASE_REPO/releases/download/v$VERSION"
fi
rm -rf "$dest" "$here/assets/runtime" "$here/assets/orchard" "$here/assets/guest" "$here/assets/qemu"
mkdir -p "$dest" "$here/assets" # assets/ holds nothing tracked, so a fresh checkout has no such folder

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${ORCHARD_SRC_DIR:-}" ]; then
	src=$(cd "$ORCHARD_SRC_DIR" && pwd)
	echo "Using local Orchard checkout: $src"
	src_head=$(cd "$src" && git rev-parse --short HEAD 2>/dev/null || echo unknown)
	# This path builds the WORKING TREE, uncommitted changes included, so the
	# commit id alone can name a build that exists nowhere in git. (CI never hits
	# this — it clones a clean ref.)
	if [ "$src_head" != "unknown" ] && ! (cd "$src" && git diff --quiet HEAD -- 2>/dev/null); then
		src_head="$src_head-dirty"
		echo "warning: $src has uncommitted changes — they are going into the build." >&2
	fi
	ref_id="local:$src_head"
else
	echo "Cloning $REPO @ $REF"
	git clone --depth 1 --branch "$REF" "$REPO" "$work/orchard" 2>/dev/null || git clone "$REPO" "$work/orchard"
	(cd "$work/orchard" && git checkout --quiet "$REF" 2>/dev/null || true)
	src="$work/orchard"
	ref_id="$REPO@$(cd "$src" && git rev-parse HEAD)"
fi
for f in go.mod cmd/orchard/main.go; do
	[ -e "$src/$f" ] || { echo "error: $src is missing $f — not an Orchard checkout" >&2; exit 1; }
done
command -v go >/dev/null || { echo "error: Go is required (https://go.dev/dl/)" >&2; exit 1; }

# Strip filesystem metadata that would land in the archive as SCHILY.xattr PAX
# records: macOS tags every file with a binary `com.apple.provenance` xattr, and
# the pure-Dart `archive` package Elbert unpacks with (`fs.extract`) throws on it.
tar_meta_opts=()
if tar --version 2>&1 | grep -qi 'bsdtar'; then
	tar_meta_opts=(--no-xattrs --no-mac-metadata --no-acls --no-fflags)
fi
pack() { # pack <archive> <dir>   — everything in <dir>, fixed order, no owner
	COPYFILE_DISABLE=1 tar ${tar_meta_opts[@]+"${tar_meta_opts[@]}"} -czf "$1" -C "$2" .
}
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }; else sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi
filesize() { wc -c <"$1" | tr -d ' '; }

entries=()
add_entry() { # add_entry <name> <file>
	local f=$dest/$2
	entries+=("\"$1\": {\"file\": \"$2\", \"sha256\": \"$(sha256 "$f")\", \"size\": $(filesize "$f")}")
}

# ---- Orchard, per platform ---------------------------------------------------------
for target in $TARGETS; do
	goos=${target%/*}
	goarch=${target#*/}
	exe=orchard
	[ "$goos" = windows ] && exe=orchard.exe
	stage="$work/orchard-$goos-$goarch"
	mkdir -p "$stage"
	echo "Building Orchard for $goos/$goarch"
	(cd "$src" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="-s -w -buildid=" -o "$stage/$exe" ./cmd/orchard)
	pack "$dest/orchard-$goos-$goarch.tar.gz" "$stage"
	add_entry "orchard-$goos-$goarch" "orchard-$goos-$goarch.tar.gz"
done

# ---- The VM guest, shared by every vm pack -----------------------------------------
guest="$work/guest"
if command -v mkfs.ext4 >/dev/null 2>&1; then
	echo "Building the VM guest"
	(cd "$src" && go run ./cmd/guestbuild -arch x86_64 -out "$guest" -cache "$work/guest-cache")
else
	echo "warning: mkfs.ext4 not found — no VM packs (macOS and Windows need them)" >&2
fi

# ---- QEMU + guest, per platform ------------------------------------------------------
if [ -d "$guest" ] && [ -d "$QEMU_DIR" ]; then
	for q in "$QEMU_DIR"/*/; do
		name=$(basename "$q") # <os>-<arch>
		stage="$work/vm-$name"
		rm -rf "$stage" && mkdir -p "$stage/guest"
		cp -R "$q". "$stage/"
		cp "$guest"/* "$stage/guest/"
		echo "Packing vm-$name"
		pack "$dest/vm-$name.tar.gz" "$stage"
		add_entry "vm-$name" "vm-$name.tar.gz"
	done
fi

# ---- The manifest the plugin reads -----------------------------------------------------
{
	echo "{"
	echo "  \"orchardRef\": \"$ref_id\","
	echo "  \"version\": \"$VERSION\","
	echo "  \"baseUrl\": \"$base_url\","
	echo "  \"packs\": {"
	printf '    %s' "${entries[0]}"
	for e in "${entries[@]:1}"; do printf ',\n    %s' "$e"; done
	echo
	echo "  }"
	echo "}"
} >"$here/assets/runtime.json"
echo "Wrote $dest ($(du -sh "$dest" | cut -f1)) and assets/runtime.json — ref: $ref_id"
ls -la "$dest" | tail -n +2
