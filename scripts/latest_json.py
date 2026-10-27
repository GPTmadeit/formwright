#!/usr/bin/env python3
"""Writes the Tauri updater manifest (latest.json) for a release.

    python scripts/latest_json.py v0.1.1 dist-release/ > dist-release/latest.json

The updater looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`, so
every installer format gets its own entry and updates in its own format
(a .deb install updates from the .deb, an MSI install from the MSI). Each
entry points at its signed file in the release with the signature inlined.
Fails if any file or signature is missing, so a release can never ship a
manifest the updater would reject.
"""

import datetime
import glob
import json
import os
import sys

REPO = "GPTmadeit/formwright"

tag, dist = sys.argv[1], sys.argv[2]
v = tag.lstrip("v")

# (updater keys, file pattern). The first key of each platform is the
# fallback for copies that can't tell how they were installed.
ARTIFACTS = [
    (["linux-x86_64", "linux-x86_64-appimage"], f"Formwright_{v}_amd64.AppImage"),
    (["linux-x86_64-deb"], f"Formwright_{v}_amd64.deb"),
    (["linux-x86_64-rpm"], f"Formwright-{v}-*.x86_64.rpm"),
    (["linux-aarch64", "linux-aarch64-appimage"], f"Formwright_{v}_aarch64.AppImage"),
    (["linux-aarch64-deb"], f"Formwright_{v}_arm64.deb"),
    (["linux-aarch64-rpm"], f"Formwright-{v}-*.aarch64.rpm"),
    (["windows-x86_64", "windows-x86_64-nsis"], f"Formwright_{v}_x64-setup.exe"),
    (["windows-x86_64-msi"], f"Formwright_{v}_x64_*.msi"),
    (["windows-aarch64", "windows-aarch64-nsis"], f"Formwright_{v}_arm64-setup.exe"),
    # One universal app serves both Intel and Apple Silicon Macs.
    (["darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app"], "Formwright_universal.app.tar.gz"),
]

platforms = {}
for keys, pattern in ARTIFACTS:
    matches = glob.glob(os.path.join(dist, pattern))
    if len(matches) != 1:
        found = sorted(os.listdir(dist))
        sys.exit(f"{keys[0]}: expected exactly one {pattern} in {dist}, found {matches}\nfiles: {found}")
    path = matches[0]
    sig = path + ".sig"
    if not os.path.exists(sig):
        sys.exit(f"{keys[0]}: missing signature {sig} (is TAURI_SIGNING_PRIVATE_KEY set?)")
    entry = {
        "signature": open(sig).read().strip(),
        "url": f"https://github.com/{REPO}/releases/download/{tag}/{os.path.basename(path)}",
    }
    for key in keys:
        platforms[key] = entry

json.dump(
    {
        "version": v,
        "notes": f"https://github.com/{REPO}/releases/tag/{tag}",
        "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    },
    sys.stdout,
    indent=2,
)
print()
