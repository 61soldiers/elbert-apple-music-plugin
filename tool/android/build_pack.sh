#!/usr/bin/env bash
# Builds the Android runtime pack: the companion APK that carries Orchard and Apple's
# daemon, because Android only runs programs that arrived inside an installed APK (see
# the SDK's docs/runtime-packs.md). Elbert downloads it from the release and hands it to
# Android's installer when the plugin is first used (`native.installRuntime`).
#
# The APK has no screen and no launcher icon. It holds, as lib*.so (the only kind of file
# Android extracts into nativeLibraryDir, the only place an app may execute from):
#
#   liborchard.so        the Orchard server, built for android/arm64 with cgo against the
#                        NDK (a static Go binary has no DNS resolver on Android)
#   libmain.so           Apple's daemon          } from the wrapper's arm64 release,
#   liblinker64.so       its bundled linker      } pinned by sha256
#   libproot.so          proot, which gives the daemon its /system via ptrace
#   libprootloader.so    proot's embedded loader, carved out of it
#   libnetdclientnew.so  the netd client the daemon needs
#   lib*.so              Apple's and Android 5's libraries (under their own names)
#
# Orchard's side of this is internal/wrapper/launch_android.go.
#
#   build_pack.sh [version]    the plugin release the pack belongs to (default: dev)
#
# With a real version it also pins the pack in elbert-plugin.json (android.runtimePacks),
# which is what lets Elbert fetch it. A release must be signed with the same key every
# time or Android refuses to update the pack:
#
#   ANDROID_KEYSTORE            path to the keystore (without it a release skips the pack)
#   ANDROID_KEYSTORE_PASSWORD   its password (also the key's)
#   ANDROID_KEY_ALIAS           the key (default: elbert)
#
#   ORCHARD_SRC_DIR   an Orchard checkout (default: clone ORCHARD_SRC_REPO @ ORCHARD_SRC_REF)
#   ANDROID_HOME      the SDK; needs build-tools (aapt2, d8, zipalign, apksigner), a platform
#                     and an NDK (ANDROID_NDK_HOME overrides the one found)
#   RELEASE_REPO      owner/name the APK is published under (default: this repo)
set -euo pipefail

VERSION=${1:-dev}
PACKAGE=io.github.soldiers61.elbert.applemusic.runtime
REPO=${ORCHARD_SRC_REPO:-https://github.com/61soldiers/orchard.git}
REF=${ORCHARD_SRC_REF:-main}
RELEASE_REPO=${RELEASE_REPO:-61soldiers/elbert-apple-music-plugin}

# The arm64 wrapper release: Apple's Android music libraries and daemon, plus proot.
WRAPPER_URL=${WRAPPER_URL:-https://github.com/WorldObservationLog/wrapper/releases/download/wrapper.arm64.latest/Wrapper.arm64.latest.zip}
WRAPPER_SHA=${WRAPPER_ARM64_SHA:-8de5da67e375038ff5a08761c71ccaf90ac5ec711a6d0924ba7328b5e116e0a6}

here=$(cd "$(dirname "$0")/../.." && pwd)
out="$here/release/android"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { echo "error: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ---- signing -------------------------------------------------------------------------
keystore=${ANDROID_KEYSTORE:-}
storepass=${ANDROID_KEYSTORE_PASSWORD:-}
alias=${ANDROID_KEY_ALIAS:-elbert}
if [ -z "$keystore" ]; then
	if [ "$VERSION" != dev ]; then
		echo "warning: no ANDROID_KEYSTORE — skipping the Android runtime pack for $VERSION" >&2
		exit 0
	fi
	# Development: a throwaway key, only good for `adb install` on your own device.
	keystore="$HOME/.android/elbert-apple-music-dev.jks"
	storepass=android
	if [ ! -f "$keystore" ]; then
		mkdir -p "$(dirname "$keystore")"
		keytool -genkeypair -keystore "$keystore" -storepass "$storepass" -keypass "$storepass" -alias "$alias" \
			-keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Elbert Apple Music (dev)" >/dev/null
	fi
fi

# ---- tools ---------------------------------------------------------------------------
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -n "$sdk" ] && [ -d "$sdk" ] || fail "set ANDROID_HOME to the Android SDK"
bt=$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
[ -n "$bt" ] || fail "no build-tools in $sdk"
platform=$(ls -d "$sdk"/platforms/android-*/ 2>/dev/null | sort -V | tail -1)
[ -n "$platform" ] || fail "no platform in $sdk"
android_jar="$platform/android.jar"
ndk=${ANDROID_NDK_HOME:-}
[ -n "$ndk" ] || ndk=$(ls -d "$sdk"/ndk/*/ 2>/dev/null | sort -V | tail -1)
[ -n "$ndk" ] && [ -d "$ndk" ] || fail "no NDK; set ANDROID_NDK_HOME"
cc=$(ls "$ndk"/toolchains/llvm/prebuilt/*/bin/aarch64-linux-android24-clang)
for t in go javac keytool unzip readelf gawk python3; do command -v "$t" >/dev/null || fail "$t is required"; done

# ---- Orchard -------------------------------------------------------------------------
if [ -n "${ORCHARD_SRC_DIR:-}" ]; then
	src=$(cd "$ORCHARD_SRC_DIR" && pwd)
else
	echo "Cloning $REPO @ $REF"
	git clone --depth 1 --branch "$REF" "$REPO" "$work/orchard" 2>/dev/null || git clone "$REPO" "$work/orchard"
	src="$work/orchard"
fi
[ -e "$src/cmd/orchard/main.go" ] || fail "$src is not an Orchard checkout"

libs="$work/lib/arm64-v8a"
mkdir -p "$libs"
echo "Building Orchard (android/arm64)"
# cgo, not pure Go: a static Go binary reads /etc/resolv.conf for DNS, which Android
# does not have; the NDK build resolves names through Android's own resolver.
(cd "$src" && CC="$cc" GOOS=android GOARCH=arm64 CGO_ENABLED=1 \
	go build -buildvcs=false -trimpath -ldflags="-s -w -buildid=" -o "$libs/liborchard.so" ./cmd/orchard)

# ---- the wrapper release -------------------------------------------------------------
echo "Fetching the wrapper release"
curl -fSL --retry 3 -o "$work/wrapper.zip" "$WRAPPER_URL"
[ "$(sha256 "$work/wrapper.zip")" = "$WRAPPER_SHA" ] || fail "the wrapper release does not match its pinned digest"
unzip -q "$work/wrapper.zip" -d "$work/w"
w="$work/w"

cp "$w"/rootfs/system/lib64/*.so "$libs/"
cp "$w/rootfs/system/bin/main" "$libs/libmain.so"
cp "$w/rootfs/system/bin/linker64" "$libs/liblinker64.so"
cp "$w/android/proot" "$libs/libproot.so"
cp "$w/android/libnetd_client.so" "$libs/libnetdclientnew.so"

# proot embeds its loader and extracts it to a temp dir to exec it, which an app may not
# do. Carve it out so it can ship as a library and be named through PROOT_LOADER. Its
# offset is read from the ELF, never hard-coded: it moves between releases.
read -r sec_addr sec_off < <(readelf -SW "$w/android/proot" | gawk '$2==".data"{print strtonum("0x"$4), strtonum("0x"$5)}')
sym() { readelf -sW "$w/android/proot" | gawk -v n="$1" '$8==n{print strtonum("0x"$2)}' | head -1; }
lstart=$(sym _binary_loader_elf_start)
lend=$(sym _binary_loader_elf_end)
off=$((sec_off + lstart - sec_addr))
len=$((lend - lstart))
dd if="$w/android/proot" of="$libs/libprootloader.so" bs=1 skip="$off" count="$len" status=none
head -c4 "$libs/libprootloader.so" | grep -q $'\x7fELF' || fail "the carved proot loader is not an ELF"

# ---- the APK -------------------------------------------------------------------------
# Newer than any earlier pack, so Android accepts it as an update: minutes since 1970.
code=$(($(date +%s) / 60))
mkdir -p "$work/res" "$work/classes" "$work/dex" "$work/src"

cat >"$work/AndroidManifest.xml" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="$PACKAGE">
  <application android:label="Apple Music runtime for Elbert" android:hasCode="true" android:extractNativeLibs="true">
    <activity android:name=".PackActivity" android:exported="true" android:theme="@android:style/Theme.NoDisplay">
      <intent-filter>
        <action android:name="com.evolvedmesh.elbert.action.RUNTIME_PACK" />
        <category android:name="android.intent.category.DEFAULT" />
      </intent-filter>
    </activity>
  </application>
</manifest>
EOF
cat >"$work/src/PackActivity.java" <<EOF
package $PACKAGE;

public class PackActivity extends android.app.Activity {
  @Override
  protected void onCreate(android.os.Bundle state) {
    super.onCreate(state);
    finish();
  }
}
EOF
javac --release 8 -classpath "$android_jar" -d "$work/classes" "$work/src/PackActivity.java" 2>&1 | grep -v "^warning\|^Note" || true
"$bt"d8 --lib "$android_jar" --min-api 24 --output "$work/dex" "$work/classes/$(echo "$PACKAGE" | tr . /)/PackActivity.class"

"$bt"aapt2 link -o "$work/base.apk" -I "$android_jar" --manifest "$work/AndroidManifest.xml" \
	--min-sdk-version 24 --target-sdk-version 34 --version-code "$code" --version-name "${VERSION#v}"

# Add the dex and the libraries, untouched: no stripping, and the extracted copies are
# what runs.
python3 - "$work/base.apk" "$work/dex/classes.dex" "$libs" "$work/unsigned.apk" <<'PY'
import os, sys, zipfile
base, dex, libs, dest = sys.argv[1:]
with zipfile.ZipFile(base) as src, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
    for item in src.infolist():
        z.writestr(item, src.read(item.filename), compress_type=item.compress_type)
    z.write(dex, "classes.dex")
    for name in sorted(os.listdir(libs)):
        z.write(os.path.join(libs, name), f"lib/arm64-v8a/{name}")
PY

mkdir -p "$out"
rm -f "$out"/*.apk "$out"/*.idsig
apk="$out/apple-music-runtime-$VERSION.apk"
"$bt"zipalign -f -p 4 "$work/unsigned.apk" "$work/aligned.apk"
"$bt"apksigner sign --ks "$keystore" --ks-pass "pass:$storepass" --ks-key-alias "$alias" --out "$apk" "$work/aligned.apk"
"$bt"apksigner verify "$apk"
digest=$(sha256 "$apk")
echo "Wrote $apk ($(du -h "$apk" | cut -f1), versionCode $code, sha256 $digest)"

# ---- pin it in the plugin manifest ---------------------------------------------------
if [ "$VERSION" != dev ]; then
	url="https://github.com/$RELEASE_REPO/releases/download/v$VERSION/$(basename "$apk")"
	python3 - "$here/elbert-plugin.json" "$PACKAGE" "$url" "$digest" "$code" <<'PY'
import json, sys
path, package, url, sha, code = sys.argv[1:]
m = json.load(open(path))
android = m.setdefault("android", {})
android["runtimePackages"] = [package]
android["runtimePacks"] = [{"package": package, "url": url, "sha256": sha, "versionCode": int(code)}]
if "android" not in m.get("platforms", []):
    m.setdefault("platforms", []).append("android")
json.dump(m, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
	echo "Pinned the pack in elbert-plugin.json"
fi
