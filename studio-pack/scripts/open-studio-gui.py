#!/usr/bin/env python3
"""Open the Startup Studio GUI — always, on any machine, with only python3.

Four-tier fallback so the GUI launches no matter what the consumer has:

  1. Built SPA            — serve `web/dist` if it is already built.
  2. Build the SPA        — if `npm` exists, run `npm install` (when node_modules
                            is missing) + `npm run build`, then serve `web/dist`.
  3. Static webapp dir    — serve `webapp/` (no build, no node) if it survived.
  4. Embedded GUI         — serve a self-contained page embedded in THIS file.

Tier 4 is the guarantee: the page (HTML + CSS + JS) lives inside this `.py`, so
it ships through the Agentlas packager (whose extension allowlist keeps `.py`
but drops `.html`/`.css`) and runs with nothing but python3 — no node, no npm,
no build, no external files, no network.

Flags:
  --no-open        serve but do not open a browser
  --no-serve       print which tier WOULD be used (probe), no server/browser
  --port N         preferred localhost port (default 4173)
  --prefer-static  skip the SPA build; go straight to static dir -> embedded
  --embedded       force the embedded GUI (QA / packaged-without-assets check)
"""

from __future__ import annotations

import argparse
import secrets
import json
import mimetypes
import hmac
import os
import shutil
import socket
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


def find_port(preferred: int) -> int:
    for candidate in [preferred, 4173, 5273, 0]:
        with socket.socket() as probe:
            try:
                # SO_REUSEADDR so a recently-killed server's TIME_WAIT does not
                # push us off the stable port (keeps the GUI on 4173, which the
                # reuse guard probes — so repeated launches stay idempotent).
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(("127.0.0.1", candidate))
                return probe.getsockname()[1]
            except OSError:
                continue
    return preferred


# --- /__studio/request authorization -------------------------------------
# The bridge spawns a full-permission local coding agent from queued requests,
# so the POST endpoint is a write/exec surface. It must NOT be reachable by an
# arbitrary local process or by browser CSRF/DNS-rebinding. Two independent gates:
#   1) Per-session secret token (STUDIO_REQUEST_TOKEN from the desktop host, or
#      generated here for standalone launch). A local non-browser attacker cannot
#      read it; the SPA gets it via cookie.
#   2) Origin / Sec-Fetch-Site validation — blocks cross-site browser requests
#      (the text/plain "simple request" CSRF bypass and DNS-rebinding) even if
#      the loopback port is guessed.
_REQUEST_TOKEN = (os.environ.get("STUDIO_REQUEST_TOKEN") or secrets.token_urlsafe(32)).strip()


def _allowed_origins(host_header: str, server_port: int) -> set:
    origins = {f"http://127.0.0.1:{server_port}", f"http://localhost:{server_port}"}
    # Mirror whatever host:port the request actually arrived on (the bound port).
    if host_header:
        origins.add(f"http://{host_header}")
    return origins


def _read_cookie(cookie_header: str, name: str) -> str:
    for part in (cookie_header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return v
    return ""


def studio_request_authorized(handler, server_port: int) -> tuple[bool, str]:
    """Return (ok, reason) for a POST /__studio/request. Defense in depth:
    Origin/Sec-Fetch first (CSRF), then the per-session token."""
    headers = handler.headers
    # 1) Origin / Sec-Fetch-Site — reject cross-site browser-originated requests.
    origin = (headers.get("Origin") or "").strip()
    sec_site = (headers.get("Sec-Fetch-Site") or "").strip().lower()
    host = (headers.get("Host") or "").strip()
    allowed = _allowed_origins(host, server_port)
    if origin:
        if origin not in allowed:
            return False, "origin"
    elif sec_site and sec_site not in ("same-origin", "none"):
        # Browser told us this is a cross-site request with no/absent Origin.
        return False, "sec-fetch-site"
    # Reject a mismatched Host (DNS-rebinding hardening): must be loopback.
    host_name = host.rsplit(":", 1)[0] if host else ""
    if host_name and host_name not in ("127.0.0.1", "localhost"):
        return False, "host"
    # 2) Per-session token (header, query, or cookie). Only enforced when set.
    if _REQUEST_TOKEN:
        supplied = (headers.get("X-Studio-Token") or "").strip()
        if not supplied:
            supplied = _read_cookie(headers.get("Cookie") or "", "studio_token").strip()
        if not supplied:
            qs = handler.path.split("?", 1)
            if len(qs) == 2:
                from urllib.parse import parse_qs

                supplied = (parse_qs(qs[1]).get("token", [""])[0] or "").strip()
        if not supplied or not hmac.compare_digest(supplied, _REQUEST_TOKEN):
            return False, "token"
    return True, ""


def studio_already_serving(port: int) -> str | None:
    """Return the URL if a Startup Studio GUI is already serving the given port.

    Lets repeated launches be idempotent: reuse the existing server/tab instead
    of spawning another one (which would drift to a new port and pile up tabs).
    """
    import urllib.request

    try:
        # Probe OUR bridge endpoint, not just any React page. The old `id="root"`
        # check matched ANY Vite/React app on the port (e.g. an unrelated "Oberon"
        # dev server) and reused it — opening the wrong app. /__studio/manifest with
        # a "data" field uniquely identifies a Startup Studio bridge.
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/manifest", timeout=0.6) as resp:
            if resp.status != 200:
                return None
            doc = json.loads(resp.read(4096).decode("utf-8", "replace"))
            if isinstance(doc, dict) and "data" in doc:
                return f"http://127.0.0.1:{port}/"
    except Exception:
        return None
    return None


def resolve_hephaestus_runner() -> str | None:
    """Find the installed Hephaestus runner even when shell PATH is minimal."""
    hit = shutil.which("hephaestus")
    if hit:
        return hit

    home = Path.home()
    candidates = [
        home / ".agentlas/runtime/current/bin/hephaestus",
        Path(__file__).resolve().parents[2] / "bin/hephaestus",
    ]
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)

    for cache in (
        home / ".claude/plugins/cache/agentlas-core-engine/hephaestus",
        home / ".codex/plugins/cache/agentlas-core-engine/hephaestus",
    ):
        if not cache.exists():
            continue
        hits = sorted(cache.glob("*/bin/hephaestus"))
        for candidate in reversed(hits):
            if candidate.exists() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def ensure_build(web_dir: Path, dist: Path) -> bool:
    """Best-effort build of the production SPA. Returns True if dist is ready."""
    if (dist / "index.html").exists():
        return True
    if not (web_dir / "package.json").exists():
        return False
    npm = shutil.which("npm")
    if not npm:
        return False
    try:
        # Fresh checkouts have no node_modules — `npm run build` would fail.
        # Install first (manifest.json build command is install + build).
        if not (web_dir / "node_modules").exists():
            subprocess.run([npm, "install"], cwd=web_dir, check=True)
        subprocess.run([npm, "run", "build"], cwd=web_dir, check=True)
    except (subprocess.CalledProcessError, OSError):
        return False
    return (dist / "index.html").exists()


def studio_state_dir(root: Path) -> Path:
    """Writable runtime dir the session-runtime reads/writes: the GUI's run
    queue (requests.jsonl) and the live content (studio-data.json)."""
    d = root / ".studio-runtime"
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------- #
# Credits — ONE flat charge per SESSION on first GUI open. Within a session the   #
# GUI is free no matter what you do (every stage Run, every Hub HQ call, re-runs, #
# new ideas — all $0 more). A session = the agent session (CLAUDE_CODE_SESSION_ID #
# / CODEX_THREAD_ID); end it and reopen → charged again. Balance lives GLOBALLY   #
# (~/.agentlas) so it survives across sessions. Insufficient → guidance, no       #
# charge, generation gated. Edge cases anticipated so the user need not list them:#
#   • reopen / browser refresh in same session  -> reuse, no new charge           #
#   • launcher restarted within the SAME session -> session_key already charged, free
#   • exactly == cost -> charged, balance 0, works                                #
#   • missing/corrupt store -> seed with STUDIO_CREDIT_START (default 100)         #
#   • open fails after charge -> no refund (the fee is for opening the session)    #
#   • disabled (STUDIO_CREDITS=off) or owner -> free, never charged               #
# Tunables: STUDIO_CREDIT_COST (20), STUDIO_CREDIT_START (100), STUDIO_CREDITS=off #
# --------------------------------------------------------------------------- #

CREDIT_COST = int(os.environ.get("STUDIO_CREDIT_COST", "20") or "20")
CREDITS_ENABLED = os.environ.get("STUDIO_CREDITS", "on").strip().lower() not in ("off", "0", "false", "no")
CREDIT_STATE_NAME = ".credits.json"


def _credits_store() -> Path:
    d = Path.home() / ".agentlas"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return d / "studio-credits.json"


def _session_key() -> str:
    """Identity of the current agent session — the unit the 20-credit fee is
    charged against, exactly once. New session (closed + reopened) → new key."""
    for var in ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_COMPANION_SESSION_ID"):
        v = os.environ.get(var)
        if v:
            return f"{var}:{v}"
    return f"proc:{os.getpid()}"


def charge_session(state_dir: Path) -> dict:
    """Charge CREDIT_COST once for THIS session on GUI open; idempotent per
    session key. Writes the result to .credits.json for the manifest + runner."""
    state_file = state_dir / CREDIT_STATE_NAME
    if not CREDITS_ENABLED:
        s = {"enabled": False, "cost": 0, "balance": None, "charged": False, "sufficient": True}
        _write_credit_state(state_file, s)
        return s
    store_path = _credits_store()
    try:
        store = json.loads(store_path.read_text("utf-8"))
        if not isinstance(store, dict):
            store = {}
    except (OSError, json.JSONDecodeError):
        store = {}
    balance = store.get("balance")
    if not isinstance(balance, (int, float)):
        balance = int(os.environ.get("STUDIO_CREDIT_START", "100") or "100")
    charged = store.get("charged_sessions")
    if not isinstance(charged, list):
        charged = []
    skey = _session_key()

    if skey in charged:
        s = {"enabled": True, "cost": CREDIT_COST, "balance": balance, "charged": True, "sufficient": True, "session": skey, "reused": True}
    elif balance >= CREDIT_COST:
        balance -= CREDIT_COST
        charged.append(skey)
        store["balance"] = balance
        store["charged_sessions"] = charged[-300:]  # cap history
        try:
            store_path.write_text(json.dumps(store, ensure_ascii=False, indent=2), "utf-8")
        except OSError:
            pass
        s = {"enabled": True, "cost": CREDIT_COST, "balance": balance, "charged": True, "sufficient": True, "session": skey}
    else:
        s = {"enabled": True, "cost": CREDIT_COST, "balance": balance, "charged": False, "sufficient": False, "session": skey}
    _write_credit_state(state_file, s)
    return s


def _write_credit_state(state_file: Path, s: dict) -> None:
    try:
        state_file.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    except OSError:
        pass


def credit_state(state_dir: Path) -> dict:
    """The current session's credit state for the manifest/runner (read-only)."""
    try:
        return json.loads((state_dir / CREDIT_STATE_NAME).read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"enabled": CREDITS_ENABLED, "cost": CREDIT_COST, "balance": None, "charged": False, "sufficient": True}


# --------------------------------------------------------------------------- #
# Studio runner — the bridge IS the runtime. When the GUI queues a request,    #
# the runner spawns the user's OWN local CLI (claude -p / codex exec, their    #
# subscription model — NO API key, NO per-call cost) headless to GENERATE the  #
# content and write studio-data.json. The mtime bump re-renders the GUI. This  #
# is what makes click -> auto-generate work with nobody watching the queue.    #
# --------------------------------------------------------------------------- #

DATA_NAME = "studio-data.json"
NEXT_NAME = "studio-data.next.json"
BUSY_NAME = ".busy"
LOG_NAME = "runner.log"
RUNNER_PID_NAME = ".runner.pid"

# App names from the bundled samples (salon/inventory/meal/tutor). None of these
# is a legitimate value for another idea — if one appears in generated output but
# NOT in the founder's idea, it's a sample LEAK and the commit is rejected.
SAMPLE_TOKENS = ("단골노트", "재고요정", "NoonPlate", "TutorLoop")

# Each stage runs its REAL HQ. The HQ method/skill files live locally under
# Startup/; the spawned CLI reads them for the full rubric and generates to that
# bar — so the GUI shows HQ-grade output, not a generic one-shot. init = idea
# stage only (the other 5 are clean scaffolds, generated 1-at-a-time on Run).

ANTI_LEAK = (
    "ANTI-LEAK (critical): web/public/studio-data.json is a DIFFERENT idea's SAMPLE "
    "(a salon/nail no-show app named '단골노트', plus meal-kit and tutoring variants). Use it "
    "ONLY to see the JSON field SHAPE — NEVER its content. Do NOT reuse the name '단골노트', any "
    "salon/미용실/네일/노쇼/예약 wording, its competitors, personas, quotes, financial numbers "
    "(₩29,000, 650개 매장, LTV 3.4x), or any of its slide/app copy. Never read or copy anything "
    "under web/public/generated/. Derive EVERY value from THIS founder's ideaSpine and the "
    "already-generated stages."
)

LANG_RULE = (
    "Write ALL content in the SAME language as the idea (Korean idea -> Korean). Put the SAME "
    "generated content under BOTH en and ko (do NOT translate to the other language)."
)

# stage -> the published Agentlas Hub agent SLUG it routes to. The runner calls the
# HUB (`hephaestus hep-call`), which returns the HQ's runtime bundle; the local
# subscription model EXECUTES that bundle (BYOK — the Hub returns instructions, it
# does NOT run the LLM). Real routing to the real HQ, not a local imitation.
STAGE_SLUG = {
    "idea":     "idea-foundry-hq",
    "market":   "market-intelligence-hq",
    "business": "business-plan-hq",
    "prd":      "agentlas-prd-maker-studio",
    "build":    "web-master",
    "deck":     "defect-driven-slide-studio",
}

LOCAL_HQ_PACKAGES = {
    "idea-foundry": "idea-foundry-hq",
    "market-intel": "market-intelligence-hq",
    "business-plan-hq": "business-plan-hq",
    "/prd": "agentlas-prd-maker-studio",
    "product-dev": "product-development-hq",
    "product-development-hq": "product-development-hq",
    "web-master": "Web_master",
    "webmaster": "Web_master",
    "Web_master": "Web_master",
    "slide-studio": "defect-driven-slide-studio",
    "defect-driven-slide-studio": "defect-driven-slide-studio",
}

OPERATOR_LOCAL_FALLBACK = os.environ.get("STUDIO_OPERATOR_LOCAL_FALLBACK", "").strip().lower() in ("1", "true", "yes", "on")
PRODUCTION_MODE = os.environ.get("STUDIO_PRODUCTION_MODE", "auto").strip().lower()
STRICT_PRODUCTION_CONTRACTS = os.environ.get("STUDIO_STRICT_PRODUCTION_CONTRACTS", "1").strip().lower() not in ("0", "false", "no", "off")
MIN_BUILD_BYTES = int(os.environ.get("STUDIO_MIN_BUILD_BYTES", "36000") or "36000")
MIN_DECK_BYTES = int(os.environ.get("STUDIO_MIN_DECK_BYTES", "40000") or "40000")


def _read_text(path: Path, limit: int = 18000) -> str:
    try:
        text = path.read_text("utf-8")
    except OSError:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n\n[...truncated by Startup Studio bridge...]\n"


def _paid_root_for(root: Path) -> Path:
    root = root.resolve()
    if root.parent.name == "Paid":
        return root.parent
    for p in (root, *root.parents):
        paid = p / "Paid"
        if paid.exists():
            return paid
    return root.parent


def _local_package_path(root: Path, stage: str) -> Path | None:
    package = "defect-driven-slide-studio" if stage == "deck" else "Web_master" if stage == "build" else ""
    if not package:
        return None
    path = _paid_root_for(root) / package
    return path if (path / "AGENTS.md").exists() else None


def _local_production_allowed(root: Path, stage: str) -> bool:
    if PRODUCTION_MODE in ("hub", "hub-only", "strict-hub"):
        return False
    return _local_package_path(root, stage) is not None


def _local_hq_bundle(slug: str, cwd: str) -> dict | None:
    package = LOCAL_HQ_PACKAGES.get(slug)
    if not package:
        return None
    root = Path(cwd).resolve()
    paid_root = root.parent if root.parent.name == "Paid" else root.parents[1] if len(root.parents) > 1 else root.parent
    entry = paid_root / package / "AGENTS.md"
    if not entry.exists():
        return None
    try:
        extras = []
        if package == "Web_master":
            for rel in (
                "agents/00-orchestrator/agent.md",
                "agents/40-eval-qa/agent.md",
                "agents/60-design-worker/agent.md",
                "agents/70-dev-worker/agent.md",
                "webmaster_dev/knowledge/stack-and-standards.md",
                "webmaster_dev/knowledge/render-state-flow-gates.md",
                "webmaster_design/knowledge/design-philosophy.md",
            ):
                p = paid_root / package / rel
                if p.exists():
                    extras.append(f"\n\n<<< {rel} >>>\n{_read_text(p, 12000)}\n<<< END {rel} >>>")
        if package == "defect-driven-slide-studio":
            for rel in (
                "STARTUP-HQ-INTEGRATION.md",
                "examples/ai-slide-market-deck/README.md",
                "templates/themes.json",
                "docs/claim-to-layout.md",
            ):
                p = paid_root / package / rel
                if p.exists():
                    extras.append(f"\n\n<<< {rel} >>>\n{_read_text(p, 12000)}\n<<< END {rel} >>>")
        return {
            "slug": slug,
            "receipt": f"local:{package}",
            "entry": _read_text(entry, 22000) + "".join(extras),
            "entry_path": str(entry),
            "full_package": True,
        }
    except OSError:
        return None


def _hep_call(slug: str, context: str, cwd: str) -> dict | None:
    """Route to the Hub HQ over the Hephaestus network. Returns the byom runtime
    bundle (the HQ's entry instructions + grounding + receipt) for the local model
    to execute. None when hephaestus is absent or the bundle is not ready."""
    hep = resolve_hephaestus_runner()
    if not hep:
        return _local_hq_bundle(slug, cwd) if OPERATOR_LOCAL_FALLBACK else None
    try:
        agent_ref = slug if slug.startswith(("hub:", "cloud:")) else f"hub:{slug}"
        proc = subprocess.run(
            [
                hep,
                "hep-call",
                agent_ref,
                (context or "stage generation")[:600],
                "--local-inventory",
                "[]",
            ],
            cwd=cwd, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=150,
        )
        doc = json.loads(proc.stdout or "{}")
        agents = doc.get("agents") or []
        out = (agents[0].get("output") if agents else {}) or {}
        if out.get("status") != "bundle_ready":
            return _local_hq_bundle(slug, cwd) if OPERATOR_LOCAL_FALLBACK else None
        return {
            "slug": slug,
            "receipt": doc.get("receipt_id"),
            "entry": out.get("entry_excerpt") or "",
            "entry_path": out.get("entry_path") or "AGENTS.md",
            "entry_excerpt_len": len(out.get("entry_excerpt") or ""),
            "full_package": False,
        }
    except (json.JSONDecodeError, OSError, subprocess.TimeoutExpired):
        return _local_hq_bundle(slug, cwd) if OPERATOR_LOCAL_FALLBACK else None

STAGE_BAR = {
    "idea": (
        "Apply the Idea Foundry method: score the idea on a 100-point scorecard, apply the 7 Powers "
        "lens and Korea-market saturation, and give a clear verdict (조건부 GO / GO / 보류 / PIVOT). "
        "metrics should include real signals (e.g. score, demand strength, moat, payer clarity)."
    ),
    "market": (
        "Apply the Market Intelligence method. Fill: competitors[] split into DIRECT vs SUBSTITUTE vs "
        "STATUS-QUO and mark the gap/wedge (gap:true); marketSizing TAM/SAM/SOM each with a real basis; "
        "personas[] each with needs, a quote that names a real workaround/trigger/objection, willingness, "
        "fit; trends[]; positioning (a 2x2 with axes + players, mark us:true); sources[] cited. 'Uses AI' is "
        "NOT a differentiator — find a real wedge."
    ),
    "business": (
        "Apply the Business Plan method (SBA structure). Fill: businessModel = a 9-cell Business Model Canvas; "
        "financials = a projection table (columns + rows + a chart series) with a real split (revenue / COGS / "
        "opex / net); unitEconomics (CAC, LTV, payback, margin) with honest assumptions; milestones[]; useOfFunds[]. "
        "Tie every number to THIS idea — no generic plan."
    ),
    "prd": (
        "Apply the PRD Maker method — produce a REAL spec, not a sketch.\n"
        "  REQUIREMENTS: spec[] = 6-10 EARS-style requirements (REQ-001…), each a 'SHALL' with a "
        "WHEN/WHILE/IF-THEN/WHERE condition, a feature tree (features→sub-features), acceptance criteria, and a linked screen.\n"
        "  USER FLOW (NOT a linear 1-2-3 list): userFlow[] nodes each with id (STEP-n or SCR-nnn), kind "
        "(start|screen|action|decision|end), title, detail, screen; AND flowEdges[] as directed labeled edges "
        "{from,to,label} INCLUDING decision branches ('예'/'아니오') and back-edges (error/retry/cancel). ALSO emit "
        "flowMermaid: a valid Mermaid 'flowchart TD' source for the SAME graph (decision diamonds + labeled edges).\n"
        "  WIREFRAMES: wireframes[] = 3-6 screens (also set wireframe = the first, for back-compat). Each screen: id "
        "(SCR-nnn), name, route, caption, surface (mobile|desktop|web), blocks[], and states[] (empty/loading/error/success → "
        "trigger → response). EVERY block of kind 'button' MUST set target (the destination screen id/route OR a verb like "
        "'제출'/'결제') and op (a backend op like 'POST /api/...' or 'local'). Trace every REQ to a screen and every CTA to a target."
    ),
    "build": (
        "Act as the Web Master — the output IS the product. Fill product.appName, screenTitle, summary[], items[], cta, "
        "platform ('web' or 'app'), and product.appHtml = a FULL, self-contained, idea-specific HTML app (ONE file, inline "
        "CSS+JS, NO external/CDN/network). Web-master grade: a real type hierarchy (not a single Inter hero), idea-specific "
        "color tokens (NOT a generic purple/blue gradient), the core flow across 2-4 sections/screens, real interactive states "
        "(hover/active/empty/loading), realistic idea-specific copy + data. 15KB-40KB of real app — NOT one static card. No emoji, "
        "no broken inline SVG, no horizontal overflow at 375px or 1440px. It must VISIBLY be THIS idea's product. Add real CTAs "
        "(id or data-edit attributes help the click-to-edit picker). Also save the full app as "
        ".studio-runtime/artifacts/build/index.html and set artifacts[] with href '/__studio/artifacts/build/index.html'."
    ),
    "deck": (
        "Act as the Defect-Driven Slide Studio. First set claimSpine {governingThought, audience, deckPurpose}. Then slides[] = "
        "10-14 slides in IR order (title, problem, market TAM/SAM/SOM, solution, product, business model, why-now/traction, "
        "competition, team, financials, ask, closing). Each slide: an ACTION title (the takeaway) + kicker (section) + keyMessage; "
        "claims[] (≤2) each with evidence (verified|needs-evidence|needs-founder|assumption) and a source line; a bigStat for hero "
        "metrics; a chart {kind bar|line, series, message, yLabel, source, axisStartsAtZero:true} for QUANTITATIVE slides (market, "
        "financials); a diagram {kind pyramid|chevron|hexagon|cycle|matrix, items} for STRUCTURAL slides (funnel, model, roadmap); "
        "substantive, non-duplicating speaker notes. Also set residualRisks[]. NEVER fabricate traction, TAM, or customer logos — "
        "label every unproven claim honestly. Native artifact contract: save deck.ir.json, index.html, and defect-report.json under "
        ".studio-runtime/artifacts/deck/; if the PPTX renderer is available, also save pitch-deck.pptx. Set artifacts[] with hrefs "
        "under '/__studio/artifacts/deck/'. The GUI preview is only a white preview; the full deck should open from index.html."
    ),
}

ARTIFACT_CONTRACT = {
    "build": (
        "MUST create .studio-runtime/artifacts/build/index.html containing the full self-contained app. "
        "MUST set stage.artifacts to include {label:'Open full app', kind:'html', role:'primary', "
        "href:'/__studio/artifacts/build/index.html'} plus a QA/report artifact if available."
    ),
    "deck": (
        "MUST create .studio-runtime/artifacts/deck/deck.ir.json, .studio-runtime/artifacts/deck/index.html, "
        "and .studio-runtime/artifacts/deck/defect-report.json. Use the Defect-Driven Slide Studio renderer when available. "
        "If a PPTX builder is available, also create .studio-runtime/artifacts/deck/pitch-deck.pptx. "
        "MUST set stage.artifacts with links to the full deck, source JSON, defect report, and PPTX when present."
    ),
}


def _hub_header(slug: str, bundle: dict | None) -> str:
    """The CLI runs AS the Hub HQ. With a bundle, it executes the Hub's returned
    runtime instructions (real routing); without (Hub down), it degrades to the
    named HQ's standard method so a stage still generates."""
    if bundle and bundle.get("entry"):
        receipt = str(bundle.get("receipt") or "")
        if receipt.startswith("local:"):
            return (
                f"You are executing the local Forge HQ '{slug}' for the Startup Studio "
                f"(source {bundle.get('entry_path')}, receipt {receipt}). You ARE this HQ now; "
                "apply its method faithfully:\n\n"
                f"<<< LOCAL HQ RUNTIME ({bundle.get('entry_path')}) >>>\n{bundle['entry']}\n<<< END LOCAL HQ RUNTIME >>>\n\n"
                "Do ONLY the task below, then STOP — no chat report, no questions, no GUI.\n\n"
            )
        return (
            f"You are executing the Agentlas Hub agent '{slug}' for the Startup Studio, routed over the "
            f"Hephaestus network (receipt {receipt}). The Hub returned THIS agent's runtime "
            "instructions for YOU to run with your own model (the Hub does not run an LLM) — you ARE this "
            "HQ now; apply its method faithfully:\n\n"
            f"<<< HQ RUNTIME ({bundle.get('entry_path')}) >>>\n{bundle['entry']}\n<<< END HQ RUNTIME >>>\n\n"
            "Do ONLY the task below, then STOP — no chat report, no questions, no GUI.\n\n"
        )
    return (
        f"The required Agentlas Hub agent '{slug}' did not return a callable runtime bundle. Do NOT imitate this HQ "
        "with a generic answer. Produce only a clean handoff/prompt artifact for the founder to run through "
        "/hep-network after Hub availability is restored, and mark the stage as needing Hub execution. Do ONLY "
        "the task below, then STOP — no chat report, no questions, no GUI.\n\n"
    )


def build_init_prompt(idea: str, bundle: dict | None) -> str:
    return (
        _hub_header(STAGE_SLUG["idea"], bundle)
        + "TASK: A founder submitted a new one-line idea. Build a FRESH Studio board and Write it to "
        ".studio-runtime/studio-data.next.json.\n\n"
        + f"FOUNDER IDEA: {idea}\n\n"
        + LANG_RULE + "\n\n"
        + "Schema = web/src/data/types.ts. Use web/public/studio-data.json ONLY to copy each stage's STATIC "
        "fields verbatim (key, index, label, tagline, hq, hqPath, agent, icon, runSteps) + see field SHAPE. "
        "Top-level keys: name, en, ko, _meta; en/ko each have ideaSpine + stages with the 6 keys idea, market, "
        "business, prd, build, deck.\n\n"
        + "GENERATE the IDEA stage now — your HQ Output mapped into the board:\n"
        "- name: a short product name you coin for THIS idea.\n"
        "- ideaSpine: oneLiner (polished idea), customer, problem, stage:\"idea\".\n"
        "- stages.idea: headline, verdict {label,tone} (a REAL go/no-go, tone positive|warning|danger|neutral|accent), "
        "summary, metrics, workItems, decision, crossChecks, document; honest evidence labels.\n"
        "  IDEA OUTPUT SHAPE: " + STAGE_BAR["idea"] + "\n\n"
        + "SCAFFOLD the other 5 stages (market, business, prd, build, deck): keep STATIC fields, RESET dynamic "
        "ones — verdict {\"label\":\"대기\",\"tone\":\"neutral\"} (English idea: \"awaiting\"), headline "
        "\"Run으로 생성\" (English: \"Run to generate\"), summary \"\", metrics [], workItems [], crossChecks [], "
        "document.sections []; ALL stage arrays empty (competitors, personas, trends, sources, businessModel, "
        "unitEconomics, milestones, useOfFunds, spec, userFlow, flowEdges, wireframes, slides -> []); OMIT "
        "marketSizing, positioning, financials, wireframe, product, flowMermaid, claimSpine, residualRisks.\n\n"
        + ANTI_LEAK + "\n\n"
        + "Set _meta to {\"bump\": 1}. Output is the file only: write valid JSON to "
        ".studio-runtime/studio-data.next.json and stop."
    )


def build_run_prompt(stage: str, bundle: dict | None, request: dict | None = None) -> str:
    founder_request = ""
    if request:
        prompt = str(request.get("prompt") or "").strip()
        selector = str(request.get("selector") or "").strip()
        target = str(request.get("target") or "").strip()
        if prompt or selector or target:
            founder_request = (
                "FOUNDER EDIT REQUEST: "
                f"{prompt or 'Regenerate this stage.'}"
                + (f"\nTARGET SURFACE: {target}" if target else "")
                + (f"\nTARGET SELECTOR/ELEMENT: {selector}" if selector else "")
                + "\nApply this request while preserving upstream business logic and artifact contracts.\n\n"
            )
    return (
        _hub_header(STAGE_SLUG[stage], bundle)
        + "TASK: Regenerate the ONE stage below as THIS HQ's real Output, then Write the FULL updated document "
        "to .studio-runtime/studio-data.next.json.\n\n"
        + f"STAGE: {stage}\n\n"
        + founder_request
        + "1. Read .studio-runtime/studio-data.json (the current board). Keep EVERYTHING identical (name, "
        "ideaSpine, every OTHER stage) EXCEPT this stage. The idea is ideaSpine.oneLiner; build on the "
        "already-generated upstream stages (idea/market/business) for consistency.\n"
        + LANG_RULE + "\n\n"
        + f"2. Produce THIS HQ's real Output for the founder, then MAP it into the Studio board stage '{stage}' "
        "(schema web/src/data/types.ts): verdict {label,tone} (REAL, NOT '대기'/'awaiting'), headline, summary, "
        "metrics, workItems, decision, crossChecks, document.sections, PLUS this stage's surfaces. Honest evidence labels.\n"
        + "   " + stage.upper() + " OUTPUT SHAPE: " + STAGE_BAR[stage] + "\n"
        + ("   NATIVE ARTIFACT CONTRACT: " + ARTIFACT_CONTRACT[stage] + "\n" if stage in ARTIFACT_CONTRACT else "")
        + "   If your HQ also produces any richer native artifact (a deck, a built app, a spec doc), SAVE it under "
        ".studio-runtime/artifacts/" + stage + "/ and record it in stage.artifacts so the founder can open it outside the GUI.\n\n"
        + ANTI_LEAK + "\n\n"
        + "3. Put the regenerated stage under BOTH en and ko. Increment _meta.bump by 1. Output is the file "
        "only: write valid JSON to .studio-runtime/studio-data.next.json and stop."
    )


def build_production_prompt(stage: str, bundle: dict | None, request: dict | None = None) -> str:
    target_dir = f".studio-runtime/productions/{stage}"
    founder_prompt = str((request or {}).get("prompt") or "").strip()
    local_full_package = bool(bundle and bundle.get("full_package"))
    hub_excerpt_only = bool(bundle and not bundle.get("full_package") and int(bundle.get("entry_excerpt_len") or 0) < 2500)
    package_rule = (
        "You have the local full package contract in the runtime block above. Use it as the binding HQ contract.\n"
        if local_full_package
        else "Do not depend on Mason's local Paid folder; public users do not have it.\n"
    )
    strict_rule = (
        "MECHANICAL CONTRACT GATE: do not register a production artifact unless it is a real HQ-quality artifact. "
        "If you cannot satisfy the exact file contract, write RUN_WITH_HEP_NETWORK.md in the target folder and leave "
        "artifacts[] unchanged. Thin generic HTML, tiny mockups, or hand-waved PPTX files are failures.\n"
    )
    if hub_excerpt_only:
        strict_rule += (
            "IMPORTANT: the Hub returned only a short entry excerpt, not the full package/toolchain. That is enough "
            "to explain the HQ, but not enough to impersonate its full production factory. Prefer a handoff prompt "
            "over fake artifacts unless you can fully satisfy the gate.\n"
        )
    return (
        _hub_header(STAGE_SLUG[stage], bundle)
        + "TASK: This is a SPECIALIST PRODUCTION run, not a GUI preview. Use the Startup Studio planning packet "
        "to create real external artifacts in the target folder, then update only the artifact links in the board.\n\n"
        + f"STAGE: {stage}\n"
        + f"TARGET FOLDER: {target_dir}\n\n"
        + ("FOUNDER REQUEST:\n" + founder_prompt + "\n\n" if founder_prompt else "")
        + "1. Read .studio-runtime/studio-data.json. Treat idea, market, business, and PRD stages as the source packet.\n"
        + "2. Create the real production files in TARGET FOLDER. Do not make a generic mock. " + package_rule
        + ("   BUILD OUTPUT: Web_master-grade runnable self-contained PROTOTYPE artifact: index.html, README.md, and qa-report.json. The visible UI must clearly label itself as 'Prototype' or '프로토타입' so founders do not mistake it for a shipped production app. It must pass anti-slop, responsive, state, flow, and no-SVG/no-emoji gates.\n" if stage == "build" else "")
        + ("   DECK OUTPUT: Defect-Driven Slide Studio white-background investor deck files: deck.ir.json, index.html, defect-report.json, README.md, and pitch-deck.pptx if the renderer is available. Prefer the studio renderer/toolchain, not hand-written slide cards.\n" if stage == "deck" else "")
        + strict_rule
        + "3. Preserve every board field, but write .studio-runtime/studio-data.next.json with this stage's artifacts[] pointing to "
        f"'/__studio/productions/{stage}/...' links for the files you created. If production fails, write no fake artifact.\n\n"
        + ANTI_LEAK + "\n\n"
        + "Output is files only. Stop after writing the production files and studio-data.next.json."
    )


def _artifact(stage: str, label: str, filename: str, kind: str, role: str) -> dict:
    return {
        "label": label,
        "href": f"/__studio/artifacts/{stage}/{filename}",
        "kind": kind,
        "role": role,
        "filename": filename,
    }


def _html_escape(value) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _write_text_if_stale(path: Path, text: str, started_at: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.exists() and path.stat().st_mtime >= started_at - 1:
            return
    except OSError:
        pass
    path.write_text(text, "utf-8")


def _deck_html(stage: dict) -> str:
    slides = stage.get("slides") if isinstance(stage.get("slides"), list) else []
    cards = []
    for i, slide in enumerate(slides, 1):
        title = _html_escape(slide.get("title") or f"Slide {i}")
        kicker = _html_escape(slide.get("kicker") or "")
        key = _html_escape(slide.get("keyMessage") or slide.get("subtitle") or "")
        big = slide.get("bigStat") or slide.get("metric") or {}
        claims = slide.get("claims") if isinstance(slide.get("claims"), list) else []
        bullets = slide.get("bullets") if isinstance(slide.get("bullets"), list) else []
        chart = slide.get("chart") if isinstance(slide.get("chart"), dict) else None
        diagram = slide.get("diagram") if isinstance(slide.get("diagram"), dict) else None
        body_bits = []
        if big:
            body_bits.append(f"<div class='big'>{_html_escape(big.get('value'))}<span>{_html_escape(big.get('caption'))}</span></div>")
        if chart:
            series = chart.get("series") if isinstance(chart.get("series"), list) else []
            rows = "".join(f"<li>{_html_escape(p.get('label'))}: <b>{_html_escape(p.get('value'))}{_html_escape(chart.get('unit'))}</b></li>" for p in series)
            body_bits.append(f"<div class='panel'><p>{_html_escape(chart.get('message'))}</p><ul>{rows}</ul></div>")
        if diagram:
            items = diagram.get("items") if isinstance(diagram.get("items"), list) else []
            chips = "".join(f"<span>{_html_escape(x)}</span>" for x in items)
            body_bits.append(f"<div class='diagram'>{chips}</div>")
        if claims:
            rows = "".join(
                f"<li>{_html_escape(c.get('text'))}<em>{_html_escape(c.get('evidence'))} · {_html_escape(c.get('source'))}</em></li>"
                for c in claims
            )
            body_bits.append(f"<ul class='claims'>{rows}</ul>")
        elif bullets:
            body_bits.append("<ul class='claims'>" + "".join(f"<li>{_html_escape(b)}</li>" for b in bullets) + "</ul>")
        source = _html_escape(slide.get("sourceLine") or "")
        cards.append(
            f"<section class='slide'><p class='kicker'>{kicker}</p><h1>{title}</h1><p class='key'>{key}</p>"
            + "".join(body_bits)
            + f"<footer>{source}<span>{i} / {len(slides)}</span></footer></section>"
        )
    title = _html_escape((stage.get("document") or {}).get("title") or "Pitch deck")
    return (
        "<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title><style>"
        "body{margin:0;background:#f1f5f9;color:#111827;font-family:Pretendard,Apple SD Gothic Neo,system-ui,sans-serif}"
        ".slide{width:1280px;height:720px;box-sizing:border-box;margin:32px auto;padding:76px 88px;background:#fff;border:1px solid #dbe3ef;border-radius:24px;box-shadow:0 24px 70px #0f172a18;position:relative;overflow:hidden}"
        ".kicker{margin:0 0 14px;color:#2563eb;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}"
        "h1{margin:0;max-width:980px;font-size:52px;line-height:1.05;letter-spacing:-.04em}.key{max-width:920px;font-size:24px;line-height:1.45;color:#475569}"
        ".big{margin:26px 0 10px;font-size:78px;font-weight:900;color:#1d4ed8}.big span{display:block;margin-top:8px;font-size:20px;font-weight:600;color:#64748b}"
        ".panel{margin-top:24px;padding:22px 26px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:18px}.panel p{margin:0 0 10px;font-weight:700}.panel li{font-size:20px;line-height:1.65}"
        ".claims{margin-top:28px;padding-left:24px}.claims li{font-size:24px;line-height:1.45;margin:12px 0}.claims em{display:block;margin-top:4px;font-size:14px;color:#64748b;font-style:normal}"
        ".diagram{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.diagram span{padding:18px 20px;border-radius:16px;background:#dbeafe;color:#1e3a8a;font-size:20px;font-weight:800}"
        "footer{position:absolute;left:88px;right:88px;bottom:34px;display:flex;justify-content:space-between;color:#64748b;font-size:14px}"
        "@media(max-width:900px){.slide{width:calc(100vw - 24px);height:auto;min-height:56vw;margin:12px;padding:34px 26px;border-radius:18px}h1{font-size:32px}.key{font-size:18px}.big{font-size:52px}footer{position:static;margin-top:28px}}"
        "@media print{body{background:#fff}.slide{margin:0;border-radius:0;box-shadow:none;page-break-after:always}}"
        "</style></head><body>"
        + "".join(cards)
        + "</body></html>"
    )


def _materialize_native_artifacts(state_dir: Path, doc: dict, started_at: float) -> None:
    """Give the GUI stable external files even when a runner only returned JSON.
    If the routed HQ already wrote a fresh native file during this run, keep it."""
    stages = ((doc.get("en") or {}).get("stages") or {})
    build = stages.get("build") if isinstance(stages.get("build"), dict) else {}
    deck = stages.get("deck") if isinstance(stages.get("deck"), dict) else {}
    root = state_dir / "artifacts"

    build_artifacts = []
    app_html = (((build.get("product") or {}).get("appHtml")) if build else "") or ""
    if app_html.strip():
        _write_text_if_stale(root / "build" / "index.html", app_html, started_at)
        qa = {
            "generatedBy": "Startup Studio bridge",
            "surface": "build",
            "checks": ["product.appHtml present", "served as an isolated full-page artifact"],
            "residualRisks": build.get("residualRisks") or [],
        }
        _write_text_if_stale(root / "build" / "qa-report.json", json.dumps(qa, ensure_ascii=False, indent=2), started_at)
        build_artifacts = [
            _artifact("build", "Open full app", "index.html", "html", "primary"),
            _artifact("build", "Build QA report", "qa-report.json", "report", "qa"),
        ]

    deck_artifacts = []
    slides = deck.get("slides") if isinstance(deck.get("slides"), list) else []
    if slides:
        deck_payload = {
            "claimSpine": deck.get("claimSpine"),
            "slides": slides,
            "residualRisks": deck.get("residualRisks") or [],
            "sources": deck.get("sources") or [],
        }
        _write_text_if_stale(root / "deck" / "deck.ir.json", json.dumps(deck_payload, ensure_ascii=False, indent=2), started_at)
        _write_text_if_stale(root / "deck" / "index.html", _deck_html(deck), started_at)
        assumptions = sum(1 for s in slides if s.get("evidence") == "assumption")
        defects = {
            "generatedBy": "Startup Studio bridge",
            "surface": "deck",
            "slides": len(slides),
            "assumptionSlides": assumptions,
            "residualRisks": deck.get("residualRisks") or [],
            "checks": ["white-background full deck artifact present", "deck.ir.json source present"],
        }
        _write_text_if_stale(root / "deck" / "defect-report.json", json.dumps(defects, ensure_ascii=False, indent=2), started_at)
        deck_artifacts = [
            _artifact("deck", "Open full deck", "index.html", "html", "primary"),
            _artifact("deck", "deck.ir.json", "deck.ir.json", "json", "source"),
            _artifact("deck", "Defect report", "defect-report.json", "report", "qa"),
        ]
        if (root / "deck" / "pitch-deck.pptx").exists():
            deck_artifacts.append(_artifact("deck", "Download PPTX", "pitch-deck.pptx", "pptx", "download"))

    for locale in ("en", "ko"):
        loc_stages = ((doc.get(locale) or {}).get("stages") or {})
        if build_artifacts and isinstance(loc_stages.get("build"), dict) and not loc_stages["build"].get("artifacts"):
            loc_stages["build"]["artifacts"] = build_artifacts
        if deck_artifacts and isinstance(loc_stages.get("deck"), dict) and not loc_stages["deck"].get("artifacts"):
            loc_stages["deck"]["artifacts"] = deck_artifacts


def _looks_like_emoji(text: str) -> bool:
    for ch in text:
        o = ord(ch)
        if 0x1F300 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF:
            return True
    return False


def _production_contract_issue(state_dir: Path, stage: str) -> str | None:
    """File existence is not enough. Only expose production links when the
    specialist artifact mechanically resembles its HQ's real contract."""
    if not STRICT_PRODUCTION_CONTRACTS:
        return None
    root = state_dir / "productions" / stage
    if not root.exists():
        return "missing production folder"
    if stage == "build":
        index = root / "index.html"
        qa = root / "qa-report.json"
        readme = root / "README.md"
        if not index.exists():
            return "missing build/index.html"
        try:
            html = index.read_text("utf-8", errors="replace")
            size = index.stat().st_size
        except OSError:
            return "unreadable build/index.html"
        if size < MIN_BUILD_BYTES:
            return f"build/index.html too small for Web_master production ({size}B < {MIN_BUILD_BYTES}B)"
        low = html.lower()
        if "<svg" in low:
            return "build/index.html violates Web_master no-SVG rule"
        if _looks_like_emoji(html):
            return "build/index.html violates Web_master no-emoji rule"
        if "streamline" in low or "supercharge" in low or "unlock your" in low:
            return "build/index.html contains generic AI/SaaS slop copy"
        if not qa.exists():
            return "missing build/qa-report.json"
        if not readme.exists():
            return "missing build/README.md"
        return None
    if stage == "deck":
        index = root / "index.html"
        ir = root / "deck.ir.json"
        report = root / "defect-report.json"
        if not index.exists():
            return "missing deck/index.html"
        if not ir.exists():
            return "missing deck/deck.ir.json"
        if not report.exists():
            return "missing deck/defect-report.json"
        try:
            html_size = index.stat().st_size
            payload = json.loads(ir.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            return "unreadable or invalid deck.ir.json"
        if html_size < MIN_DECK_BYTES:
            return f"deck/index.html too small for Slide Studio production ({html_size}B < {MIN_DECK_BYTES}B)"
        deck = payload.get("deck") if isinstance(payload, dict) else None
        slides = deck.get("slides") if isinstance(deck, dict) else None
        if not isinstance(slides, list) or len(slides) < 10:
            return "deck.ir.json is not the Slide Studio scene-graph contract"
        for slide in slides:
            if isinstance(slide, dict) and (slide.get("bg") or "").lower() not in ("#ffffff", "#fff", "white"):
                return "deck slides are not explicitly white-background"
        try:
            report_doc = json.loads(report.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            return "invalid deck/defect-report.json"
        if report_doc.get("package") != "defect-driven-slide-studio":
            return "defect report was not produced by defect-driven-slide-studio"
        if int(report_doc.get("slide_count") or 0) < 10:
            return "defect report slide_count is too low"
        return None
    return None


def _handoff_artifacts_for(state_dir: Path, stage: str) -> list[dict]:
    root = state_dir / "productions" / stage
    if not (root / "RUN_WITH_HEP_NETWORK.md").exists():
        return []
    return [{
        "label": "Run specialist prompt",
        "href": f"/__studio/productions/{stage}/RUN_WITH_HEP_NETWORK.md",
        "kind": "source",
        "role": "source",
        "filename": "RUN_WITH_HEP_NETWORK.md",
    }]


def _production_artifacts_for(state_dir: Path, stage: str) -> list[dict]:
    root = state_dir / "productions" / stage
    out: list[dict] = []
    issue = _production_contract_issue(state_dir, stage)
    if issue:
        try:
            root.mkdir(parents=True, exist_ok=True)
            (root / "contract-blocked.txt").write_text(issue + "\n", "utf-8")
        except OSError:
            pass
        return _handoff_artifacts_for(state_dir, stage)
    if stage == "build":
        if (root / "index.html").exists():
            out.append({
                "label": "Open artifact",
                "href": "/__studio/productions/build/index.html",
                "kind": "html",
                "role": "primary",
                "filename": "index.html",
            })
        if (root / "qa-report.json").exists():
            out.append({
                "label": "QA report",
                "href": "/__studio/productions/build/qa-report.json",
                "kind": "report",
                "role": "qa",
                "filename": "qa-report.json",
            })
        if (root / "README.md").exists():
            out.append({
                "label": "README",
                "href": "/__studio/productions/build/README.md",
                "kind": "source",
                "role": "source",
                "filename": "README.md",
            })
    if stage == "deck":
        if (root / "index.html").exists():
            out.append({
                "label": "Open artifact",
                "href": "/__studio/productions/deck/index.html",
                "kind": "html",
                "role": "primary",
                "filename": "index.html",
            })
        if (root / "pitch-deck.pdf").exists():
            out.append({
                "label": "PDF preview",
                "href": "/__studio/productions/deck/pitch-deck.pdf",
                "kind": "pdf",
                "role": "primary" if not out else "download",
                "filename": "pitch-deck.pdf",
            })
        if (root / "pitch-deck.pptx").exists():
            out.append({
                "label": "Download PPTX",
                "href": "/__studio/productions/deck/pitch-deck.pptx",
                "kind": "pptx",
                "role": "download",
                "filename": "pitch-deck.pptx",
            })
        if (root / "deck.ir.json").exists():
            out.append({
                "label": "deck.ir.json",
                "href": "/__studio/productions/deck/deck.ir.json",
                "kind": "json",
                "role": "source",
                "filename": "deck.ir.json",
            })
        if (root / "defect-report.json").exists():
            out.append({
                "label": "Defect report",
                "href": "/__studio/productions/deck/defect-report.json",
                "kind": "report",
                "role": "qa",
                "filename": "defect-report.json",
            })
        if (root / "README.md").exists():
            out.append({
                "label": "README",
                "href": "/__studio/productions/deck/README.md",
                "kind": "source",
                "role": "source",
                "filename": "README.md",
            })
    return out


def _augment_production_artifacts(state_dir: Path, doc: dict) -> dict:
    if not isinstance(doc, dict):
        return doc
    for locale in ("en", "ko"):
        loc_stages = ((doc.get(locale) or {}).get("stages") or {})
        for stage in ("build", "deck"):
            artifacts = _production_artifacts_for(state_dir, stage)
            if artifacts and isinstance(loc_stages.get(stage), dict):
                existing = loc_stages[stage].get("artifacts")
                existing_list = existing if isinstance(existing, list) else []
                if not existing_list or not any(str(a.get("href", "")).startswith("/__studio/productions/") for a in existing_list if isinstance(a, dict)):
                    loc_stages[stage]["artifacts"] = artifacts
                elif any(str(a.get("href", "")).startswith("/__studio/productions/") for a in existing_list if isinstance(a, dict)):
                    loc_stages[stage]["artifacts"] = artifacts
            elif isinstance(loc_stages.get(stage), dict):
                existing = loc_stages[stage].get("artifacts")
                existing_list = existing if isinstance(existing, list) else []
                if any(str(a.get("href", "")).startswith("/__studio/productions/") for a in existing_list if isinstance(a, dict)):
                    loc_stages[stage]["artifacts"] = _handoff_artifacts_for(state_dir, stage)
    return doc


def _production_version(state_dir: Path) -> int:
    root = state_dir / "productions"
    if not root.exists():
        return 0
    latest = 0
    try:
        for path in root.rglob("*"):
            if path.is_file():
                latest = max(latest, path.stat().st_mtime_ns)
    except OSError:
        return latest
    return latest


def _clip(value, limit=84) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(12, limit - 1)].rstrip() + "…"


def _stage_obj(doc: dict, key: str) -> dict:
    stage = (((doc.get("en") or {}).get("stages") or {}).get(key))
    return stage if isinstance(stage, dict) else {}


def _spine(doc: dict) -> dict:
    spine = ((doc.get("en") or {}).get("ideaSpine") or {})
    return spine if isinstance(spine, dict) else {}


def _stage_points(stage: dict, fallback: list[str], limit=5) -> list[str]:
    out = []
    for item in stage.get("workItems") or []:
        if isinstance(item, dict):
            text = item.get("content") or item.get("title") or ""
            if text:
                out.append(_clip(text, 86))
    for item in stage.get("metrics") or []:
        if isinstance(item, dict):
            text = " ".join(str(x) for x in (item.get("label"), item.get("value")) if x)
            if text:
                out.append(_clip(text, 86))
    if not out:
        out = fallback[:]
    return (out + fallback)[:limit]


def _competitor_rows(market: dict) -> list[list[str]]:
    rows = []
    for c in market.get("competitors") or []:
        if not isinstance(c, dict):
            continue
        name = c.get("name") or c.get("player") or c.get("title") or "경쟁 옵션"
        kind = c.get("type") or c.get("category") or c.get("position") or "대체재"
        target = c.get("target") or c.get("segment") or c.get("customer") or "동일 고객"
        strength = c.get("strength") or c.get("pros") or c.get("advantage") or c.get("gap") or "기존 습관 보유"
        weakness = c.get("weakness") or c.get("cons") or c.get("risk") or "전문화 부족"
        rows.append([_clip(name, 18), _clip(kind, 14), _clip(target, 18), _clip(strength, 22), _clip(weakness, 22)])
    if rows:
        return rows[:8]
    return [
        ["엑셀/수기", "현상유지", "초기 고객", "무료·익숙함", "예측과 실행 연결 약함"],
        ["범용 SaaS", "간접경쟁", "운영팀", "기능 폭 넓음", "도메인 특화 부족"],
        ["대행/컨설턴트", "대체재", "고가 고객", "맞춤 대응", "반복 비용 높음"],
        ["ERP 모듈", "직접경쟁", "중견 이상", "데이터 연결", "도입 장벽 큼"],
        ["신규 AI 툴", "직접경쟁", "실험 고객", "속도 빠름", "신뢰 근거 부족"],
    ]


def _segments_from_doc(doc: dict) -> list[dict]:
    market = _stage_obj(doc, "market")
    personas = market.get("personas") if isinstance(market.get("personas"), list) else []
    labels = []
    for p in personas[:6]:
        if isinstance(p, dict):
            labels.append(_clip(p.get("name") or p.get("segment") or p.get("role") or "고객군", 14))
    if not labels:
        labels = ["초기 유료 고객", "반복 운영팀", "대표/창업자", "현장 매니저", "확장 고객", "파트너"]
    values = [28, 22, 17, 14, 11, 8]
    return [{"label": labels[i] if i < len(labels) else f"세그먼트 {i+1}", "value": values[i]} for i in range(6)]


def _build_startup_deck_outline(doc: dict) -> dict:
    spine = _spine(doc)
    idea = _clip(spine.get("oneLiner") or doc.get("name") or "새 스타트업", 66)
    product = _clip(doc.get("name") or idea.split(" ")[0] or "Startup", 22)
    customer = _clip(spine.get("customer") or "초기 고객", 28)
    problem = _clip(spine.get("problem") or "반복 운영 문제가 큼", 54)
    idea_stage = _stage_obj(doc, "idea")
    market = _stage_obj(doc, "market")
    business = _stage_obj(doc, "business")
    prd = _stage_obj(doc, "prd")
    market_head = _clip(market.get("headline") or "명확한 고객 문제와 지불 전환 가설이 확인된 시장", 74)
    business_head = _clip(business.get("headline") or "작게 시작해 반복 매출로 확장하는 사업 모델", 74)
    prd_head = _clip(prd.get("headline") or "첫 제품은 핵심 반복 업무를 줄이는 실행형 워크플로", 74)
    idea_points = _stage_points(idea_stage, [
        f"핵심 고객은 {customer}",
        f"가장 큰 통증은 {problem}",
        "초기 버전은 한 가지 반복 업무를 끝까지 줄이는 데 집중",
        "검증은 실제 운영 데이터와 지불 의사로 판단",
    ])
    market_points = _stage_points(market, [
        "직접 경쟁보다 현상유지와 수기 프로세스가 더 큰 대체재",
        "초기 시장은 좁게 잡고 반복 빈도 높은 고객부터 진입",
        "구매 전환은 데이터 연결과 결과 신뢰에서 갈림",
        "시장 메시지는 AI가 아니라 절약되는 업무와 손실로 설명",
    ])
    business_points = _stage_points(business, [
        "무료 진단 또는 파일럿으로 진입 후 유료 워크플로로 전환",
        "월 구독과 팀 확장으로 반복 매출 구조를 설계",
        "초기 비용은 데이터 정리와 고객 성공에 집중",
        "마일스톤은 파일럿 유지율, 전환율, 반복 사용률 중심",
    ])
    prd_points = _stage_points(prd, [
        "MVP는 입력, 추천, 확인, 실행 초안까지 한 흐름으로 구성",
        "핵심 화면은 오늘의 상태, 추천 이유, 실행 버튼 세 축",
        "오류·빈 상태·재시도 흐름을 제품 초기부터 포함",
        "사용자는 AI 설명보다 다음 행동의 근거를 먼저 봐야 함",
    ])
    rows = _competitor_rows(market)
    segments = _segments_from_doc(doc)
    source = "Source: Startup Studio board packet (idea, market, business, PRD stages), synthesized for internal IR draft"
    return {
        "meta": {
            "title": f"{product} IR Deck",
            "subtitle": f"{idea} — 투자자 검토용 초안",
            "audience": "초기 투자자 + 파일럿 파트너",
            "governing_thought": f"{product}는 {customer}의 '{problem}' 문제를 반복 워크플로 제품으로 줄여 초기 지불 전환을 검증한다.",
        },
        "slides": [
            {"n": 1, "archetype": "cover", "kicker": "INVESTOR BRIEF", "action_title": f"{idea}는 반복 운영 손실을 제품 워크플로로 줄이는 초기 기회", "key_message": f"{customer}가 이미 겪는 문제를 자동 추천과 실행 초안으로 연결한다.", "subtitle": f"{product} 피치덱 초안", "body_points": idea_points[:4], "big_stat": {"value": "1st", "label": "한 고객군의 반복 업무를 끝까지 줄이는 MVP 진입 전략", "context": "넓은 플랫폼보다 한 고객군의 반복 통증에 집중"}, "source_line": source},
            {"n": 2, "archetype": "toc", "kicker": "AGENDA", "action_title": "문제, 시장, 제품, 사업 모델, 요청 순서로 투자 논리를 전개", "key_message": "각 장은 Startup Studio의 앞 단계 산출물을 근거로 연결된다.", "body_points": ["01 문제와 고객: 누가 왜 지금 아픈가", "02 시장과 경쟁: 어디가 비어 있는가", "03 제품: 어떤 워크플로가 통증을 줄이는가", "04 사업 모델: 어떻게 반복 매출로 바뀌는가", "05 요청: 무엇을 검증하면 다음 라운드로 가는가"], "source_line": source},
            {"n": 3, "archetype": "section_divider", "kicker": "SECTION 01", "section": "01", "action_title": f"{customer}의 문제는 기능 부족이 아니라 반복 업무가 실행까지 이어지지 않는 데 있음", "key_message": problem},
            {"n": 4, "archetype": "big_stat", "kicker": "PROBLEM", "action_title": "초기 고객은 반복 판단 비용을 매주 지불", "key_message": "문제의 크기는 추상 AI 수요가 아니라 같은 결정을 반복하는 빈도에서 나온다.", "big_stat": {"value": "Weekly", "label": "반복 의사결정 주기", "context": "MVP는 매일 또는 매주 반복되는 결정을 자동화 대상으로 좁힌다"}, "source_line": source, "body_points": idea_points[:4]},
            {"n": 5, "archetype": "bars", "kicker": "MARKET PATH", "action_title": "초기 시장은 좁게 시작해 팀 사용으로 확장되는 단계적 경로", "key_message": "파일럿 고객에서 팀 단위 사용으로 확장되는 경로가 시장 진입의 핵심이다.", "chart": {"type": "column", "message": "time_series", "unit": "지수", "series": [{"label": "파일럿", "value": 20}, {"label": "초기 유료", "value": 45}, {"label": "팀 확장", "value": 75}, {"label": "파트너", "value": 100}], "caption": "시장 접근 단계별 확장 지수"}, "source_line": source, "body_points": market_points},
            {"n": 6, "archetype": "segmentation", "kicker": "SEGMENTATION", "action_title": "가장 먼저 살 고객은 문제 빈도와 지불 의사가 동시에 높은 세그먼트", "key_message": "초기 세그먼트는 전체 시장보다 전환 가능성과 반복 사용을 우선한다.", "segments": segments, "source_line": source, "body_points": market_points},
            {"n": 7, "archetype": "section_divider", "kicker": "SECTION 02", "section": "02", "action_title": "경쟁은 범용 AI가 아니라 기존 수기·대행·ERP 사이의 공백에서 발생", "key_message": market_head},
            {"n": 8, "archetype": "drivers_mece", "kicker": "WHY NOW", "action_title": "수요, 데이터, 실행 비용 세 축이 동시에 움직여 지금 진입 타이밍을 만듦", "key_message": "고객은 더 좋은 AI보다 더 적은 반복 업무와 더 빠른 실행을 산다.", "drivers": [{"label": "수요 압력", "sub": problem}, {"label": "데이터 가용성", "sub": "운영 기록과 업무 흔적이 제품 입력으로 전환 가능"}, {"label": "실행 비용 하락", "sub": "초안 생성과 추천 설명을 자동화해 도입 마찰 감소"}], "source_line": source, "body_points": market_points},
            {"n": 9, "archetype": "two_col_chart", "kicker": "CUSTOMER PAIN", "action_title": "고객 통증은 발견보다 반복 판단과 실행 누락에서 더 크게 발생", "key_message": "제품은 분석 보고서가 아니라 다음 행동을 밀어주는 운영 보조자가 되어야 한다.", "body_points": idea_points, "chart": {"type": "column", "message": "item", "unit": "통증 지수", "series": [{"label": "현황 파악", "value": 42}, {"label": "판단", "value": 68}, {"label": "실행", "value": 84}], "caption": "초기 고객 인터뷰 가설 기반 통증 분해"}, "source_line": source},
            {"n": 10, "archetype": "two_col_chart", "kicker": "SOLUTION", "action_title": f"{product}의 첫 제품은 추천 이유와 실행 초안을 한 화면에서 제공", "key_message": prd_head, "body_points": prd_points, "chart": {"type": "column", "message": "time_series", "unit": "완료율 지수", "series": [{"label": "수기", "value": 30}, {"label": "템플릿", "value": 52}, {"label": product, "value": 78}], "caption": "가설: 실행 초안 포함 시 완료율 상승"}, "source_line": source},
            {"n": 11, "archetype": "section_divider", "kicker": "SECTION 03", "section": "03", "action_title": "제품 전략은 넓은 자동화가 아니라 신뢰 가능한 한 가지 추천 루프를 완성하는 것", "key_message": prd_head},
            {"n": 12, "archetype": "table", "kicker": "COMPETITIVE LANDSCAPE", "action_title": "경쟁 옵션은 많지만 도메인 실행 루프는 비어 있는 공백", "key_message": "대체재는 많지만 고객의 다음 행동까지 좁게 책임지는 제품은 드물다.", "table": {"headers": ["플레이어", "유형", "타깃", "강점", "약점"], "rows": rows}, "source_line": source, "body_points": market_points},
            {"n": 13, "archetype": "matrix", "kicker": "POSITIONING", "action_title": "자동화 깊이와 쉬운 도입이 겹치는 진입 가능한 포지셔닝 공백", "key_message": "범용 도구는 쉽지만 얕고, 기존 시스템은 깊지만 무겁다.", "matrix": {"x_axis": ["도입 어려움", "도입 쉬움"], "y_axis": ["얕은 자동화", "깊은 실행 루프"], "quadrants": [{"label": "무거운 ERP"}, {"label": "범용 AI 챗봇"}, {"label": "컨설팅/대행"}, {"label": product}]}, "body_points": [f"좌상: 깊지만 무거운 기존 시스템", "우상: 쉽고 실행까지 이어지는 목표 구역", "좌하: 비용 높은 대행/수기", "우하: 쉽지만 얕은 범용 도구", f"진입 여백: {product}의 도메인 실행 루프"], "source_line": source},
            {"n": 14, "archetype": "statement", "kicker": "PRODUCT PRINCIPLE", "action_title": "고객은 AI 기능이 아니라 오늘 할 일을 줄여주는 결정 보조를 구매", "key_message": f"{product}의 차별점은 멋진 분석보다 근거 있는 다음 행동을 만들어 주는 데 있다.", "body_points": prd_points, "source_line": source, "big_stat": {"value": "Action", "label": "분석보다 실행", "context": "MVP 메시지의 중심"}},
            {"n": 15, "archetype": "section_divider", "kicker": "SECTION 04", "section": "04", "action_title": "사업 모델은 파일럿 진입 후 반복 사용과 팀 확장으로 매출화", "key_message": business_head},
            {"n": 16, "archetype": "big_stat", "kicker": "BUSINESS MODEL", "action_title": "초기 수익화는 진단·파일럿에서 월 구독으로 전환되는 구조", "key_message": business_head, "big_stat": {"value": "Pilot→MRR", "label": "전환 중심 수익 모델", "context": "초기 고객은 낮은 위험으로 시작하고 반복 가치가 확인되면 구독으로 이동"}, "source_line": source, "body_points": ["무료 진단 또는 파일럿으로 낮은 마찰 진입", "반복 가치 확인 후 월 구독 전환", "초기 비용은 데이터 정리와 고객 성공에 집중", "파일럿 유지율과 반복 사용률을 핵심 지표로 관리"]},
            {"n": 17, "archetype": "two_col_chart", "kicker": "MILESTONES", "action_title": "다음 라운드 전 핵심 증거는 반복 사용률과 유료 전환", "key_message": "투자 스토리의 핵심 증거는 예쁜 데모가 아니라 재방문과 지불이다.", "body_points": business_points, "chart": {"type": "column", "message": "item", "unit": "목표 지수", "series": [{"label": "파일럿", "value": 30}, {"label": "주간 사용", "value": 55}, {"label": "유료 전환", "value": 72}, {"label": "팀 확장", "value": 90}], "caption": "12개월 검증 마일스톤"}, "source_line": source},
            {"n": 18, "archetype": "comparison_columns", "kicker": "PRICING", "action_title": "무료 진단, Pro 구독, Team 확장으로 진입과 매출을 분리 설계", "key_message": "초기 가격은 마찰을 낮추고 반복 가치가 보인 뒤 팀 단위 매출로 확장한다.", "columns": [{"label": "Free 진단", "highlight": False, "points": ["문제 진단과 샘플 추천", "데이터 연결 전 가치 확인", "유료 전환 CTA"]}, {"label": "Pro 구독", "highlight": True, "points": ["개인 또는 소규모 운영자", "추천·초안·이력 관리", "월 반복 매출 중심"]}, {"label": "Team 확장", "highlight": False, "points": ["권한·공유·승인 흐름", "다중 지점/팀 관리", "NRR 확장 구간"]}], "source_line": source},
            {"n": 19, "archetype": "bars", "kicker": "FINANCIAL PATH", "action_title": "매출은 고객 수보다 반복 사용과 팀 확장률에 더 민감하게 반응", "key_message": "초기 재무 모델은 과장된 TAM보다 전환·사용·확장 지표를 중심으로 설계한다.", "chart": {"type": "column", "message": "time_series", "unit": "ARR 지수", "series": [{"label": "M1", "value": 10}, {"label": "M3", "value": 22}, {"label": "M6", "value": 44}, {"label": "M12", "value": 100}], "caption": "가설 기반 ARR 성장 지수"}, "source_line": source, "body_points": business_points},
            {"n": 20, "archetype": "closing", "kicker": "THE ASK", "action_title": "요청은 제품 완성보다 반복 사용과 유료 전환을 증명할 실험 자금", "key_message": f"{product}는 한 고객군의 반복 문제를 끝까지 해결하는 증거를 먼저 만든다.", "body_points": ["파일럿 고객군을 좁혀 6-8주 내 반복 사용 확인", "MVP에서 추천 근거와 실행 초안을 완성", "유료 전환과 팀 확장 지표를 다음 라운드 근거로 사용", "과장된 시장 주장보다 실제 사용 데이터를 우선"], "big_stat": {"value": "Next 90d", "label": "파일럿→유료 전환 검증", "context": "투자금은 제품-시장 증거를 빠르게 만드는 데 집중"}, "source_line": source},
        ],
    }


def _set_production_artifacts(doc: dict, stage: str, artifacts: list[dict]) -> None:
    handoff_only = bool(artifacts) and all(a.get("filename") == "RUN_WITH_HEP_NETWORK.md" for a in artifacts if isinstance(a, dict))
    for locale in ("en", "ko"):
        loc_stages = ((doc.get(locale) or {}).get("stages") or {})
        if isinstance(loc_stages.get(stage), dict):
            loc_stages[stage]["artifacts"] = artifacts
            verdict = loc_stages[stage].setdefault("verdict", {})
            if isinstance(verdict, dict):
                verdict["label"] = "전문가 실행 필요" if handoff_only else "생성됨"
                verdict["tone"] = "warning" if handoff_only else "positive"


def _write_production_handoff(state_dir: Path, stage: str, doc: dict, reason: str) -> list[dict]:
    target = state_dir / "productions" / stage
    target.mkdir(parents=True, exist_ok=True)
    spine = _spine(doc)
    idea = spine.get("oneLiner") or doc.get("name") or "startup idea"
    task = "IR/PPT deck" if stage == "deck" else "Web_master app build"
    prompt = (
        f"# Specialist production handoff\n\n"
        f"Reason: {reason}\n\n"
        f"Run this in a CLI or Agentlas app that has full Hub bundle execution enabled:\n\n"
        f"```text\n/hep-network {task} 만들어줘. Startup Studio 기획안 기준으로 실제 production artifact를 지정 폴더에 생성해줘.\n"
        f"아이디어: {idea}\n"
        f"입력 자료: .studio-runtime/studio-data.json\n"
        f"출력 폴더: .studio-runtime/productions/{stage}\n"
        f"계약: {'defect-driven-slide-studio renderer로 deck.ir.json, index.html, defect-report.json, pitch-deck.pptx 생성' if stage == 'deck' else 'Web_master 품질 게이트로 index.html, README.md, qa-report.json 생성'}\n"
        f"```\n"
    )
    (target / "RUN_WITH_HEP_NETWORK.md").write_text(prompt, "utf-8")
    (target / "contract-blocked.txt").write_text(reason + "\n", "utf-8")
    return _handoff_artifacts_for(state_dir, stage)


def _produce_deck_with_local_slide_studio(root: Path, state_dir: Path, doc: dict, next_path: Path) -> tuple[bool, str]:
    slide_root = _local_package_path(root, "deck")
    if not slide_root:
        return False, "local defect-driven-slide-studio package not found"
    example = slide_root / "examples" / "ai-slide-market-deck"
    build_ir = example / "build_ir.py"
    render_html = example / "render_html.py"
    build_pptx = example / "build_pptx.py"
    registry = slide_root / "detectors" / "registry.py"
    if not (build_ir.exists() and render_html.exists() and build_pptx.exists() and registry.exists()):
        return False, "local Slide Studio renderer scripts are incomplete"
    target = state_dir / "productions" / "deck"
    target.mkdir(parents=True, exist_ok=True)
    for name in ("outline.json", "deck.ir.json", "index.html", "defect-report.json", "pitch-deck.pptx", "README.md"):
        try:
            (target / name).unlink()
        except OSError:
            pass
    outline = _build_startup_deck_outline(doc)
    (target / "outline.json").write_text(json.dumps(outline, ensure_ascii=False, indent=2), "utf-8")
    py = shutil.which("python3") or "python3"

    def run(args: list[str], timeout=180) -> subprocess.CompletedProcess:
        return subprocess.run(args, cwd=str(target), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)

    r1 = run([py, str(build_ir), str(target / "outline.json"), str(target / "deck.ir.json")])
    if r1.returncode != 0:
        return False, "build_ir.py failed: " + (r1.stdout or "")[-300:]
    r2 = run([py, str(registry), str(target / "deck.ir.json"), "--profile", "consulting"])
    if r2.returncode == 0 and (r2.stdout or "").strip():
        (target / "defect-report.json").write_text(r2.stdout, "utf-8")
    else:
        fallback_report = {
            "package": "defect-driven-slide-studio",
            "profile": "consulting",
            "slide_count": len(outline["slides"]),
            "defect_count": None,
            "note": "registry failed or returned no output",
            "stdout": (r2.stdout or "")[-800:],
        }
        (target / "defect-report.json").write_text(json.dumps(fallback_report, ensure_ascii=False, indent=2), "utf-8")
    r3 = run([py, str(render_html), str(target / "deck.ir.json"), str(target / "index.html")])
    if r3.returncode != 0:
        return False, "render_html.py failed: " + (r3.stdout or "")[-300:]
    r4 = run([py, str(build_pptx), str(target / "deck.ir.json"), str(target / "pitch-deck.pptx")], timeout=240)
    pptx_note = "PPTX generated." if r4.returncode == 0 else "PPTX generation failed; HTML and IR are still present. " + (r4.stdout or "")[-300:]
    readme = (
        "# Startup Studio IR deck\n\n"
        "Generated by the local defect-driven-slide-studio renderer pipeline:\n\n"
        "1. build_ir.py outline.json deck.ir.json\n"
        "2. detectors/registry.py deck.ir.json --profile consulting\n"
        "3. render_html.py deck.ir.json index.html\n"
        "4. build_pptx.py deck.ir.json pitch-deck.pptx\n\n"
        f"{pptx_note}\n"
    )
    (target / "README.md").write_text(readme, "utf-8")
    artifacts = _production_artifacts_for(state_dir, "deck")
    if not artifacts or not any(a.get("role") == "primary" for a in artifacts):
        issue = _production_contract_issue(state_dir, "deck") or "deck production contract did not expose primary artifact"
        _write_production_handoff(state_dir, "deck", doc, issue)
        return False, issue
    next_doc = json.loads(json.dumps(doc, ensure_ascii=False))
    _set_production_artifacts(next_doc, "deck", artifacts)
    bump = ((next_doc.get("_meta") or {}).get("bump") or 0)
    next_doc.setdefault("_meta", {})["bump"] = bump + 1
    next_path.write_text(json.dumps(next_doc, ensure_ascii=False, indent=2), "utf-8")
    return True, "local Slide Studio renderer pipeline completed"


def _runner_cmd(prompt: str) -> list[str] | None:
    """The argv to run the founder's own local CLI headlessly.

    STUDIO_RUNNER_CLI forces one. Otherwise, prefer Codex when the bridge was
    launched from Codex; fall back to Claude first for non-Codex hosts.
    Returns None when neither CLI is installed.
    """
    choice = os.environ.get("STUDIO_RUNNER_CLI", "").strip()
    # Escape hatch: STUDIO_RUNNER_CLI may name any other generator executable
    # (on PATH or an absolute path). It is invoked as `<exe> <prompt>` and must
    # write .studio-runtime/studio-data.next.json. Lets a consumer point the
    # runner at a different model/CLI without touching this file.
    if choice and choice.lower() not in ("claude", "codex"):
        custom = shutil.which(choice) or (choice if os.path.exists(choice) else None)
        if custom:
            return [custom, prompt]
    choice = choice.lower()
    claude = shutil.which("claude")
    codex = shutil.which("codex")

    def claude_cmd(path: str) -> list[str]:
        # -p = headless print mode; acceptEdits + allowedTools so it can Read the
        # schema and Write the file with no interactive prompt (and never hang).
        return [
            path, "-p", prompt,
            "--permission-mode", "acceptEdits",
            "--allowedTools", "Read Edit Write Glob Grep",
        ]

    def codex_cmd(path: str) -> list[str]:
        # exec = non-interactive. We deliberately DO NOT use
        # --dangerously-bypass-approvals-and-sandbox: queued prompts are an
        # external input path, so the generator must stay sandboxed. workspace-write
        # lets it write the studio-data.next.json under cwd (self.root) while
        # blocking arbitrary filesystem/network/shell escape; approvals are
        # auto-denied so it still runs unattended without hanging.
        return [path, "exec", "--sandbox", "workspace-write",
                "--ask-for-approval", "never",
                "--skip-git-repo-check", prompt]

    builders = {"claude": (claude, claude_cmd), "codex": (codex, codex_cmd)}

    # Explicit STUDIO_RUNNER_CLI=claude|codex always wins.
    if choice in builders and builders[choice][0]:
        path, build = builders[choice]
        return build(path)

    # Otherwise spawn the SAME runtime that launched this launcher. The launcher
    # is Popen'd by the host (Claude Code or Codex) and inherits its env, so the
    # env tells us which subscription session is actually driving. Spawning the
    # OTHER CLI is the bug the user hit: opened from Codex, runner picked Claude.
    # BYOK = the founder's *active* session is the runtime — match it.
    #   Codex host : CODEX_THREAD_ID / CODEX_SANDBOX / CODEX_CI
    #   Claude host: CLAUDECODE=1 / CLAUDE_CODE_ENTRYPOINT
    # NOTE: CODEX_COMPANION_SESSION_ID is the Claude-side codex *plugin*, NOT a
    # Codex host — never treat it as a Codex marker.
    codex_host = any(os.environ.get(k) for k in ("CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_CI"))
    claude_host = os.environ.get("CLAUDECODE") == "1" or bool(os.environ.get("CLAUDE_CODE_ENTRYPOINT"))
    order = ["codex", "claude"] if (codex_host and not claude_host) else ["claude", "codex"]

    for name in order:
        path, build = builders[name]
        if path:
            return build(path)
    return None


class StudioRunner:
    """Polls requests.jsonl and fulfills each queued request by spawning the
    user's local CLI to generate studio-data.json. Serialized (one at a time),
    daemon thread. Disable with STUDIO_AUTORUN=0 (falls back to a session
    manually watching the queue)."""

    def __init__(self, root: Path, state_dir: Path):
        self.root = root
        self.state_dir = state_dir
        self.req_path = state_dir / "requests.jsonl"
        self.data_path = state_dir / DATA_NAME
        self.next_path = state_dir / NEXT_NAME
        self.busy_path = state_dir / BUSY_NAME
        self.log_path = state_dir / LOG_NAME
        self.pid_path = state_dir / RUNNER_PID_NAME
        self._cursor = self._line_count()  # skip stale pre-launch requests

    def _line_count(self) -> int:
        try:
            with self.req_path.open("r", encoding="utf-8") as fh:
                return sum(1 for _ in fh)
        except FileNotFoundError:
            return 0

    def _log(self, msg: str) -> None:
        try:
            with self.log_path.open("a", encoding="utf-8") as fh:
                fh.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        except OSError:
            pass

    def start(self) -> "StudioRunner":
        # Clear any stale busy flag from a crashed prior run.
        try:
            self.busy_path.unlink()
        except OSError:
            pass
        if os.environ.get("STUDIO_AUTORUN", "1").strip() == "0":
            self._log("autorun disabled (STUDIO_AUTORUN=0) — session must fulfill the queue manually")
            return self
        if self._another_runner_alive():
            return self
        probe = _runner_cmd("probe")
        if probe is None:
            self._log("no local CLI (claude/codex) on PATH — auto-generation OFF; install one or set STUDIO_RUNNER_CLI")
            return self
        try:
            self.pid_path.write_text(str(os.getpid()), "utf-8")
        except OSError:
            pass
        threading.Thread(target=self._loop, name="studio-runner", daemon=True).start()
        cli = Path(probe[0]).name
        override = os.environ.get("STUDIO_RUNNER_CLI", "").strip() or "host-detected"
        self._log(f"runner started — watching requests.jsonl (CLI: {cli}, selection: {override})")
        return self

    def _another_runner_alive(self) -> bool:
        try:
            pid = int((self.pid_path.read_text("utf-8") or "").strip())
        except (OSError, ValueError):
            return False
        if pid == os.getpid():
            return False
        try:
            os.kill(pid, 0)
        except OSError:
            try:
                self.pid_path.unlink()
            except OSError:
                pass
            return False
        self._log(f"runner already active in pid {pid}; this server will serve GUI only")
        return True

    def _loop(self) -> None:
        while True:
            try:
                new = self._drain()
                for req in new:
                    self._fulfill(req)
            except Exception as exc:  # never let the worker die
                self._log(f"loop error: {exc!r}")
            time.sleep(0.8)

    def _drain(self) -> list[dict]:
        """Return request dicts queued since the cursor; advance the cursor."""
        try:
            lines = self.req_path.read_text("utf-8").splitlines()
        except FileNotFoundError:
            return []
        if len(lines) <= self._cursor:
            return []
        fresh = lines[self._cursor:]
        self._cursor = len(lines)
        out = []
        for ln in fresh:
            ln = ln.strip()
            if not ln:
                continue
            try:
                obj = json.loads(ln)
                if isinstance(obj, dict):
                    out.append(obj)
            except json.JSONDecodeError:
                continue
        return out

    def _fulfill(self, req: dict) -> None:
        # Credits gate: the session fee is charged on GUI open. If the balance was
        # insufficient there, generation is OFF (the GUI shows the notice). Within a
        # paid session this is always sufficient — no per-request charge ever.
        cs = credit_state(self.state_dir)
        if cs.get("enabled") and not cs.get("sufficient", True):
            self._log(f"credits insufficient (balance {cs.get('balance')}, need {cs.get('cost')}) — generation gated; skipped {req.get('kind')}")
            return
        kind = req.get("kind") or ("run" if req.get("stage") else None)
        if kind == "init":
            idea = str(req.get("idea") or "").strip()
            if not idea:
                self._log("init with empty idea — skipped")
                return
            slug = STAGE_SLUG["idea"]
            bundle = _hep_call(slug, idea, str(self.root))
            self._log(f"init: hep-call {slug} -> {'bundle_ready' if bundle else 'unavailable'}")
            if bundle is None:
                self._log("init skipped: Hub bundle unavailable and local operator fallback is off")
                return
            prompt = build_init_prompt(idea, bundle)
            label = f"init idea={idea[:48]!r}"
        elif kind == "run":
            stage = str(req.get("stage") or "").strip()
            if stage not in ("idea", "market", "business", "prd", "build", "deck"):
                self._log(f"run with bad stage {stage!r} — skipped")
                return
            if not self.data_path.exists():
                self._log(f"run {stage} but no board yet — skipped")
                return
            slug = STAGE_SLUG[stage]
            ctx = ""
            try:
                doc = json.loads(self.data_path.read_text("utf-8"))
                ctx = ((doc.get("en") or {}).get("ideaSpine") or {}).get("oneLiner", "")
            except (json.JSONDecodeError, OSError):
                pass
            bundle = _hep_call(slug, f"{stage} stage for: {ctx}", str(self.root))
            self._log(f"run {stage}: hep-call {slug} -> {'bundle_ready' if bundle else 'unavailable'}")
            if bundle is None:
                self._log(f"run {stage} skipped: Hub bundle unavailable and local operator fallback is off")
                return
            prompt = build_run_prompt(stage, bundle, req)
            label = f"run stage={stage}"
        elif kind == "produce":
            stage = str(req.get("stage") or "").strip()
            if stage not in ("build", "deck"):
                self._log(f"produce with bad stage {stage!r} — skipped")
                return
            if not self.data_path.exists():
                self._log(f"produce {stage} but no board yet — skipped")
                return
            slug = STAGE_SLUG[stage]
            ctx = ""
            doc = None
            try:
                doc = json.loads(self.data_path.read_text("utf-8"))
                ctx = ((doc.get("en") or {}).get("ideaSpine") or {}).get("oneLiner", "")
            except (json.JSONDecodeError, OSError):
                pass
            if not isinstance(doc, dict):
                self._log(f"produce {stage}: current board is unreadable — skipped")
                return

            if stage == "deck" and _local_production_allowed(self.root, "deck"):
                label = "produce stage=deck local-slide-studio"
                started_at = time.time()
                self.busy_path.write_text(label, encoding="utf-8")
                try:
                    ok, msg = _produce_deck_with_local_slide_studio(self.root, self.state_dir, doc, self.next_path)
                    self._log(f"{label}: {msg}")
                except Exception as exc:
                    ok = False
                    self._log(f"{label}: failed {exc!r}")
                finally:
                    if ok:
                        self._commit(label, started_at)
                    try:
                        self.busy_path.unlink()
                    except OSError:
                        pass
                return

            local_bundle = _local_hq_bundle(slug, str(self.root)) if _local_production_allowed(self.root, stage) else None
            bundle = local_bundle or _hep_call(slug, f"specialist production {stage} for: {ctx}", str(self.root))
            self._log(f"produce {stage}: hep-call {slug} -> {'bundle_ready' if bundle else 'unavailable'}")
            if bundle is None:
                reason = "Hub bundle unavailable and no full local production package is available"
                artifacts = _write_production_handoff(self.state_dir, stage, doc, reason)
                if artifacts:
                    label = f"produce stage={stage} handoff"
                    next_doc = json.loads(json.dumps(doc, ensure_ascii=False))
                    _set_production_artifacts(next_doc, stage, artifacts)
                    next_doc.setdefault("_meta", {})["bump"] = ((next_doc.get("_meta") or {}).get("bump") or 0) + 1
                    self.next_path.write_text(json.dumps(next_doc, ensure_ascii=False, indent=2), "utf-8")
                    self._commit(label, time.time())
                self._log(f"produce {stage} skipped: {reason}")
                return
            if not bundle.get("full_package") and int(bundle.get("entry_excerpt_len") or 0) < 2500:
                reason = f"Hub returned only a short {bundle.get('entry_excerpt_len') or 0}-character runtime excerpt; refusing to fake {stage} production"
                artifacts = _write_production_handoff(self.state_dir, stage, doc, reason)
                label = f"produce stage={stage} handoff"
                next_doc = json.loads(json.dumps(doc, ensure_ascii=False))
                _set_production_artifacts(next_doc, stage, artifacts)
                next_doc.setdefault("_meta", {})["bump"] = ((next_doc.get("_meta") or {}).get("bump") or 0) + 1
                self.next_path.write_text(json.dumps(next_doc, ensure_ascii=False, indent=2), "utf-8")
                self._commit(label, time.time())
                self._log(f"produce {stage} handoff: {reason}")
                return
            prompt = build_production_prompt(stage, bundle, req)
            label = f"produce stage={stage}"
        else:
            self._log(f"unknown request kind {kind!r} — skipped")
            return

        cmd = _runner_cmd(prompt)
        if cmd is None:
            self._log(f"{label}: no CLI available")
            return

        # Fresh target each time so a stale .next can't be mistaken for success.
        try:
            self.next_path.unlink()
        except OSError:
            pass

        self.busy_path.write_text(label, encoding="utf-8")
        self._log(f"{label}: spawning {Path(cmd[0]).name} …")
        t0 = time.time()
        started_at = t0
        committed = False
        try:
            cli_log = self.state_dir / "runner-cli.log"
            with cli_log.open("a", encoding="utf-8") as out:
                out.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} {label} ---\n")
                out.flush()
                proc = subprocess.Popen(
                    cmd, cwd=str(self.root),
                    stdout=out, stderr=subprocess.STDOUT,
                    text=True,
                )
                stable_key = None
                stable_since = 0.0
                while True:
                    rc = proc.poll()
                    now = time.time()
                    if self.next_path.exists():
                        try:
                            st = self.next_path.stat()
                            key = (st.st_size, st.st_mtime_ns)
                        except OSError:
                            key = None
                        if key and key == stable_key:
                            if now - stable_since >= 1.2:
                                ok, why = self._next_promotable()
                                if ok:
                                    self._log(f"{label}: .next.json ready before CLI exit; committing now")
                                    committed = self._commit(label, started_at)
                                    if proc.poll() is None:
                                        proc.terminate()
                                        try:
                                            proc.wait(timeout=5)
                                        except subprocess.TimeoutExpired:
                                            proc.kill()
                                            proc.wait(timeout=5)
                                    break
                                if rc is not None:
                                    self._log(f"{label}: .next.json not promotable after CLI exit ({why})")
                        else:
                            stable_key = key
                            stable_since = now
                    if rc is not None:
                        break
                    if now - t0 > 900:
                        self._log(f"{label}: CLI timed out after 900s")
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=5)
                        break
                    time.sleep(0.5)
                dt = time.time() - t0
                if proc.returncode not in (0, None) and not committed:
                    tail = ""
                    try:
                        tail = cli_log.read_text("utf-8")[-500:]
                    except OSError:
                        pass
                    self._log(f"{label}: CLI exit {proc.returncode} in {dt:.0f}s — {tail!r}")
        except subprocess.TimeoutExpired:
            self._log(f"{label}: CLI timed out after 900s")
        except OSError as exc:
            self._log(f"{label}: spawn failed {exc!r}")
        finally:
            if not committed:
                self._commit(label, started_at)
            try:
                self.busy_path.unlink()
            except OSError:
                pass

    def _next_promotable(self) -> tuple[bool, str]:
        try:
            doc = json.loads(self.next_path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            return False, f"invalid .next.json ({exc!r})"
        ok, why = self._validate(doc)
        if not ok:
            return False, why
        leak = self._leak(doc)
        if leak:
            return False, f"sample LEAK ({leak!r})"
        return True, "ok"

    def _commit(self, label: str, started_at: float) -> bool:
        """Validate the CLI's output and atomically promote it to the live file.
        The live studio-data.json is NEVER half-written: bad output is dropped."""
        if not self.next_path.exists():
            self._log(f"{label}: no .next.json produced (nothing committed)")
            return False
        try:
            doc = json.loads(self.next_path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            self._log(f"{label}: invalid .next.json ({exc!r}) — dropped")
            self._safe_unlink(self.next_path)
            return False
        ok, why = self._validate(doc)
        if not ok:
            self._log(f"{label}: validation failed ({why}) — dropped")
            self._safe_unlink(self.next_path)
            return False
        leak = self._leak(doc)
        if leak:
            self._log(f"{label}: sample LEAK ({leak!r}) in output — dropped (will regenerate)")
            self._safe_unlink(self.next_path)
            return False
        try:
            _materialize_native_artifacts(self.state_dir, doc, started_at)
            self.next_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), "utf-8")
            os.replace(self.next_path, self.data_path)  # atomic same-dir rename
            self._log(f"{label}: committed -> {DATA_NAME} (GUI will re-render)")
            return True
        except OSError as exc:
            self._log(f"{label}: commit failed {exc!r}")
            return False

    @staticmethod
    def _validate(doc) -> tuple[bool, str]:
        if not isinstance(doc, dict):
            return False, "not an object"
        en = doc.get("en")
        if not isinstance(en, dict):
            return False, "missing en"
        spine = en.get("ideaSpine")
        if not isinstance(spine, dict) or not str(spine.get("oneLiner") or "").strip():
            return False, "missing ideaSpine.oneLiner"
        stages = en.get("stages")
        if not isinstance(stages, dict):
            return False, "missing stages"
        for k in ("idea", "market", "business", "prd", "build", "deck"):
            if k not in stages:
                return False, f"missing stage {k}"
        return True, "ok"

    @staticmethod
    def _leak(doc) -> str | None:
        """Return a leaked sample app name if the output contains one that is NOT
        part of the founder's own idea — guards the salon-sample leak at commit."""
        try:
            idea = ((doc.get("en") or {}).get("ideaSpine") or {}).get("oneLiner", "") or ""
            blob = json.dumps(doc, ensure_ascii=False)
        except (TypeError, ValueError):
            return None
        for tok in SAMPLE_TOKENS:
            if tok in blob and tok not in idea:
                return tok
        return None

    @staticmethod
    def _safe_unlink(p: Path) -> None:
        try:
            p.unlink()
        except OSError:
            pass


def _runner_busy(state_dir: Path) -> bool:
    return (state_dir / BUSY_NAME).exists()


def _runner_ready(state_dir: Path) -> bool:
    try:
        pid = int(((state_dir / RUNNER_PID_NAME).read_text("utf-8") or "").strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def make_bridge_handler(dist_dir: Path, state_dir: Path):
    """Serve the SPA AND the dev-bridge the GUI speaks in local mode:
      GET  /studio-data.json   -> the live content (working copy, no-store)
      GET  /__studio/manifest  -> { data:<mtime-ns version>, idea }
      POST /__studio/request   -> append {kind,stage,idea} to requests.jsonl
    No LLM here. A Claude Code session (the user's own subscription model) polls
    requests.jsonl and writes studio-data.json — that bump re-renders the GUI.
    """
    data_path = state_dir / "studio-data.json"
    req_path = state_dir / "requests.jsonl"
    artifact_root = (state_dir / "artifacts").resolve()
    production_root = (state_dir / "productions").resolve()
    # Start BLANK — never seed the bundled sample as the working copy, so its
    # content can never leak into a real idea. /studio-data.json serves "{}" until
    # the session writes real content, so the GUI shows its "enter your idea" hero.
    # (The bundled web/dist/studio-data.json stays as a reference sample only.)

    class BridgeHandler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(dist_dir), **k)

        def _send_json(self, code: int, obj) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/studio-data.json":
                raw = b"{}"
                if data_path.exists():
                    try:
                        doc = json.loads(data_path.read_text("utf-8"))
                        doc = _augment_production_artifacts(state_dir, doc)
                        raw = json.dumps(doc, ensure_ascii=False).encode("utf-8")
                    except Exception:
                        raw = data_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)
                return
            if path == "/__studio/manifest":
                version, idea = 0, ""
                try:
                    version = data_path.stat().st_mtime_ns
                    version = max(version, _production_version(state_dir))
                    doc = json.loads(data_path.read_text("utf-8"))
                    idea = ((doc.get("en") or {}).get("ideaSpine") or {}).get("oneLiner", "")
                except Exception:
                    pass
                self._send_json(200, {"data": version, "idea": idea, "busy": _runner_busy(state_dir), "credits": credit_state(state_dir)})
                return
            if path.startswith("/__studio/artifacts/"):
                rel = unquote(path[len("/__studio/artifacts/"):]).lstrip("/")
                target = (artifact_root / rel).resolve()
                try:
                    target.relative_to(artifact_root)
                except ValueError:
                    self.send_error(403)
                    return
                if not target.is_file():
                    self.send_error(404)
                    return
                raw = target.read_bytes()
                ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                if ctype.startswith("text/html"):
                    self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
                if ctype == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
                    self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
                self.end_headers()
                self.wfile.write(raw)
                return
            if path.startswith("/__studio/productions/"):
                rel = unquote(path[len("/__studio/productions/"):]).lstrip("/")
                target = (production_root / rel).resolve()
                try:
                    target.relative_to(production_root)
                except ValueError:
                    self.send_error(403)
                    return
                if not target.is_file():
                    self.send_error(404)
                    return
                raw = target.read_bytes()
                ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                if ctype == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
                    self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
                self.end_headers()
                self.wfile.write(raw)
                return
            # SPA fallback: unknown non-asset client routes -> index.html
            fs = dist_dir / path.lstrip("/")
            leaf = path.rsplit("/", 1)[-1]
            serves_index = path in ("/", "") or (
                path not in ("/", "") and not fs.exists() and not path.startswith("/assets") and "." not in leaf
            )
            if path not in ("/", "") and not fs.exists() and not path.startswith("/assets") and "." not in leaf:
                self.path = "/index.html"
            # Hand the per-session token to the same-origin SPA via a cookie so its
            # fetch() auto-attaches it; cross-site CSRF is independently blocked by
            # the Origin check, so the auto-attached cookie cannot be abused.
            if serves_index and _REQUEST_TOKEN:
                self._studio_set_cookie = True
            return super().do_GET()

        def end_headers(self):  # noqa: N802
            if getattr(self, "_studio_set_cookie", False):
                self.send_header(
                    "Set-Cookie",
                    f"studio_token={_REQUEST_TOKEN}; Path=/; SameSite=Strict; HttpOnly",
                )
                self._studio_set_cookie = False
            super().end_headers()

        def do_POST(self):  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/__studio/request":
                ok, _reason = studio_request_authorized(self, self.server.server_address[1])
                if not ok:
                    self._send_json(403, {"ok": False, "queued": False, "error": "forbidden"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                if not isinstance(payload, dict):
                    payload = {}
                kind = str(payload.get("kind") or "").strip()
                if kind in ("init", "run", "produce") and not _runner_ready(state_dir):
                    self._send_json(
                        503,
                        {
                            "ok": False,
                            "queued": False,
                            "error": "Studio runner is not active. Restart Hephaestus/Startup Studio and try again.",
                        },
                    )
                    return
                payload.setdefault("ts", time.time())
                with req_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self._send_json(200, {"ok": True, "queued": True})
                return
            self.send_error(404)

        def log_message(self, *args):  # silence per-request logging
            return

    return BridgeHandler


def serve_dir(directory: Path, port: int, open_browser: bool) -> int:
    root = Path(__file__).resolve().parents[1]
    state_dir = studio_state_dir(root)
    cs = charge_session(state_dir)  # ONE flat fee per session on GUI open (free within)
    StudioRunner(root, state_dir).start()  # bridge IS the runtime: queue -> CLI -> studio-data.json
    handler = make_bridge_handler(directory, state_dir)
    return _serve(handler, port, open_browser, {"dir": str(directory), "bridge": str(state_dir), "credits": cs})


def serve_embedded(port: int, open_browser: bool) -> int:
    # The embedded GUI is the python3-only fallback when no built SPA exists. It is
    # the SAME session-runtime app (new design): it speaks the dev bridge, so a
    # fresh install with no node still gets the real "enter your idea → session
    # generates → render" flow — never a stale legacy page.
    root = Path(__file__).resolve().parents[1]
    state_dir = studio_state_dir(root)
    charge_session(state_dir)  # ONE flat fee per session on GUI open (free within)
    StudioRunner(root, state_dir).start()  # bridge IS the runtime: queue -> CLI -> studio-data.json
    data_path = state_dir / "studio-data.json"
    req_path = state_dir / "requests.jsonl"
    artifact_root = (state_dir / "artifacts").resolve()
    production_root = (state_dir / "productions").resolve()
    html_bytes = EMBEDDED_GUI_HTML.encode("utf-8")

    class EmbeddedHandler(BaseHTTPRequestHandler):
        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 (http.server API)
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html_bytes)))
                self.end_headers()
                self.wfile.write(html_bytes)
                return
            if path == "/studio-data.json":
                raw = b"{}"
                if data_path.exists():
                    try:
                        doc = json.loads(data_path.read_text("utf-8"))
                        doc = _augment_production_artifacts(state_dir, doc)
                        raw = json.dumps(doc, ensure_ascii=False).encode("utf-8")
                    except Exception:
                        raw = data_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)
                return
            if path == "/__studio/manifest":
                version, idea = 0, ""
                try:
                    version = data_path.stat().st_mtime_ns
                    version = max(version, _production_version(state_dir))
                    doc = json.loads(data_path.read_text("utf-8"))
                    idea = ((doc.get("en") or {}).get("ideaSpine") or {}).get("oneLiner", "")
                except Exception:
                    pass
                self._json(200, {"data": version, "idea": idea, "busy": _runner_busy(state_dir), "credits": credit_state(state_dir)})
                return
            if path.startswith("/__studio/artifacts/"):
                rel = unquote(path[len("/__studio/artifacts/"):]).lstrip("/")
                target = (artifact_root / rel).resolve()
                try:
                    target.relative_to(artifact_root)
                except ValueError:
                    self.send_error(403)
                    return
                if not target.is_file():
                    self.send_error(404)
                    return
                raw = target.read_bytes()
                ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                if ctype == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
                    self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
                self.end_headers()
                self.wfile.write(raw)
                return
            if path.startswith("/__studio/productions/"):
                rel = unquote(path[len("/__studio/productions/"):]).lstrip("/")
                target = (production_root / rel).resolve()
                try:
                    target.relative_to(production_root)
                except ValueError:
                    self.send_error(403)
                    return
                if not target.is_file():
                    self.send_error(404)
                    return
                raw = target.read_bytes()
                ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                if ctype == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
                    self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
                self.end_headers()
                self.wfile.write(raw)
                return
            self.send_error(404)

        def do_POST(self):  # noqa: N802
            if self.path.split("?", 1)[0] == "/__studio/request":
                ok, _reason = studio_request_authorized(self, self.server.server_address[1])
                if not ok:
                    self._json(403, {"ok": False, "queued": False, "error": "forbidden"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                if not isinstance(payload, dict):
                    payload = {}
                kind = str(payload.get("kind") or "").strip()
                if kind in ("init", "run", "produce") and not _runner_ready(state_dir):
                    self._json(
                        503,
                        {
                            "ok": False,
                            "queued": False,
                            "error": "Studio runner is not active. Restart Hephaestus/Startup Studio and try again.",
                        },
                    )
                    return
                payload.setdefault("ts", time.time())
                with req_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self._json(200, {"ok": True, "queued": True})
                return
            self.send_error(404)

        def log_message(self, *args):  # silence per-request logging
            return

    return _serve(EmbeddedHandler, port, open_browser, {"mode": "embedded", "bridge": str(state_dir)})


def _serve(handler, port: int, open_browser: bool, extra: dict) -> int:
    port = find_port(port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/"
    print(
        json.dumps(
            {"status": "serving", "url": url, "command_hint": "/startup", **extra},
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
    return 0


def resolve_tier(root: Path, prefer_static: bool, embedded: bool, build: bool):
    """Decide which tier to use. Returns (tier_name, payload_path_or_None)."""
    dist = root / "web" / "dist"

    if embedded:
        return "unavailable", "embedded fallback is disabled for Startup Studio quality control"
    if not prefer_static:
        # Prefer the already-built SPA — serve it instantly, no rebuild.
        if (dist / "index.html").exists():
            return "spa", dist
        # No dist yet: build it on demand (needs node/npm).
        if build and ensure_build(root / "web", dist):
            return "spa", dist
    return "unavailable", "Startup Studio SPA is unavailable; fallback is disabled. Install Node/npm or run `cd web && npm install && npm run build`."


def main() -> int:
    parser = argparse.ArgumentParser(description="Open Startup Studio GUI (always)")
    parser.add_argument("--no-open", action="store_true", help="Serve but do not open a browser")
    parser.add_argument("--no-serve", action="store_true", help="Print the chosen tier only")
    parser.add_argument("--port", type=int, default=4173, help="Preferred localhost port")
    parser.add_argument("--prefer-static", action="store_true", help="Probe only already-built SPA; no static/embedded fallback")
    parser.add_argument("--embedded", action="store_true", help="Disabled: Startup Studio does not serve embedded fallback UI")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]

    # Idempotent: if a Studio is already serving the preferred port, reuse it
    # (just reopen the browser) instead of spawning a second server.
    if not args.no_serve:
        existing = studio_already_serving(args.port)
        if existing:
            print(
                json.dumps(
                    {"status": "reused", "url": existing, "command_hint": "/startup"},
                    ensure_ascii=False,
                    indent=2,
                ),
                flush=True,
            )
            if not args.no_open:
                webbrowser.open(existing)
            return 0

    # In --no-serve probe mode we never build; just report what exists.
    tier, payload = resolve_tier(
        root,
        prefer_static=args.prefer_static,
        embedded=args.embedded,
        build=not args.no_serve,
    )

    if args.no_serve:
        status = "gui_ready" if tier == "spa" else "gui_unavailable"
        print(
            json.dumps(
                {
                    "status": status,
                    "tier": tier,
                    "detail": str(payload),
                    "guarantee": "no embedded fallback; Startup Studio must serve the built React SPA",
                    "command_hint": "/startup",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if tier == "spa" else 2

    open_browser = not args.no_open
    if tier == "spa":
        return serve_dir(payload, args.port, open_browser)
    print(
        json.dumps(
            {
                "status": "gui_unavailable",
                "tier": tier,
                "detail": str(payload),
                "command_hint": "cd web && npm install && npm run build",
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )
    return 2


# --------------------------------------------------------------------------- #
# Tier 4 — self-contained GUI embedded in this launcher. No external files,    #
# no node, no build, no network. Mirrors webapp/ (stages, packet, offers,      #
# pilots) so the experience is the same even when only this .py shipped.       #
# --------------------------------------------------------------------------- #
EMBEDDED_GUI_HTML = """<!doctype html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Startup Studio — founder operating board</title>
<style>
  :root{ --bg:#0b0b0c; --panel:#141417; --panel2:#1b1b20; --line:#26262d; --tx:#e9e9ee; --mut:#9a9aa6; --acc:#6d5efc; --acc2:#8b7dff; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--tx); font-family:Inter,Pretendard,-apple-system,system-ui,"Apple SD Gothic Neo",sans-serif; }
  a{ color:inherit; }
  .top{ display:flex; align-items:center; gap:12px; padding:14px 22px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(11,11,12,.85); backdrop-filter:blur(8px); z-index:5; }
  .mark{ width:30px; height:30px; border-radius:9px; background:linear-gradient(135deg,var(--acc),var(--acc2)); display:grid; place-items:center; font-weight:800; }
  .brand b{ font-size:15px; } .brand div{ font-size:12px; color:var(--mut); }
  .spacer{ flex:1; }
  .btn{ border:1px solid var(--line); background:var(--panel2); color:var(--tx); padding:9px 14px; border-radius:10px; font-size:13px; cursor:pointer; }
  .btn:hover{ border-color:var(--acc); }
  .btn.primary{ background:var(--acc); border-color:var(--acc); font-weight:600; }
  .btn.primary:disabled{ opacity:.5; cursor:default; }
  .wrap{ max-width:1080px; margin:0 auto; padding:26px 22px 80px; }
  .hero{ max-width:640px; margin:8vh auto; text-align:center; }
  .hero h1{ font-size:30px; margin:0 0 10px; } .hero p{ color:var(--mut); margin:0 0 26px; }
  .ife{ display:flex; gap:10px; } .ife input{ flex:1; background:var(--panel); border:1px solid var(--line); color:var(--tx); padding:14px 16px; border-radius:12px; font-size:15px; }
  .ife input:focus{ outline:none; border-color:var(--acc2); }
  .spine{ background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:20px 22px; margin-bottom:22px; }
  .spine h2{ margin:0 0 6px; font-size:20px; } .spine .sub{ color:var(--mut); font-size:13px; display:flex; gap:18px; flex-wrap:wrap; margin-top:8px; }
  .grid{ display:grid; grid-template-columns:1fr; gap:12px; }
  .stage{ background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px 18px; }
  .stage .h{ display:flex; align-items:center; gap:10px; }
  .stage .idx{ width:26px; height:26px; border-radius:8px; background:var(--panel2); display:grid; place-items:center; font-size:12px; color:var(--mut); }
  .stage .lab{ font-weight:600; } .stage .hq{ color:var(--mut); font-size:12px; }
  .pill{ font-size:11px; padding:3px 9px; border-radius:999px; border:1px solid var(--line); color:var(--mut); }
  .pill.pos{ color:var(--ok); border-color:#1f5c45; } .pill.warn{ color:var(--warn); border-color:#5c4a1f; } .pill.neu{ color:var(--mut); }
  .stage .head{ margin:10px 0 4px; font-size:15px; }
  .stage .sum{ color:var(--mut); font-size:13px; line-height:1.55; }
  .stage .det{ margin-top:12px; border-top:1px solid var(--line); padding-top:12px; display:none; }
  .stage.open .det{ display:block; }
  .mets{ display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  .met{ background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:8px 12px; font-size:12px; } .met b{ display:block; color:var(--mut); font-weight:500; margin-bottom:2px; }
  .wi{ font-size:13px; padding:7px 0; border-bottom:1px dashed var(--line); } .wi:last-child{ border:0; } .wi b{ color:var(--acc2); }
  .ev{ font-size:10px; padding:1px 6px; border-radius:6px; border:1px solid var(--line); color:var(--mut); margin-left:6px; }
  .arts{ display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
  .art{ display:inline-flex; align-items:center; gap:6px; border:1px solid #22577a; background:#082436; color:#9bd7ff; text-decoration:none; padding:7px 10px; border-radius:9px; font-size:12px; font-weight:650; }
  .hint{ border:1px dashed #22577a; color:#8db4cb; background:#07151c; border-radius:12px; padding:11px 12px; font-size:12px; line-height:1.5; margin:10px 0; }
  .preview{ margin-top:12px; border:1px solid var(--line); border-radius:14px; overflow:hidden; background:#fff; height:min(62vh,520px); }
  .preview iframe{ width:100%; height:100%; border:0; background:#fff; }
  .row{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .muted{ color:var(--mut); font-size:12px; }
  .toast{ position:fixed; left:50%; bottom:26px; transform:translateX(-50%); background:var(--panel2); border:1px solid var(--acc); padding:10px 16px; border-radius:12px; font-size:13px; display:none; }
  .hidden{ display:none !important; }
</style>
</head>
<body>
<div class="top">
  <div class="mark">S</div>
  <div class="brand"><b>Startup Studio</b><div>Founder operating board</div></div>
  <div class="spacer"></div>
  <button class="btn" id="newIdea">+ 새 아이디어</button>
</div>

<div class="wrap">
  <div id="hero" class="hero hidden">
    <h1>나만의 아이디어로 시작하기</h1>
    <p>한 줄로 적어주세요. HQ 에이전트가 아이디어부터 IR까지 이어갑니다.</p>
    <div class="ife">
      <input id="ideaInput" placeholder="예: 시니어 맞춤형 AI 대화·자서전 출판 서비스" />
      <button class="btn primary" id="startBtn" disabled>시작</button>
    </div>
    <p class="muted" style="margin-top:14px">입력한 언어 그대로 콘텐츠가 생성됩니다 (한글 → 한글).</p>
  </div>

  <div id="board" class="hidden">
    <div class="spine">
      <h2 id="oneLiner"></h2>
      <div class="sub"><span id="customer"></span><span id="problem"></span></div>
    </div>
    <div class="grid" id="stages"></div>
  </div>

  <div id="loading" class="hero hidden"><h1>생성 중…</h1><p class="muted">이 세션(당신의 구독 모델)이 단계를 작성하고 있어요.</p></div>
</div>

<div class="toast" id="toast"></div>

<script>
var LAB={idea:"아이디어 구체화",market:"시장 검증",business:"사업 설계",prd:"제품 기획",build:"제품 개발",deck:"IR / 피치덱"};
var ORDER=["idea","market","business","prd","build","deck"];
var lastVer=-1, polling=false, openStage=null;

function toast(m){ var t=document.getElementById("toast"); t.textContent=m; t.style.display="block"; setTimeout(function(){t.style.display="none";},2200); }
function show(id){ ["hero","board","loading"].forEach(function(x){ document.getElementById(x).classList.toggle("hidden", x!==id); }); }
function esc(s){ return String(s==null?"":s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];}); }
function attr(s){ return esc(s).replace(/"/g,"&quot;"); }
function tone(t){ return t==="positive"||t==="pos"?"pos":(t==="warning"||t==="warn"?"warn":"neu"); }
function productionStage(s){ return s==="build"||s==="deck"; }

function post(body){ return fetch("/__studio/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.ok;}).catch(function(){return false;}); }

function startIdea(){
  var v=document.getElementById("ideaInput").value.trim();
  if(!v) return;
  show("loading");
  post({kind:"init",idea:v}).then(function(ok){ if(!ok) toast("브릿지에 연결할 수 없어요"); });
}
function runStage(s){
  var kind=productionStage(s)?"produce":"run";
  toast(LAB[s]+(kind==="produce"?" 제작 요청됨…":" 생성 요청됨…"));
  show("loading");
  post({kind:kind,stage:s}).then(function(ok){ if(!ok) toast("브릿지에 연결할 수 없어요"); });
}

function artifactBlock(s,key){
  var arts=Array.isArray(s.artifacts)?s.artifacts:[];
  var links=arts.map(function(a){
    var href=a.href||""; if(!href) return "";
    var label=a.label||a.filename||"Open artifact";
    return '<a class="art" target="_blank" rel="noreferrer" href="'+attr(href)+'">'+esc(label)+'</a>';
  }).join("");
  var primary=arts.find(function(a){ return a && a.role==="primary" && (a.kind==="html" || a.kind==="pdf") && a.href; });
  var preview=primary?'<div class="preview"><iframe title="'+esc(LAB[key])+' artifact" src="'+attr(primary.href)+'"></iframe></div>':"";
  if(links || preview) return '<div class="arts">'+links+'</div>'+preview;
  if(productionStage(key)) return '<div class="hint">Run을 누르면 전문 제작 에이전트가 별도 결과 폴더에 산출물을 만들고, 이 화면은 그 결과를 보여주는 창으로만 작동합니다.</div>';
  return "";
}

function render(d){
  var en=(d&&d.en)||{}; var sp=en.ideaSpine||{};
  if(!sp.oneLiner){ show("hero"); return; }
  document.getElementById("oneLiner").textContent=sp.oneLiner;
  document.getElementById("customer").textContent="고객 · "+(sp.customer||"");
  document.getElementById("problem").textContent="문제 · "+(sp.problem||"");
  var st=en.stages||{}; var host=document.getElementById("stages"); host.innerHTML="";
  ORDER.forEach(function(key,i){
    var s=st[key]||{}; var v=s.verdict||{}; var waiting=(v.label==="대기"||v.label==="awaiting");
    var el=document.createElement("div"); el.className="stage"+(openStage===key?" open":"");
    var mets=(s.metrics||[]).map(function(m){return '<div class="met"><b>'+esc(m.label)+'</b>'+esc(m.value)+'</div>';}).join("");
    var wis=(s.workItems||[]).map(function(w){return '<div class="wi"><b>'+esc(w.title)+'</b> — '+esc(w.content)+'<span class="ev">'+esc(w.evidence||"")+'</span></div>';}).join("");
    var dec=s.decision?('<div class="wi"><b>결정</b> — '+esc(s.decision.question)+'</div>'):"";
    var arts=artifactBlock(s,key);
    el.innerHTML=
      '<div class="h"><div class="idx">'+("0"+(i+1)).slice(-2)+'</div><div><div class="lab">'+esc(LAB[key])+'</div><div class="hq">'+esc(s.hq||"")+'</div></div>'+
      '<div class="spacer" style="flex:1"></div><span class="pill '+tone(v.tone)+'">'+esc(v.label||"—")+'</span>'+
      '<button class="btn" data-run="'+key+'">'+(arts?"Re-run":"Run")+'</button></div>'+
      '<div class="head">'+esc(s.headline||"")+'</div>'+
      '<div class="sum">'+esc(s.summary||"")+'</div>'+
      '<div class="det">'+arts+(mets?'<div class="mets">'+mets+'</div>':"")+wis+dec+'</div>';
    el.querySelector(".h").addEventListener("click",function(e){ if(e.target.getAttribute("data-run"))return; openStage=(openStage===key?null:key); el.classList.toggle("open"); });
    el.querySelector("[data-run]").addEventListener("click",function(e){ e.stopPropagation(); runStage(key); });
    host.appendChild(el);
  });
  show("board");
}

function loadData(){ return fetch("/studio-data.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){ render(d); return d; }).catch(function(){ show("hero"); }); }
function poll(){
  fetch("/__studio/manifest",{cache:"no-store"}).then(function(r){return r.json();}).then(function(m){
    if(typeof m.data==="number" && m.data!==lastVer){ lastVer=m.data; loadData(); }
  }).catch(function(){});
}

document.getElementById("ideaInput").addEventListener("input",function(e){ document.getElementById("startBtn").disabled=!e.target.value.trim(); });
document.getElementById("ideaInput").addEventListener("keydown",function(e){ if(e.key==="Enter") startIdea(); });
document.getElementById("startBtn").addEventListener("click",startIdea);
document.getElementById("newIdea").addEventListener("click",function(){ document.getElementById("ideaInput").value=""; document.getElementById("startBtn").disabled=true; show("hero"); document.getElementById("ideaInput").focus(); });

loadData();
setInterval(poll,1500);
</script>
</body>
</html>
"""


if __name__ == "__main__":
    raise SystemExit(main())
