#!/usr/bin/env bash
set -euo pipefail

repo="${AGENTLAS_DESKTOP_STABLE_REPO:-agentlas-ai/agentlas-desktop}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentlas-stable-install.XXXXXX")"
mount_point=""
backup_path=""

cleanup() {
  if [[ -n "$mount_point" ]]; then
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *)
    echo "Unsupported Mac architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd gh
require_cmd hdiutil
require_cmd spctl
require_cmd xcrun

tag="$(gh release view --repo "$repo" --json tagName --jq .tagName)"
version="${tag#v}"
dmg_name="Agentlas-${version}-${arch}.dmg"

echo "Installing Agentlas stable ${version} (${arch}) from ${repo}"
cd "$tmp_dir"
gh release download "$tag" --repo "$repo" --pattern "$dmg_name" --clobber

hdiutil verify "$dmg_name" >/dev/null
xcrun stapler validate "$dmg_name" >/dev/null
spctl -a -t open --context context:primary-signature -vv "$dmg_name" >/dev/null

mount_info="$(hdiutil attach -nobrowse -readonly "$dmg_name")"
mount_point="$(printf '%s\n' "$mount_info" | awk '/\/Volumes\// {for (i=1;i<=NF;i++) if ($i ~ /^\/Volumes\//) {print substr($0, index($0,$i)); exit}}')"
if [[ -z "$mount_point" || ! -d "$mount_point/Agentlas.app" ]]; then
  echo "Could not locate Agentlas.app in mounted DMG." >&2
  exit 1
fi

installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$mount_point/Agentlas.app/Contents/Info.plist")"
if [[ "$installed_version" != "$version" ]]; then
  echo "DMG version mismatch: tag=${version}, app=${installed_version}" >&2
  exit 1
fi

spctl -a -vv "$mount_point/Agentlas.app" >/dev/null

osascript -e 'tell application "Agentlas" to quit' >/dev/null 2>&1 || true
sleep 2

if [[ -d /Applications/Agentlas.app ]]; then
  backup_path="/Applications/Agentlas.app.backup.$(date +%Y%m%d%H%M%S)"
  mv /Applications/Agentlas.app "$backup_path"
fi

ditto "$mount_point/Agentlas.app" /Applications/Agentlas.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Agentlas.app

if ! spctl -a -vv /Applications/Agentlas.app >/dev/null; then
  if [[ -n "$backup_path" && -d "$backup_path" ]]; then
    rm -rf /Applications/Agentlas.app
    mv "$backup_path" /Applications/Agentlas.app
  fi
  echo "Installed app failed Gatekeeper validation; restored previous app." >&2
  exit 1
fi

if [[ -n "$backup_path" ]]; then
  rm -rf "$backup_path"
fi

open -a Agentlas
echo "Agentlas ${version} installed and launched."
