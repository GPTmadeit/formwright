#!/usr/bin/env bash
# Signs every installer in DIR that the updater can install but the bundler
# left unsigned (it doesn't sign every format). No-op without a signing key.
#
#     scripts/sign_missing.sh dist-release
set -euo pipefail
dir="$1"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "no signing key; skipping"
  exit 0
fi
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
for f in "$dir"/*; do
  case "$f" in
    *.AppImage | *.deb | *.rpm | *-setup.exe | *.msi | *.app.tar.gz)
      if [ ! -f "$f.sig" ]; then
        echo "signing $f"
        npx tauri signer sign --app-version "$version" "$f"
      fi
      ;;
  esac
done
