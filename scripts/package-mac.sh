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
official_signing_identity="$(node -p "require('./build-resources/macos-release-signing-policy.json').leafAuthority")"
official_team_id="$(node -p "require('./build-resources/macos-release-signing-policy.json').teamIdentifier")"

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

remove_sealed_tree() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  # Older build outputs and post-smoke copies can contain 0555 runtime trees.
  # Restore owner write permission only inside these verified build/output
  # roots so retries and EXIT cleanup can remove them.
  /bin/chmod -RN "$target" 2>/dev/null || true
  /bin/chmod -R u+w "$target" 2>/dev/null || true
  rm -rf -- "$target"
}

if [[ "${1:-}" == "--clean-local-output" ]]; then
  local_candidate_output="$project_dir/release-local"
  [[ "$local_candidate_output" == "$project_dir/release-local" ]] || {
    echo "Refusing to clean an unexpected local candidate path." >&2
    exit 1
  }
  remove_sealed_tree "$local_candidate_output"
  exit 0
fi

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
  remove_sealed_tree "$local_release"
}
trap cleanup EXIT

read_keychains() {
  security list-keychains -d user | sed -E 's/^ *"?([^"]+)"?$/\1/'
}

prepare_dmg_signing_identity() {
  if [[ -n "${AGENTLAS_DMG_SIGN_IDENTITY:-}" ]]; then
    dmg_signing_identity="$AGENTLAS_DMG_SIGN_IDENTITY"
    validate_dmg_signing_identity
    return
  fi

  dmg_signing_identity="$(security find-identity -v -p codesigning | awk -v expected="$official_signing_identity" 'index($0, "\"" expected "\"") {print $2; exit}')"
  if [[ -n "$dmg_signing_identity" ]]; then
    validate_dmg_signing_identity
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

  dmg_signing_identity="$(security find-identity -p codesigning "$dmg_signing_keychain" | awk -v expected="$official_signing_identity" 'index($0, "\"" expected "\"") {print $2; exit}')"
  if [[ -z "$dmg_signing_identity" ]]; then
    echo "Could not find official identity '$official_signing_identity' in CSC_LINK." >&2
    return 1
  fi
  validate_dmg_signing_identity "$dmg_signing_keychain"
}

validate_dmg_signing_identity() {
  local keychain="${1:-}"
  local identity_list selected_line
  if [[ -n "$keychain" ]]; then
    identity_list="$(security find-identity -v -p codesigning "$keychain")"
  else
    identity_list="$(security find-identity -v -p codesigning)"
  fi
  selected_line="$(printf '%s\n' "$identity_list" | awk -v selected="$dmg_signing_identity" '$2 == selected || index($0, "\"" selected "\"") {print; exit}')"
  if [[ -z "$selected_line" || "$selected_line" != *"\"$official_signing_identity\""* ]]; then
    echo "Refusing non-official signing identity. Required: $official_signing_identity" >&2
    return 1
  fi
}

sign_dmg() {
  local dmg_path="$1" signature_metadata
  codesign --force --timestamp --sign "$dmg_signing_identity" "$dmg_path"
  codesign --verify --verbose=4 "$dmg_path"
  signature_metadata="$(codesign -d --verbose=4 "$dmg_path" 2>&1)"
  grep -Fx "Authority=$official_signing_identity" <<<"$signature_metadata" >/dev/null || {
    echo "Signed DMG authority is not the official Agentlas Developer ID." >&2
    return 1
  }
  grep -Fx "TeamIdentifier=$official_team_id" <<<"$signature_metadata" >/dev/null || {
    echo "Signed DMG TeamIdentifier is not $official_team_id." >&2
    return 1
  }
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

seal_packaged_runtime_copy_for_execution() {
  local app_path="$1"
  local runtime_root entry
  for runtime_root in \
    "$app_path/Contents/Resources/Hephaestus" \
    "$app_path/Contents/Resources/python-runtime"; do
    [[ -d "$runtime_root" && ! -L "$runtime_root" ]] || {
      echo "Packaged runtime root is missing or linked: $runtime_root" >&2
      return 1
    }
    /bin/chmod -RN "$runtime_root"
    while IFS= read -r -d '' entry; do
      if [[ -x "$entry" ]]; then
        /bin/chmod 0555 "$entry"
      else
        /bin/chmod 0444 "$entry"
      fi
    done < <(find "$runtime_root" -type f -print0)
    while IFS= read -r -d '' entry; do
      /bin/chmod 0555 "$entry"
    done < <(find "$runtime_root" -depth -type d -print0)
  done
}

exercise_signed_app_python_boundary() {
  local host_arch signed_app candidate_arches
  case "$(uname -m)" in
    arm64) host_arch="arm64" ;;
    x86_64) host_arch="x86_64" ;;
    *)
      echo "Unsupported macOS host architecture for packaged runtime verification: $(uname -m)" >&2
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
  # Core must never inherit them merely because verification exercises Python.
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-en_US.UTF-8}" \
    CI="${CI:-1}" \
    ./node_modules/.bin/electron scripts/verify-packaged-workforce-runtime.cjs "--app=$signed_app"
  # The updater ZIP must stay owner-writable. The legacy signed-cache smoke
  # expects a read-only tree, so seal only this disposable local_release copy
  # after the public ZIP/DMG inputs were copied. Production Python launches are
  # protected by their external cache boundary instead.
  seal_packaged_runtime_copy_for_execution "$signed_app"
  # Exercise an unguarded direct import too. This is the exact class of access
  # that wrote __pycache__ into v0.8.58 and broke its signed source-app seal.
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

exercise_final_update_zip_boundary() {
  local version designated_requirement zip_count
  version="$(node -p "require('./package.json').version")"
  designated_requirement="$(node -p "require('./build-resources/macos-release-signing-policy.json').designatedRequirement")"
  zip_count=0

  while IFS= read -r zip_path; do
    [[ -n "$zip_path" ]] || continue
    zip_count=$((zip_count + 1))
    (
      set -euo pipefail
      local archive_tmp extracted_root archived_app resources_root runtime_root python_root
      local forbidden owner_unwritable unsafe_writable acl_entry xattr_probe python_manifest python_relative python_path
      local isolated_home candidate_arches host_arch
      archive_tmp="$(mktemp -d "${TMPDIR:-/tmp}/agentlas-final-update-zip.XXXXXX")"
      extracted_root="$archive_tmp/extracted"
      mkdir -p "$extracted_root"
      cleanup_final_update_zip() {
        /bin/chmod -RN "$archive_tmp" 2>/dev/null || true
        /bin/chmod -R u+w "$archive_tmp" 2>/dev/null || true
        rm -rf -- "$archive_tmp"
      }
      trap cleanup_final_update_zip EXIT

      COPYFILE_DISABLE=1 ditto -x -k "$zip_path" "$extracted_root"
      archived_app="$extracted_root/Agentlas.app"
      [[ -d "$archived_app" ]] || {
        echo "Final updater ZIP does not contain Agentlas.app: $zip_path" >&2
        exit 1
      }
      resources_root="$archived_app/Contents/Resources"
      runtime_root="$resources_root/Hephaestus"
      python_root="$resources_root/python-runtime"
      python_manifest="$python_root/agentlas-python-runtime.json"
      [[ -d "$runtime_root" && -d "$python_root" ]] || {
        echo "Final updater ZIP is missing its packaged runtime trees: $zip_path" >&2
        exit 1
      }

      codesign --verify --deep --strict "-R=$designated_requirement" "$archived_app"
      owner_unwritable="$(find "$runtime_root" "$python_root" \( -type f -o -type d \) ! -perm -u+w -print -quit)"
      [[ -z "$owner_unwritable" ]] || {
        echo "Final updater ZIP contains an entry that blocks Squirrel quarantine cleanup: $owner_unwritable" >&2
        exit 1
      }
      unsafe_writable="$(find "$runtime_root" "$python_root" \( -type f -o -type d \) \( -perm -g+w -o -perm -o+w \) -print -quit)"
      [[ -z "$unsafe_writable" ]] || {
        echo "Final updater ZIP contains a group/other-writable signed runtime entry: $unsafe_writable" >&2
        exit 1
      }
      acl_entry="$(find "$runtime_root" "$python_root" -exec /bin/ls -lde {} + | awk '$1 ~ /\+$/ { print; exit }')"
      [[ -z "$acl_entry" ]] || {
        echo "Final updater ZIP contains an ACL-bearing signed runtime entry: $acl_entry" >&2
        exit 1
      }
      forbidden="$(find "$runtime_root" "$python_root" \( -type d -name __pycache__ -o -type f \( -name '*.pyc' -o -name '*.pyo' \) \) -print -quit)"
      [[ -z "$forbidden" ]] || {
        echo "Final updater ZIP already contains Python bytecode: $forbidden" >&2
        exit 1
      }
      for xattr_probe in "$runtime_root" "$python_root" "$runtime_root/manifest.json" "$python_manifest"; do
        [[ -e "$xattr_probe" ]] || {
          echo "Final updater ZIP is missing an xattr probe target: $xattr_probe" >&2
          exit 1
        }
        /usr/bin/xattr -w com.agentlas.squirrel-install-probe 1 "$xattr_probe"
        /usr/bin/xattr -d com.agentlas.squirrel-install-probe "$xattr_probe"
      done

      case "$(uname -m)" in
        arm64) host_arch="arm64" ;;
        x86_64) host_arch="x86_64" ;;
        *) host_arch="" ;;
      esac
      candidate_arches="$(lipo -archs "$archived_app/Contents/MacOS/Agentlas")"
      if [[ -n "$host_arch" && " $candidate_arches " == *" $host_arch "* ]]; then
        python_relative="$(node -p "require(process.argv[1]).executableRelativePath" "$python_manifest")"
        python_path="$python_root/$python_relative"
        isolated_home="$archive_tmp/home"
        mkdir -p "$isolated_home"
        env -i \
          HOME="$isolated_home" \
          USERPROFILE="$isolated_home" \
          HEPHAESTUS_RUNTIME_ROOT="$runtime_root" \
          PYTHONPATH="$runtime_root" \
          PYTHONUTF8=1 \
          PYTHONDONTWRITEBYTECODE=1 \
          PYTHONPYCACHEPREFIX="$isolated_home/python-bytecode" \
          "$python_path" -c "import agentlas_cloud, ontology; print('direct-import-ok')" \
          | grep -q '^direct-import-ok$'
        forbidden="$(find "$runtime_root" "$python_root" \( -type d -name __pycache__ -o -type f \( -name '*.pyc' -o -name '*.pyo' \) \) -print -quit)"
        [[ -z "$forbidden" ]] || {
          echo "Direct Python import mutated the final updater ZIP app: $forbidden" >&2
          exit 1
        }
        codesign --verify --deep --strict "-R=$designated_requirement" "$archived_app"
      fi

      echo "Final updater ZIP Squirrel-install/runtime-boundary verification: PASS ($(basename "$zip_path"))"
    )
  done < <(find "$project_dir/release" -maxdepth 1 -type f -name "Agentlas-${version}-*.zip" | sort)

  if [[ "$zip_count" -ne 2 ]]; then
    echo "Expected exactly two final macOS updater ZIPs for $version; found $zip_count." >&2
    return 1
  fi
}

cleanup_appledouble "$project_dir/dist" "$project_dir/release"
load_local_signing_defaults
prepare_app_notarization_authority
npm run build
remove_sealed_tree "$project_dir/release"
remove_sealed_tree "$local_release"
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
  # Each installer must carry a native, SHA-256-pinned Python. The two Mac
  # architectures are built separately, so refresh the extraResource before
  # each electron-builder invocation instead of relying on host Python/Rosetta.
  PYBS_ARCH="$arch" npm run fetch:python
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

remove_sealed_tree "$project_dir/release"
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
  # Inspect the exact ZIP bytes consumed by Squirrel.Mac, after every builder
  # and copy step. This closes the historical gap where the source .app was
  # valid but the updater archive could still carry writable Python sources.
  exercise_final_update_zip_boundary
  node scripts/verify-mac-release.mjs "--repo=${stable_repo}"
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
