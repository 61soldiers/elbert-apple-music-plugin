#!/usr/bin/env bash
# Packages QEMU for Windows into assets/qemu/windows-amd64.tar.gz: the one program
# Orchard runs Apple's Android daemon in, with the DLLs it needs and the three
# firmware files a direct kernel boot uses. Runs on Linux (needs 7z and objdump).
#
# The official installer (https://qemu.weilnetz.de/w64/) holds QEMU for every
# target at 1.2 GB; this keeps the x86_64 system emulator and its closure (~120 MB,
# ~43 MB compressed). QEMU is GPL-2.0: the licence texts travel with it, and the
# source is at the same site.
#
#   QEMU_WINDOWS_INSTALLER   a local copy of the installer (skips the download)
set -euo pipefail

VERSION=20260811
SHA256=f98a8aeb5f7faea9765b6dee28316c266cd179d80354a2fed8e50176f9a2e59f
URL=https://qemu.weilnetz.de/w64/qemu-w64-setup-$VERSION.exe

here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/assets/qemu/windows-amd64.tar.gz"
mkdir -p "$(dirname "$out")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

command -v 7z >/dev/null || { echo "error: 7z (p7zip) is required" >&2; exit 1; }
command -v objdump >/dev/null || { echo "error: objdump (binutils) is required" >&2; exit 1; }

installer=${QEMU_WINDOWS_INSTALLER:-}
if [ -z "$installer" ]; then
	installer="$work/setup.exe"
	echo "Downloading $URL"
	curl -fsSL -o "$installer" "$URL"
fi
if command -v sha256sum >/dev/null; then got=$(sha256sum "$installer" | cut -d' ' -f1); else got=$(shasum -a 256 "$installer" | cut -d' ' -f1); fi
[ "$got" = "$SHA256" ] || { echo "error: installer sha256 is $got, expected $SHA256" >&2; exit 1; }

mkdir "$work/x" "$work/bundle"
(cd "$work/x" && 7z x -y "$installer" >/dev/null)

# The DLLs QEMU needs: its imports, and theirs, wherever the installer has them
# (the rest — kernel32, ws2_32… — come with Windows).
python3 - "$work/x" "$work/bundle" <<'PY'
import os, shutil, subprocess, sys
src, dst = sys.argv[1], sys.argv[2]
have = {f.lower(): f for f in os.listdir(src) if f.lower().endswith('.dll')}
need, todo = set(), ['qemu-system-x86_64.exe']
while todo:
    f = todo.pop()
    out = subprocess.run(['objdump', '-p', os.path.join(src, f)], capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if 'DLL Name:' in line:
            d = line.split('DLL Name:')[1].strip().lower()
            if d in have and have[d] not in need:
                need.add(have[d]); todo.append(have[d])
shutil.copy(os.path.join(src, 'qemu-system-x86_64.exe'), dst)
for d in sorted(need):
    shutil.copy(os.path.join(src, d), dst)
os.makedirs(os.path.join(dst, 'share'))
for f in ('bios-256k.bin', 'linuxboot_dma.bin', 'kvmvapic.bin'):
    shutil.copy(os.path.join(src, 'share', f), os.path.join(dst, 'share', f))
for f in ('COPYING', 'COPYING.LIB'):
    shutil.copy(os.path.join(src, f), dst)
print(f'{len(need)} DLLs bundled')
PY

tar -czf "$out" -C "$work/bundle" .
echo "Wrote $out ($(du -h "$out" | cut -f1))"
