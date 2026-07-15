#!/usr/bin/env bash
set -euo pipefail

project_dir="$(pwd)"
signing_dir="${AGENTLAS_SIGNING_DIR:-signing}"
local_release="${TMPDIR:-/tmp}/agentlas-desktop-release-$$"
cleaner_pid=""
dmg_signing_keychain=""
dmg_signing_identity=""
original_keychains=()
stable_repo="${AGENTLAS_DESKTOP_GITHUB_REPO:-agentlas-ai/agentlas-desktop-releases}"

load_local_signing_defaults() {
  local p12_path="$signing_dir/agentlas-developer-id.p12"
  local p12_password_path="$signing_dir/agentlas-developer-id.p12.password"
  local app_password_path="$signing_dir/apple-app-specific-password"

  if [[ -z "${CSC_LINK:-}" && -f "$p12_path" ]]; then
    export CSC_LINK="$p12_path"
  fi
  if [[ -z "${CSC_KEY_PASSWORD:-}" && -f "$p12_password_path" ]]; then
    export CSC_KEY_PASSWORD
    CSC_KEY_PASSWORD="$(<"$p12_password_path")"
  fi
  if [[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -f "$app_password_path" ]]; then
    export APPLE_APP_SPECIFIC_PASSWORD
    APPLE_APP_SPECIFIC_PASSWORD="$(<"$app_password_path")"
  fi
}

prepare_app_notarization_authority() {
  [[ "${AGENTLAS_PUBLIC_RELEASE:-0}" == "1" ]] || return 0

  # electron-builder must notarize/staple the inner .app before producing both
  # the DMG and updater ZIP. Outer-DMG notarization alone is not update lineage.
  if [[ -z "${APPLE_KEYCHAIN_PROFILE:-}" && -z "${APPLE_ID:-}" && -z "${APPLE_API_KEY:-}" ]]; then
    local profile="${AGENTLAS_NOTARY_PROFILE:-agentlas-notary}"
    if xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
      export APPLE_KEYCHAIN_PROFILE="$profile"
    fi
  fi

  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then return 0; fi
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then return 0; fi
  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then return 0; fi
  echo "Missing complete inner-app notarization authority." >&2
  return 1
}

cleanup_appledouble() {
  for target in "$@"; do
    if [[ -e "$target" ]]; then
      find "$target" -name '._*' -delete 2>/dev/null || true
      if command -v dot_clean >/dev/null 2>&1; then
        dot_clean -m "$target" 2>/dev/null || true
      elif [[ -x /usr/sbin/dot_clean ]]; then
        /usr/sbin/dot_clean -m "$target" 2>/dev/null || true
      fi
    fi
  done
}

cleanup() {
  if [[ -n "$cleaner_pid" ]]; then
    kill "$cleaner_pid" 2>/dev/null || true
    wait "$cleaner_pid" 2>/dev/null || true
  fi
  if [[ -n "${dmg_signing_keychain:-}" ]]; then
    security delete-keychain "$dmg_signing_keychain" >/dev/null 2>&1 || true
  fi
  if (( ${#original_keychains[@]} > 0 )); then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "$local_release"
}
trap cleanup EXIT

read_keychains() {
  security list-keychains -d user | sed -E 's/^ *"?([^"]+)"?$/\1/'
}

prepare_dmg_signing_identity() {
  if [[ -n "${AGENTLAS_DMG_SIGN_IDENTITY:-}" ]]; then
    dmg_signing_identity="$AGENTLAS_DMG_SIGN_IDENTITY"
    return 0
  fi

  dmg_signing_identity="$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')"
  if [[ -n "$dmg_signing_identity" ]]; then
    return 0
  fi

  if [[ -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" ]]; then
    echo "Missing Developer ID Application identity. Set CSC_LINK/CSC_KEY_PASSWORD or AGENTLAS_DMG_SIGN_IDENTITY." >&2
    return 1
  fi

  dmg_signing_keychain="${TMPDIR:-/tmp}/agentlas-dmg-sign-$$.keychain-db"
  local keychain_password
  keychain_password="$(openssl rand -hex 24)"

  security create-keychain -p "$keychain_password" "$dmg_signing_keychain"
  security unlock-keychain -p "$keychain_password" "$dmg_signing_keychain"
  security set-keychain-settings -lut 21600 "$dmg_signing_keychain"
  security import "$CSC_LINK" -k "$dmg_signing_keychain" -A -P "$CSC_KEY_PASSWORD" >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$dmg_signing_keychain" >/dev/null

  original_keychains=()
  while IFS= read -r keychain; do
    original_keychains+=("$keychain")
  done < <(read_keychains)
  security list-keychains -d user -s "$dmg_signing_keychain" "${original_keychains[@]}"

  dmg_signing_identity="$(security find-identity -p codesigning "$dmg_signing_keychain" | awk '/Developer ID Application/ {print $2; exit}')"
  if [[ -z "$dmg_signing_identity" ]]; then
    echo "Could not find Developer ID Application identity in CSC_LINK." >&2
    return 1
  fi
}

sign_dmg() {
  local dmg_path="$1"
  codesign --force --timestamp --sign "$dmg_signing_identity" "$dmg_path"
  codesign --verify --verbose=4 "$dmg_path"
}

notarize_dmg() {
  local dmg_path="$1"
  local profile="${AGENTLAS_NOTARY_PROFILE:-agentlas-notary}"

  if xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
    xcrun notarytool submit "$dmg_path" --keychain-profile "$profile" --wait
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    xcrun notarytool submit "$dmg_path" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
  else
    echo "Missing notarization credentials for $dmg_path." >&2
    echo "Set AGENTLAS_NOTARY_PROFILE or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID." >&2
    return 1
  fi

  xcrun stapler staple "$dmg_path"
  xcrun stapler validate "$dmg_path"
}

exercise_signed_app_python_boundary() {
  local host_arch signed_app candidate_arches
  case "$(uname -m)" in
    arm64) host_arch="arm64" ;;
    x86_64) host_arch="x86_64" ;;
    *)
      echo "Unsupported macOS host architecture for signed-app Python smoke: $(uname -m)" >&2
      return 1
      ;;
  esac

  signed_app=""
  while IFS= read -r -d '' candidate; do
    candidate_arches="$(lipo -archs "$candidate/Contents/MacOS/Agentlas")"
    if [[ " $candidate_arches " == *" $host_arch "* ]]; then
      signed_app="$candidate"
      break
    fi
  done < <(find "$local_release" -type d -name 'Agentlas.app' -print0)

  if [[ -z "$signed_app" ]]; then
    echo "Could not find a host-architecture signed Agentlas.app under $local_release." >&2
    return 1
  fi

  codesign --verify --deep --strict --verbose=2 "$signed_app"
  # Release signing/notarization credentials exist in this shell. The embedded
  # Core must never inherit them merely because this smoke exercises Python.
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-en_US.UTF-8}" \
    CI="${CI:-1}" \
    ./node_modules/.bin/electron scripts/smoke-signed-mac-python-cache.cjs "--app=$signed_app"
  # The exercise imports the packaged bridge and real embedded Agentlas OS from
  # this exact signed app. Any new Resources/__pycache__ now invalidates the seal.
  codesign --verify --deep --strict --verbose=2 "$signed_app"
}

cleanup_appledouble "$project_dir/dist" "$project_dir/release"
load_local_signing_defaults
prepare_app_notarization_authority
npm run build
rm -rf "$project_dir/release" "$local_release"
mkdir -p "$local_release"
cleanup_appledouble "$project_dir/dist"

build_mac_arch() {
  local arch="$1"
  local builder_args=(
    --mac "--${arch}"
    --config electron-builder.mac-stable.yml
  )
  cleanup_appledouble "$project_dir/dist" "$project_dir/release" "$local_release"
  # A public updater ZIP must contain the same stapled app as its DMG. Local
  # candidates stay explicitly unnotarized and can never enter this channel.
  if [[ "${AGENTLAS_PUBLIC_RELEASE:-0}" != "1" ]]; then
    builder_args+=(--config.mac.notarize=false)
  fi
  COPYFILE_DISABLE=1 electron-builder \
    "${builder_args[@]}" \
    --publish never \
    --config.directories.output="$local_release"
}

while true; do
  cleanup_appledouble "$project_dir/dist" "$project_dir/release" "$local_release"
  sleep 0.05
done &
cleaner_pid=$!

build_mac_arch arm64
build_mac_arch x64

rm -rf "$project_dir/release"
mkdir -p "$project_dir/release"
COPYFILE_DISABLE=1 ditto "$local_release" "$project_dir/release"
cleanup_appledouble "$project_dir/release"

if [[ "${AGENTLAS_PUBLIC_RELEASE:-0}" == "1" ]]; then
  exercise_signed_app_python_boundary
  prepare_dmg_signing_identity
  while IFS= read -r dmg_path; do
    sign_dmg "$dmg_path"
    notarize_dmg "$dmg_path"
  done < <(find "$project_dir/release" -maxdepth 1 -type f -name 'Agentlas-*.dmg' | sort)
  node scripts/verify-mac-release.mjs --write-env "--repo=${stable_repo}"
else
  node scripts/verify-mac-release.mjs --write-env --allow-unnotarized "--repo=${stable_repo}"
fi

# 반드시 마지막에 — electron-builder와 verify-mac-release 모두 latest-mac.yml을 .dmg로
# 써버린다. 자동업데이트(Squirrel.Mac)는 .zip만 적용 가능하므로 zip 기준으로 재작성한다.
node "$project_dir/scripts/fix-mac-latest-zip.mjs"

# The x64 package is built last and electron-builder rewrites local native
# modules for that target. Restore the developer machine architecture so
# post-package smoke tests and the next local Desktop launch do not fail with a
# cross-architecture better-sqlite3/keytar binary.
case "$(uname -m)" in
  arm64) host_arch="arm64" ;;
  x86_64) host_arch="x64" ;;
  *)
    echo "Skipping native dependency restore for unsupported host architecture: $(uname -m)" >&2
    exit 0
    ;;
esac
npx electron-rebuild --force --arch="$host_arch"
