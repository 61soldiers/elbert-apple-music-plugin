#!/usr/bin/env bash
# Builds the smallest QEMU that can run Apple Music's guest: x86_64 system
# emulator, TCG (plus KVM on Linux, HVF on an Intel Mac), user-mode networking,
# and nothing else. No display, audio, USB, GUI or tools: Orchard runs it headless
# with the serial console as its only terminal. The result is one self-contained
# program per OS, so nobody has to install QEMU.
#
#   tool/qemu/build.sh linux   [out-dir]   static (musl) binary, built in an Alpine container
#   tool/qemu/build.sh windows [out-dir]   mingw cross build, in a Fedora container
#   tool/qemu/build.sh macos   [out-dir]   native; run on a Mac (Homebrew), any arch
#
# Writes <out-dir>/qemu-system-x86_64[.exe] and <out-dir>/share/ (the three BIOS
# blobs a direct kernel boot needs). Linux and Windows need Docker or Podman (a
# build tool only: the product has no container). QEMU is GPL-2.0; the source is
# the tarball below.
set -euo pipefail

QEMU_VERSION=11.1.2
QEMU_SHA256=731b5681e4bb18be313231579b8efd0296c5b015fa36dc533874b639ba838016
LIBSLIRP_TAG=v4.9.1

target=${1:?usage: build.sh linux|windows|macos [out-dir]}
here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "${2:-$here/out/$target}" && cd "${2:-$here/out/$target}" && pwd)
work=${QEMU_WORK_DIR:-$(mktemp -d)}
mkdir -p "$work"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

tarball="$work/qemu-$QEMU_VERSION.tar.xz"
if [ ! -f "$tarball" ]; then
	echo "Downloading QEMU $QEMU_VERSION"
	curl -fsSL -o "$tarball" "https://download.qemu.org/qemu-$QEMU_VERSION.tar.xz"
fi
[ "$(sha256 "$tarball")" = "$QEMU_SHA256" ] || { echo "error: QEMU tarball sha256 mismatch" >&2; exit 1; }
src="$work/src"
if [ ! -d "$src" ]; then mkdir -p "$src" && tar -xf "$tarball" -C "$src" --strip-components=1; fi

# What is switched off, and why it is safe: --without-default-features turns every
# optional feature off, then only the ones named here come back.
common_flags=(
	--target-list=x86_64-softmmu --without-default-features
	--enable-tcg --enable-slirp --enable-strip --disable-fdt
	--disable-docs --disable-tools --disable-user --disable-guest-agent --disable-plugins --disable-rust --disable-werror
)

container() { # container <image> <script-body-file>
	local engine
	engine=$(command -v docker || command -v podman) || { echo "error: Docker or Podman is needed to build QEMU for $target" >&2; exit 1; }
	mkdir -p "$work/build-$target"
	"$engine" run --rm -v "$src:/src" -v "$work/build-$target:/build" -v "$out:/out" -v "$2:/build.sh:ro" "$1" sh /build.sh
}

case "$target" in
linux)
	cat >"$work/linux.sh" <<SCRIPT
set -e
apk add --no-cache build-base python3 py3-setuptools py3-wheel py3-pip meson ninja pkgconf flex bison linux-headers \
  glib-dev glib-static zlib-dev zlib-static pixman-dev pixman-static libffi-dev pcre2-dev pcre2-static bash perl xz git >/dev/null
git clone -q --depth 1 --branch $LIBSLIRP_TAG https://gitlab.freedesktop.org/slirp/libslirp.git /tmp/slirp
(cd /tmp/slirp && meson setup build --default-library=static --prefix=/usr/local >/dev/null && ninja -C build install >/dev/null)
export PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib64/pkgconfig
cd /build
kvm=""
# KVM accelerates a guest of the host's own architecture only.
[ "\$(uname -m)" = x86_64 ] && kvm=--enable-kvm
/src/configure --static ${common_flags[*]} \$kvm >/dev/null
make -j\$(nproc) qemu-system-x86_64 >/dev/null
strip --strip-all qemu-system-x86_64
cp qemu-system-x86_64 /out/
SCRIPT
	container alpine:3.24 "$work/linux.sh"
	;;
windows)
	cat >"$work/windows.sh" <<SCRIPT
set -e
dnf -q -y install mingw64-gcc mingw64-gcc-c++ mingw64-glib2-static mingw64-glib2 mingw64-pixman-static mingw64-pixman \
  mingw64-zlib-static mingw64-pcre2-static mingw64-gettext-static mingw64-win-iconv mingw64-win-iconv-static mingw64-libffi-static mingw64-winpthreads-static \
  mingw64-pkg-config mingw64-binutils meson ninja-build python3 python3-pip python3-wheel python3-setuptools flex bison git make xz perl gcc glib2-devel mingw64-headers >/dev/null 2>&1
git clone -q --depth 1 --branch $LIBSLIRP_TAG https://gitlab.freedesktop.org/slirp/libslirp.git /tmp/slirp
cat > /tmp/cross.ini <<INI
[binaries]
c = 'x86_64-w64-mingw32-gcc'
ar = 'x86_64-w64-mingw32-ar'
strip = 'x86_64-w64-mingw32-strip'
windres = 'x86_64-w64-mingw32-windres'
pkg-config = 'x86_64-w64-mingw32-pkg-config'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
INI
export PKG_CONFIG_PATH=/usr/x86_64-w64-mingw32/sys-root/mingw/lib/pkgconfig
(cd /tmp/slirp && meson setup build --cross-file /tmp/cross.ini --default-library=static --prefix=/usr/x86_64-w64-mingw32/sys-root/mingw >/dev/null && ninja -C build install >/dev/null)
cd /build
/src/configure --cross-prefix=x86_64-w64-mingw32- --static --extra-cflags=-DLIBSLIRP_STATIC ${common_flags[*]} >/dev/null
make -j\$(nproc) qemu-system-x86_64.exe >/dev/null
x86_64-w64-mingw32-strip --strip-all qemu-system-x86_64.exe
cp qemu-system-x86_64.exe /out/
SCRIPT
	container fedora:42 "$work/windows.sh"
	;;
macos)
	[ "$(uname -s)" = Darwin ] || { echo "error: the macOS build runs on a Mac" >&2; exit 1; }
	command -v brew >/dev/null || { echo "error: Homebrew is required" >&2; exit 1; }
	brew install meson ninja pkgconf glib pixman libslirp dylibbundler >/dev/null
	extra=()
	# Hypervisor.framework accelerates an x86 guest only on an Intel Mac.
	[ "$(uname -m)" = x86_64 ] && extra+=(--enable-hvf)
	mkdir -p "$work/build-macos" && cd "$work/build-macos"
	"$src/configure" "${common_flags[@]}" "${extra[@]+"${extra[@]}"}" >/dev/null
	make -j"$(sysctl -n hw.ncpu)" qemu-system-x86_64 >/dev/null
	strip qemu-system-x86_64
	cp qemu-system-x86_64 "$out/"
	# The few dylibs it needs (glib, pixman, slirp…) travel beside it.
	mkdir -p "$out/lib"
	dylibbundler -od -b -x "$out/qemu-system-x86_64" -d "$out/lib" -p @executable_path/lib >/dev/null
	cat >"$work/hvf.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>
PLIST
	for lib in "$out"/lib/*.dylib; do codesign --force --sign - "$lib"; done
	codesign --force --sign - --entitlements "$work/hvf.plist" "$out/qemu-system-x86_64"
	;;
*) echo "unknown target $target" >&2; exit 1 ;;
esac

mkdir -p "$out/share"
for f in bios-256k.bin linuxboot_dma.bin kvmvapic.bin; do cp "$src/pc-bios/$f" "$out/share/"; done
cp "$src/COPYING" "$out/COPYING-QEMU"
echo "Built $target QEMU in $out:"
du -sh "$out"/* | sed 's/^/  /'
