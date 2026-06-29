#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

fail=0
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

need_file() {
  if [ -f "$1" ]; then ok "$1"; else bad "missing file: $1"; fi
}

need_dir() {
  if [ -d "$1" ]; then ok "$1/"; else bad "missing dir: $1/"; fi
}

need_json() {
  if [ ! -f "$1" ]; then bad "missing json: $1"; return; fi
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1" >/dev/null 2>&1; then
    ok "valid json: $1"
  else
    bad "invalid json: $1"
  fi
}

echo "== root package =="
need_file README.md
need_file AGENTS.md
need_file CLAUDE.md
need_file GEMINI.md
need_file agent.md
need_json manifest.json
need_json agentlas.json
need_file agents/00-startup-orchestrator/agent.md
need_file skills/startup-orchestration/SKILL.md
need_file docs/research-synthesis.md
need_file docs/agent-hq-build-plan.md
need_file docs/orchestration-map.md
need_file docs/source-to-hq-traceability.md
need_file docs/package-quality-audit.md
need_file docs/startup-gui-ux.md
need_file docs/design.md
need_file templates/founder-execution-packet.md
need_file examples/founder-execution-sample.md
need_file web/dist/index.html
need_file web/dist/studio-data.json
need_file web/src/data/types.ts
need_file web/src/store/studio-context.tsx
need_file web/src/i18n/index.tsx
need_file apps/founder-mobile/README.md
need_file apps/founder-mobile/app/index.html
need_file apps/founder-mobile/app/styles.css
need_file apps/founder-mobile/app/app.js
need_file apps/founder-mobile/app/manifest.webmanifest
need_file apps/founder-mobile/ios/Package.swift
need_file apps/founder-mobile/ios/App/FounderMobileShell.swift
need_file apps/founder-mobile/ios/AppIntents/FounderAppIntents.swift
need_file apps/founder-mobile/ios/Tests/FounderMobileIntentsTests/FounderMobileIntentsTests.swift
need_file apps/founder-mobile/android/qa-plan.md
need_file scripts/open-studio-gui.py
need_file scripts/design-provider-login.py
need_file scripts/hephaestus-network-check.py
need_file scripts/stitch-design-handoff.py
need_file scripts/android-qa-preflight.py
need_file docs/dogfood/startup-agent-app/README.md
need_file docs/dogfood/startup-agent-app/01-idea-brief.md
need_file docs/dogfood/startup-agent-app/02-market-validation.md
need_file docs/dogfood/startup-agent-app/03-business-plan.md
need_file docs/dogfood/startup-agent-app/prd/spec.md
need_file docs/dogfood/startup-agent-app/stitch/stitch-brief.md
need_file docs/dogfood/startup-agent-app/stitch/stitch-handoff-package.json
need_file docs/dogfood/startup-agent-app/stitch/generated/README.md
need_file docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001-v2.png
need_file docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001-v2.html
need_file docs/dogfood/startup-agent-app/05-build-plan.md
need_file docs/dogfood/startup-agent-app/06-qa-network-log.md
need_file docs/dogfood/startup-agent-app/07-sales-demo.md

echo "== .agentlas contracts =="
need_json .agentlas/agent-card.json
need_json .agentlas/company-blueprint.json
need_json .agentlas/routing-card.json
need_json .agentlas/memory-map.json
need_json .agentlas/global-plugin-tools.json
need_json .agentlas/design-provider-mcp.json
need_json .agentlas/global-commands.json
need_json .agentlas/vault-references.json
need_file .agentlas/project-soul-memory.md
need_file .agentlas/design-memory.md
need_file .agentlas/memory-tickets.jsonl
need_file .agentlas/curator-decisions.jsonl
need_file .agentlas/routing-benchmarks.jsonl

echo "== startup gui (SPA + session-runtime bridge) =="
if python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("web/dist/studio-data.json").read_text(encoding="utf-8"))
en = data.get("en") or {}
spine = en.get("ideaSpine") or {}
if not spine.get("oneLiner"):
    print("ideaSpine.oneLiner missing"); raise SystemExit(1)
stages = en.get("stages") or {}
required = ["idea", "market", "business", "prd", "build", "deck"]
missing = [s for s in required if s not in stages]
if missing:
    print("missing lifecycle stages: " + ", ".join(missing)); raise SystemExit(1)
for s in required:
    st = stages[s]
    for k in ("key", "label", "hq", "headline", "summary"):
        if k not in st:
            print(f"stage {s} missing scaffold field {k}"); raise SystemExit(1)
PY
then
  ok "Studio SPA data carries ideaSpine + all 6 lifecycle stages with scaffold"
else
  bad "Studio SPA studio-data.json contract failed"
fi

if python3 - <<'PY'
from pathlib import Path
src = Path("scripts/open-studio-gui.py").read_text(encoding="utf-8")
needles = ["/__studio/request", "/__studio/manifest", "/studio-data.json", "studio_state_dir", "requests.jsonl"]
missing = [n for n in needles if n not in src]
if missing:
    print("launcher missing bridge bits: " + ", ".join(missing)); raise SystemExit(1)
PY
then
  ok "Launcher implements the session-runtime dev bridge (request/manifest/data)"
else
  bad "Launcher dev-bridge contract failed"
fi

# The runner is what makes click -> auto-generate real: the bridge must spawn the
# local CLI per queued request and atomically commit the validated output. Guard
# against a regression to the old "session must watch the queue by hand" design.
if python3 - <<'PY'
from pathlib import Path
src = Path("scripts/open-studio-gui.py").read_text(encoding="utf-8")
needles = [
    "class StudioRunner",
    "studio-data.next.json",
    "os.replace",
    "STUDIO_AUTORUN",
    '"-p"',
    "StudioRunner(root, state_dir).start()",
    "codex_host",
    "CODEX_THREAD_ID",
    "subprocess.Popen",
    "_next_promotable",
    ".next.json ready before CLI exit",
    "proc.terminate",
]
missing = [n for n in needles if n not in src]
if missing:
    print("launcher missing auto-runner bits: " + ", ".join(missing)); raise SystemExit(1)
PY
then
  ok "Launcher auto-runs the queue (spawns local CLI -> validates -> atomic commit)"
else
  bad "Launcher auto-runner contract failed (queue would not auto-generate)"
fi

if python3 - <<'PY'
from pathlib import Path
src = Path("scripts/open-studio-gui.py").read_text(encoding="utf-8")
needles = ["fallback is disabled", "gui_unavailable", "no embedded fallback; Startup Studio must serve the built React SPA"]
forbidden = ["return \"embedded\", None", "return serve_embedded(args.port", "embedded-in-launcher", "embedded tier needs only"]
missing = [n for n in needles if n not in src]
bad = [n for n in forbidden if n in src]
if missing or bad:
    if missing:
        print("missing no-fallback guard: " + ", ".join(missing))
    if bad:
        print("active embedded fallback remains: " + ", ".join(bad))
    raise SystemExit(1)
PY
then
  ok "Launcher forbids embedded/static fallback and requires the real SPA"
else
  bad "Launcher fallback guard failed"
fi

if python3 scripts/open-studio-gui.py --no-serve >/tmp/startup-gui-launch.json 2>&1 && grep -q '"status": "gui_ready"' /tmp/startup-gui-launch.json; then
  ok "Startup GUI launcher reports gui_ready"
else
  bad "Startup GUI launcher failed; see /tmp/startup-gui-launch.json"
fi

if python3 scripts/design-provider-login.py --provider stitch --dry-run >/tmp/startup-design-provider-stitch.json 2>&1 && grep -q '"status": "ready_to_run"' /tmp/startup-design-provider-stitch.json; then
  ok "Stitch design-provider login action is available"
else
  bad "Stitch design-provider login dry-run failed; see /tmp/startup-design-provider-stitch.json"
fi

if python3 scripts/design-provider-login.py --provider claude-design --dry-run >/tmp/startup-design-provider-claude.json 2>&1 && grep -q '"status": "ready_to_open"' /tmp/startup-design-provider-claude.json; then
  ok "Claude Design login action is available"
else
  bad "Claude Design login dry-run failed; see /tmp/startup-design-provider-claude.json"
fi

if python3 scripts/stitch-design-handoff.py --no-write >/tmp/startup-stitch-handoff.json 2>&1 && python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path("/tmp/startup-stitch-handoff.json").read_text())
assert payload["schema"] == "agentlas.startup.stitch-handoff.v1"
assert payload["provider"] == "Google Stitch"
assert "npx @_davideast/stitch-mcp" in json.dumps(payload)
assert "REF-GEN-STITCH-001" in payload["prompt"]
assert "app web prototype" in payload["prompt"]
assert "web artifact preview" in payload["prompt"]
assert "REQ-DOG-006" in payload["prompt"]
assert "REQ-DOG-007" in payload["prompt"]
sources = {item["source_id"]: item for item in payload["generated_sources"]}
assert sources["REF-GEN-STITCH-001-v2"]["status"] == "current_desktop_visual_source"
assert sources["REF-GEN-STITCH-001"]["status"] == "superseded"
PY
then
  ok "Stitch handoff package can be generated without storing credentials"
else
  bad "Stitch handoff package generation failed; see /tmp/startup-stitch-handoff.json"
fi

if python3 scripts/hephaestus-network-check.py >/tmp/startup-hephaestus-network-check.json 2>&1 && python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path("/tmp/startup-hephaestus-network-check.json").read_text())
assert payload["status"] == "checked"
visibility = payload["startup_hub_visibility"]
assert visibility["ok"] is True
assert visibility["search_top_slugs"][0] == "agentlas-startup-founder-studio"
assert "agentlas-startup-founder-studio" in visibility["route_top_slugs"][:3]
PY
then
  ok "Hephaestus Network Hub-only visibility passes for Startup Studio"
else
  bad "Hephaestus Network Hub-only visibility failed; see /tmp/startup-hephaestus-network-check.json"
fi

if python3 - <<'PY'
from pathlib import Path
brief = Path("docs/dogfood/startup-agent-app/stitch/stitch-brief.md").read_text(encoding="utf-8")
qa = Path("docs/dogfood/startup-agent-app/06-qa-network-log.md").read_text(encoding="utf-8")
sales = Path("docs/dogfood/startup-agent-app/07-sales-demo.md").read_text(encoding="utf-8")
assert "Google Stitch" in brief
assert "REF-GEN-STITCH-001" in brief
assert "REF-GEN-STITCH-001-v2" in brief
assert "Hephaestus" in qa
assert "route" in qa
assert "Stitch" in qa
assert "e47d5e29b5684f908d7891a65697e069" in qa
assert "DOG-027" in qa
assert "Starter" in sales and "Studio" in sales and "Concierge" in sales
assert "Paid Pilot Script" in sales and "Pilot Tracker Defaults" in sales
generated = Path("docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001-v2.html").read_text(encoding="utf-8")
for label in [
    "아이디어 구체화",
    "Starter",
    "Studio",
    "Concierge",
    "Pilot 01",
    "Pilot 02",
    "Pilot 03",
    "2/3",
    "검증 전",
    "지원사업 양식 비교",
]:
    assert label in generated
PY
then
  ok "dogfood run records Stitch handoff, Hephaestus findings, and sales proof"
else
  bad "dogfood run is missing Stitch, Hephaestus, or sales evidence"
fi

if python3 - <<'PY'
from pathlib import Path
idx = Path("web/src/i18n/index.tsx").read_text(encoding="utf-8")
ctx = Path("web/src/store/studio-context.tsx").read_text(encoding="utf-8")
types = Path("web/src/data/types.ts").read_text(encoding="utf-8")
checks = {
    "GUI run trigger (requestRun)": "requestRun" in idx,
    "dev-bridge POST (/__studio/request)": "/__studio/request" in idx,
    "dev-bridge poll (/__studio/manifest)": "/__studio/manifest" in idx,
    "live content load (studio-data.json)": "studio-data.json" in idx,
    "new-idea action (startIdea)": "startIdea" in ctx,
    "stage schema (StageKey)": "StageKey" in types,
}
missing = [k for k, v in checks.items() if not v]
if missing:
    print("SPA run-loop missing: " + "; ".join(missing)); raise SystemExit(1)
PY
then
  ok "Studio SPA wires new-idea + per-stage run through the session-runtime bridge"
else
  bad "Studio SPA run-loop contract failed"
fi

if python3 - <<'PY'
import json
from pathlib import Path
mobile_html = Path("apps/founder-mobile/app/index.html").read_text(encoding="utf-8")
mobile_js = Path("apps/founder-mobile/app/app.js").read_text(encoding="utf-8")
mobile_manifest = json.loads(Path("apps/founder-mobile/app/manifest.webmanifest").read_text())
ios_package = Path("apps/founder-mobile/ios/Package.swift").read_text(encoding="utf-8")
ios_app = Path("apps/founder-mobile/ios/App/FounderMobileShell.swift").read_text(encoding="utf-8")
ios = Path("apps/founder-mobile/ios/AppIntents/FounderAppIntents.swift").read_text(encoding="utf-8")
android = Path("apps/founder-mobile/android/qa-plan.md").read_text(encoding="utf-8")
assert "오늘의 창업 작업" in mobile_html
assert "새 아이디어 만들기" in mobile_html
assert "시장 검증 열기" in mobile_html
assert "startup-studio-mobile-shell-v1" in mobile_js
assert mobile_manifest["display"] == "standalone"
assert "FounderMobileApp" in ios_package
assert "FounderMobileShell" in ios_app
assert "FounderMobileWorkflow" in ios_app
assert "SwiftUI" in ios_app
assert "AppShortcutsProvider" in ios
assert "CreateStartupIdeaIntent" in ios
assert "OpenStartupWorkIntent" in ios
assert "adb devices" in android
assert "uiautomator dump" in android
assert "screencap" in android
PY
then
  ok "Founder mobile shell, static native source contracts, and Android QA contract exist"
else
  bad "Founder mobile shell or native QA contract failed"
fi

if python3 scripts/android-qa-preflight.py >/tmp/startup-android-qa-preflight.json 2>&1 && python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path("/tmp/startup-android-qa-preflight.json").read_text())
assert payload["schema"] == "agentlas.startup.android-qa-preflight.v1"
assert payload["plan"] == "apps/founder-mobile/android/qa-plan.md"
assert payload["status"] in {
    "ready_to_run_emulator_qa",
    "blocked_missing_tools",
    "blocked_missing_apk",
}
assert isinstance(payload["missing_tools"], list)
assert all(name in payload["tools"] for name in ["adb", "gradle", "java"])
PY
then
  ok "Android emulator QA preflight reports explicit ready/blocked status"
else
  bad "Android emulator QA preflight failed; see /tmp/startup-android-qa-preflight.json"
fi

if python3 - <<'PY'
import json
from pathlib import Path
card = json.loads(Path(".agentlas/routing-card.json").read_text())
assert card["routing_status"] == "routing_ready"
assert card["entrypoints"]["gui"] == "web/dist/index.html"
assert card["entrypoints"]["gui_launcher"] == "scripts/open-studio-gui.py"
assert card["network_shortcut"]["enabled"] is True
assert "startup" in card["network_shortcut"]["phrases"]
assert len(card["trigger_examples"]) >= 5
assert sum(1 for row in Path(".agentlas/routing-benchmarks.jsonl").read_text().splitlines() if row.strip()) >= 10
PY
then
  ok "Startup routing card is GUI-aware and routing-ready"
else
  bad "Startup routing card missing GUI or routing-ready fields"
fi

echo "== hub hq routing contract =="
if python3 - <<'PY'
import json
from pathlib import Path
manifest = json.loads(Path("manifest.json").read_text(encoding="utf-8"))
agentlas = json.loads(Path("agentlas.json").read_text(encoding="utf-8"))
expected = [
    "idea-foundry-hq",
    "market-intelligence-hq",
    "business-plan-hq",
    "agentlas-prd-maker-studio",
    "product-development-hq",
    "defect-driven-slide-studio",
    "Web_master",
]
routes = [row.get("hq") for row in manifest.get("routes_to", [])]
assert routes == expected, routes
for field in [
    "schemaVersion", "packageHash", "runtimeBundleVersion", "skills",
    "toolPermissions", "memoryPolicy", "allowRead", "denyRead",
    "publicExportPolicy", "requiredRuntime", "license", "createdBy",
]:
    assert field in agentlas and agentlas[field], field
assert agentlas["entry"] == "agents/00-startup-orchestrator/agent.md"
assert agentlas["publicExportPolicy"] == "clean-copy"
assert "web/dist/**" in agentlas["denyRead"]
PY
then
  ok "agentlas manifest is Hub-callable and routes to seven Hub HQs"
else
  bad "agentlas manifest or Hub HQ route contract failed"
fi

if python3 - <<'PY'
from pathlib import Path
launcher = Path("scripts/open-studio-gui.py").read_text(encoding="utf-8")
readme = Path("README.md").read_text(encoding="utf-8")
agents = Path("AGENTS.md").read_text(encoding="utf-8")
assert "--local-inventory" in launcher and '"[]"' in launcher
assert "--allow-paid-overlap" not in launcher
assert "OPERATOR_LOCAL_FALLBACK" in launcher
assert "not bundled" in readme and "Agentlas Hub" in readme
assert "local routing skipped" in agents or "Hub" in agents
PY
then
  ok "launcher and docs enforce Hub-first runtime instead of bundled Startup folders"
else
  bad "launcher/docs do not enforce Hub-first runtime"
fi

echo "== end-to-end sample =="
if grep -q "Idea Foundry Output" examples/founder-execution-sample.md \
  && grep -q "Market Intelligence Output" examples/founder-execution-sample.md \
  && grep -q "Business Plan Output" examples/founder-execution-sample.md \
  && grep -q "Product Planning PRD Maker Output" examples/founder-execution-sample.md \
  && grep -q "Product Development Output" examples/founder-execution-sample.md \
  && grep -q "Pitch Deck / IR Output" examples/founder-execution-sample.md \
  && grep -q "simulated" examples/founder-execution-sample.md \
  && grep -q "needs validation" examples/founder-execution-sample.md; then
  ok "sample founder request flows through all six HQs with evidence labels"
else
  bad "sample founder request does not prove all-HQ flow"
fi

echo "== hub production surface gates =="
if python3 - <<'PY'
from pathlib import Path
launcher = Path("scripts/open-studio-gui.py").read_text(encoding="utf-8")
ctx = Path("web/src/store/studio-context.tsx").read_text(encoding="utf-8")
assert "build_production_prompt" in launcher
assert "defect-driven-slide-studio" in launcher
assert "Web_master" in launcher or "web-master" in launcher
assert "RUN_WITH_HEP_NETWORK.md" in launcher
assert "300_000" in ctx
assert "setIdeaModalOpen(false)" in ctx
PY
then
  ok "Hub production surfaces and late-commit UI recovery are guarded"
else
  bad "Hub production surface or late-commit UI recovery guard failed"
fi

echo "== public safety =="
safety_hit=0
scan() {
  if grep -RInE "$1" . \
      --exclude-dir=.git \
      --exclude-dir=node_modules \
      --exclude-dir=.build \
      --exclude='verify-package.sh' \
      --exclude='._*' \
      --exclude='.DS_Store' >/dev/null 2>&1; then
    bad "public-safety: found $2"
    safety_hit=1
  fi
}
scan '/Users/[A-Za-z0-9._-]+/' "private user path"
scan '/Volumes/' "local volume path"
scan 'gh[opsu]_[A-Za-z0-9_]{20,}' "GitHub token"
scan 'sk-[A-Za-z0-9_-]{20,}' "OpenAI-style token"
scan 'BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY' "private key"
[ "$safety_hit" -eq 0 ] && ok "no secrets or local paths found"

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m✓ startup-founder-studio: ALL CHECKS PASSED\033[0m\n'
  exit 0
else
  printf '\033[31m✗ startup-founder-studio: FAILURES ABOVE\033[0m\n'
  exit 1
fi
