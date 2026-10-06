#!/usr/bin/env bash
# Packages QEMU for macOS into assets/qemu/darwin-<arch>.tar.gz, for the arch of
# the Mac it runs on (run it on an Apple Silicon and on an Intel runner). Needs
# Homebrew. NOT YET RUN ON A MAC: written from QEMU's and dylibbundler's
# documentation; the first release build is its first real test.
#
# What it makes: qemu-system-x86_64 with the dylibs it needs beside it (lib/), the
# three firmware files a direct kernel boot uses (share/), and the licence text.
# The binary carries the hypervisor entitlement, so Hypervisor.framework can speed
# it up on an Intel Mac; on Apple Silicon an x86 guest is emulated either way.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
arch=$(uname -m)
case "$arch" in
arm64) goarch=arm64 ;;
x86_64) goarch=amd64 ;;
*) echo "error: unsupported Mac architecture $arch" >&2; exit 1 ;;
esac
out="$here/assets/qemu/darwin-$goarch.tar.gz"
mkdir -p "$(dirname "$out")"

command -v brew >/dev/null || { echo "error: Homebrew is required" >&2; exit 1; }
brew install qemu dylibbundler >/dev/null
prefix=$(brew --prefix qemu)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage="$work/stage"
mkdir -p "$stage/lib" "$stage/share"
cp "$prefix/bin/qemu-system-x86_64" "$stage/"
for f in bios-256k.bin linuxboot_dma.bin kvmvapic.bin; do
	cp "$prefix/share/qemu/$f" "$stage/share/"
done
cp "$prefix/share/doc/qemu/COPYING"* "$stage/" 2>/dev/null || cp "$(brew --prefix)/Cellar/qemu"/*/COPYING* "$stage/" 2>/dev/null || true

# Make the binary relocatable: copy every dylib it links (and theirs) next to it
# and point it there.
dylibbundler -od -b -x "$stage/qemu-system-x86_64" -d "$stage/lib" -p @executable_path/lib >/dev/null

# Moving the dylibs invalidated the signatures. Sign again, ad hoc, giving QEMU
# the hypervisor entitlement.
cat >"$work/hvf.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>
PLIST
for lib in "$stage"/lib/*.dylib; do codesign --force --sign - "$lib"; done
codesign --force --sign - --entitlements "$work/hvf.plist" "$stage/qemu-system-x86_64"

COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --no-acls --no-fflags -czf "$out" -C "$stage" .
echo "Wrote $out ($(du -h "$out" | cut -f1))"
