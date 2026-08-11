#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="${AGENTLAS_DESKTOP_STABLE_REPO:-agentlas-ai/agentlas-desktop-releases}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentlas-stable-install.XXXXXX")"
mount_point=""
stage_container=""
stage_path=""
transaction_journal="/Applications/.agentlas-install-transaction.v1.json"
install_lock="/Applications/.agentlas-install.lock"
install_lock_acquired=0
had_existing=0
app_mutated=0
install_committed=0

atomic_exchange() {
  xcrun swift "$project_dir/scripts/atomic-swap-mac.swift" --exchange "$1" "$2"
}

atomic_rename() {
  xcrun swift "$project_dir/scripts/atomic-swap-mac.swift" --rename "$1" "$2"
}

clear_transaction_journal() {
  node "$project_dir/scripts/mac-install-transaction.mjs" clear "--file=$transaction_journal"
}

remove_stage_container() {
  local target="$1"
  if [[ ! "$target" =~ ^/Applications/\.agentlas-install-stage\.[A-Za-z0-9]+$ ]]; then
    echo "Refusing to remove an unexpected macOS install stage path: $target" >&2
    return 1
  fi
  if [[ ! -e "$target" ]]; then
    return 0
  fi

  # Signed app resources can intentionally contain read-only directories.
  # After a successful exchange the stage holds the previous app, so make only
  # directories inside this exact installer-owned tree writable before removal.
  while IFS= read -r -d '' directory; do
    chmod u+rwx "$directory"
  done < <(find "$target" -type d -print0)
  rm -rf "$target"
}

acquire_install_lock() {
  # mkdir is atomic on the destination volume. A second installer must stop
  # before it can reconcile or overwrite the first installer's journal.
  if ! mkdir "$install_lock" 2>/dev/null; then
    echo "Another Agentlas install or recovery is already holding the /Applications transaction lock." >&2
    exit 1
  fi
  install_lock_acquired=1
  printf '%s\n' "$$" > "$install_lock/pid"
}

verify_official_app() {
  node "$project_dir/scripts/verify-mac-install-boundary.mjs" \
    "--mode=official" \
    "--source=$1" \
    "--destination=/Applications/Agentlas.app" \
    "--policy=$project_dir/build-resources/macos-release-signing-policy.json" >/dev/null
}

rollback_install() {
  if [[ "$app_mutated" != "1" || "$install_committed" == "1" ]]; then
    return 0
  fi
  if [[ "$had_existing" == "1" && -d "$stage_path" && -d /Applications/Agentlas.app ]]; then
    if atomic_exchange "$stage_path" /Applications/Agentlas.app; then
      echo "The previous Agentlas app was restored after the install stopped." >&2
      app_mutated=0
      clear_transaction_journal || true
    else
      echo "Could not atomically restore the previous Agentlas app; the transaction journal and staged app were preserved." >&2
      return 1
    fi
  elif [[ "$had_existing" == "0" ]]; then
    rm -rf /Applications/Agentlas.app >/dev/null 2>&1 || true
    app_mutated=0
    clear_transaction_journal || true
  else
    echo "The previous app could not be located for rollback; the transaction journal was preserved." >&2
    return 1
  fi
}

cleanup() {
  rollback_install || true
  if [[ "$app_mutated" != "1" && -n "$stage_container" ]]; then
    remove_stage_container "$stage_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$mount_point" ]]; then
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp_dir"
  if [[ "$install_lock_acquired" == "1" ]]; then
    rm -rf "$install_lock" >/dev/null 2>&1 || true
    install_lock_acquired=0
  fi
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
require_cmd codesign
require_cmd node

recover_interrupted_transaction() {
  if ! node "$project_dir/scripts/mac-install-transaction.mjs" exists "--file=$transaction_journal"; then
    return 0
  fi

  local recovered_stage expected_version recovered_had_existing recovered_phase target_version stage_version
  if ! IFS=$'\t' read -r recovered_stage expected_version recovered_had_existing recovered_phase < <(
    node "$project_dir/scripts/mac-install-transaction.mjs" read "--file=$transaction_journal"
  ); then
    echo "The prior macOS install transaction journal is invalid; refusing to mutate /Applications." >&2
    exit 1
  fi
  target_version=""
  stage_version=""
  if [[ -d /Applications/Agentlas.app ]]; then
    target_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Agentlas.app/Contents/Info.plist 2>/dev/null || true)"
  fi
  if [[ -d "$recovered_stage" ]]; then
    stage_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$recovered_stage/Contents/Info.plist" 2>/dev/null || true)"
  fi

  # Target already contains the fully trusted candidate: finish the commit.
  if [[ "$target_version" == "$expected_version" ]] && verify_official_app /Applications/Agentlas.app; then
    remove_stage_container "$(dirname "$recovered_stage")"
    clear_transaction_journal
    return 0
  fi
  # The verified candidate is still in staging, so the atomic swap never ran.
  # Leave the old target untouched and discard only the staged candidate.
  if [[ "$stage_version" == "$expected_version" ]] && verify_official_app "$recovered_stage"; then
    remove_stage_container "$(dirname "$recovered_stage")"
    clear_transaction_journal
    return 0
  fi
  # The swap ran but post-verification did not complete. Restore the old bundle
  # atomically when both sides still exist; never create an empty target gap.
  if [[ "$recovered_had_existing" == "1" && -d "$recovered_stage" && -d /Applications/Agentlas.app ]]; then
    atomic_exchange "$recovered_stage" /Applications/Agentlas.app
    remove_stage_container "$(dirname "$recovered_stage")"
    clear_transaction_journal
    return 0
  fi
  if [[ "$recovered_had_existing" == "0" && -d /Applications/Agentlas.app ]]; then
    rm -rf /Applications/Agentlas.app
    remove_stage_container "$(dirname "$recovered_stage")"
    clear_transaction_journal
    return 0
  fi
  echo "Could not safely reconcile the prior macOS install transaction; no additional mutation was attempted." >&2
  exit 1
}

acquire_install_lock
recover_interrupted_transaction

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

# The outer DMG is not enough: both manual install and Squirrel must carry an
# inner app in the exact official Developer ID lineage. This also validates the
# app notarization ticket and Gatekeeper before /Applications is changed.
verify_official_app "$mount_point/Agentlas.app"

# Copy and fully verify on the /Applications volume before touching the current
# app. A crash or power loss during this long step leaves the old app intact.
stage_container="$(mktemp -d /Applications/.agentlas-install-stage.XXXXXX)"
stage_path="$stage_container/Agentlas.app"
ditto "$mount_point/Agentlas.app" "$stage_path"
staged_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$stage_path/Contents/Info.plist")"
if [[ "$staged_version" != "$version" ]]; then
  echo "Staged app version mismatch: expected=${version}, app=${staged_version}" >&2
  exit 1
fi
verify_official_app "$stage_path"

osascript -e 'tell application "Agentlas" to quit' >/dev/null 2>&1 || true
sleep 2

if [[ -d /Applications/Agentlas.app ]]; then
  had_existing=1
fi

# From here through post-swap trust verification, EXIT restores the prior app.
# The script intentionally never reads, moves, or deletes ~/Library/Application
# Support/Agentlas or ~/.agentlas; local user data stays outside this transaction.
node "$project_dir/scripts/mac-install-transaction.mjs" write \
  "--file=$transaction_journal" \
  "--stage=$stage_path" \
  "--version=$version" \
  "--had-existing=$([[ "$had_existing" == "1" ]] && echo true || echo false)" \
  "--phase=prepared"

if [[ "$had_existing" == "1" ]]; then
  atomic_exchange "$stage_path" /Applications/Agentlas.app
else
  atomic_rename "$stage_path" /Applications/Agentlas.app
fi
app_mutated=1
node "$project_dir/scripts/mac-install-transaction.mjs" write \
  "--file=$transaction_journal" \
  "--stage=$stage_path" \
  "--version=$version" \
  "--had-existing=$([[ "$had_existing" == "1" ]] && echo true || echo false)" \
  "--phase=swapped"

if ! verify_official_app /Applications/Agentlas.app; then
  echo "Installed app failed the pinned Developer ID/notarization/Gatekeeper validation." >&2
  exit 1
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Agentlas.app

# A verified app is now authoritative. Launch failure must not roll back a valid
# installation; the preserved local data will be reused on first launch.
install_committed=1
clear_transaction_journal
remove_stage_container "$stage_container"
stage_container=""

open -a Agentlas
echo "Agentlas ${version} installed and launched."
