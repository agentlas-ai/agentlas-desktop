#!/usr/bin/env bash
# Runtime-bundle contract parity gate.
#
# One document, three readers, three release cadences:
#   emitter  Agentlas Web  agentlas/AgentsAtlas/app/src/lib/agentlas-cloud/runtime-bundle.ts
#   reader   Agentlas OS   Agentlas-OS/agentlas_cloud/workforce/execution.py   (pip / runtime update)
#   reader   Terminal      agentlas_terminal/engine/agentlas-workforce.cjs     (npm, user-paced)
#
# The Hub deploys on merge; the two readers reach users days later. So a field
# renamed or added on the emitter side is live against clients that have never
# seen it, and both readers fail CLOSED — the P0 on 2026-07-27 was exactly this:
# Web shipped its file-read allowlist only under `lazyRead.*`, Core's
# project_permission_policy read only `allowRead`/`denyRead`, and every single
# workforce prepare was rejected while all three products' own tests were green.
#
# This gate compares the names, not the behaviour: cheap, and it fires on the
# rename/addition that no single-product test can see.
#
# History: this used to live in the (unversioned) workspace-root scripts/
# directory; when that copy was trashed the npm alias kept printing "skipped
# (CI checkout)" on the dev machine too. The gate now lives in this repo.
# Skip is honest and narrow: only when a sibling repo checkout is absent.
# A sibling that exists but lacks the expected file is a FAILURE — 검사하지
# 못하면 통과가 아니다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_REPO="$ROOT/agentlas"
CORE_REPO="$ROOT/Agentlas-OS"
TERM_REPO="$ROOT/agentlas_terminal"
WEB="$WEB_REPO/AgentsAtlas/app/src/lib/agentlas-cloud/runtime-bundle.ts"
CORE="$CORE_REPO/agentlas_cloud/workforce/execution.py"
TERM_ENGINE="$TERM_REPO/engine/agentlas-workforce.cjs"

for repo in "$WEB_REPO" "$CORE_REPO" "$TERM_REPO"; do
  if [ ! -d "$repo" ]; then
    echo "[sync-runtime-bundle-contract] SKIP — sibling checkout not present: $repo"
    exit 0
  fi
done

for path in "$WEB" "$CORE" "$TERM_ENGINE"; do
  if [ ! -f "$path" ]; then
    echo "[sync-runtime-bundle-contract] FAIL — sibling checkout exists but contract file is missing: $path"
    exit 1
  fi
done

python3 - "$WEB" "$CORE" "$TERM_ENGINE" <<'PY'
import re
import sys

web_path, core_path, term_path = sys.argv[1:4]
web = open(web_path, encoding="utf-8").read()
core = open(core_path, encoding="utf-8").read()
term = open(term_path, encoding="utf-8").read()
failures: list[str] = []

# ---------------------------------------------------------------- permissions
# Core reads each policy input under one of several accepted spellings. The
# emitter has to satisfy at least one spelling per group, or Core falls through
# to deny_all_permission_policy() and every borrowed agent runs with no
# authority at all — which reads to the user as "the agent did nothing".
emitted = set(re.findall(r"^\s{4}([A-Za-z_][A-Za-z0-9_]*):", web, re.MULTILINE))
for group in re.findall(r'merged\((("[^"]+"(?:,\s*)?)+)\)', core):
    names = re.findall(r'"([^"]+)"', group[0])
    if not any(name in emitted for name in names):
        failures.append(
            f"permission policy: Core reads {names} but the Hub bundle emits none of them"
        )

# -------------------------------------------------------------- executionGraph
# The terminal asserts EXACT keys, so one added field on the emitter side is not
# a compatible extension — it is `execution_bundle_invalid` on every terminal
# that has not updated yet.
def terminal_exact_keys(subject: str) -> list[str] | None:
    # The subject label is a plain string for the fixed paths and a template
    # literal for the indexed one (`executionGraph.workers[${index}]`), so accept
    # either quote style rather than only the one that happens to be there today.
    match = re.search(
        r'assertExactKeys\(\s*\w+,\s*\[([^\]]*)\]\s*,\s*[`"]' + re.escape(subject),
        term,
        re.DOTALL,
    )
    return re.findall(r'"([^"]+)"', match.group(1)) if match else None

graph_block = re.search(r"executionGraph\??:\s*\{(.*?)\n  \};", web, re.DOTALL)
if not graph_block:
    failures.append("executionGraph: could not read the emitted shape from the Hub bundle type")
else:
    body = graph_block.group(1)
    web_graph = re.findall(r"^\s{4}([A-Za-z_][A-Za-z0-9_]*)\??\s*:", body, re.MULTILINE)
    web_manager = re.findall(r"manager:\s*\{([^}]*)\}", body)
    web_worker = re.findall(r"workers:\s*Array<\{([^}]*)\}>", body)
    pairs = [
        ("executionGraph", web_graph, terminal_exact_keys("executionGraph")),
        (
            "executionGraph.manager",
            re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\??\s*:", web_manager[0]) if web_manager else [],
            terminal_exact_keys("executionGraph.manager"),
        ),
        (
            "executionGraph.workers[]",
            re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\??\s*:", web_worker[0]) if web_worker else [],
            terminal_exact_keys("executionGraph.workers["),
        ),
    ]
    for subject, emitted_keys, accepted in pairs:
        if accepted is None:
            failures.append(f"{subject}: no assertExactKeys found in the terminal engine")
            continue
        if not emitted_keys:
            failures.append(f"{subject}: could not read the emitted keys from the Hub bundle type")
            continue
        if set(emitted_keys) != set(accepted):
            only_web = sorted(set(emitted_keys) - set(accepted))
            only_term = sorted(set(accepted) - set(emitted_keys))
            failures.append(
                f"{subject}: Hub emits {sorted(emitted_keys)}, terminal accepts exactly "
                f"{sorted(accepted)}"
                + (f" | emitted-but-rejected: {only_web}" if only_web else "")
                + (f" | required-but-absent: {only_term}" if only_term else "")
            )

if failures:
    print("[sync-runtime-bundle-contract] FAIL")
    for line in failures:
        print(f"  - {line}")
    raise SystemExit(1)
print("[sync-runtime-bundle-contract] PASS — emitter and both readers agree on every field name")
PY
