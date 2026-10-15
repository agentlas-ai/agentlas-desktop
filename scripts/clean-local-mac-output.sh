#!/usr/bin/env bash
set -euo pipefail
project_dir="$(pwd)"

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

  local_candidate_output="$project_dir/release-local"
  [[ "$local_candidate_output" == "$project_dir/release-local" ]] || {
    echo "Refusing to clean an unexpected local candidate path." >&2
    exit 1
  }
  remove_sealed_tree "$local_candidate_output"
  exit 0
