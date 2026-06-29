#!/usr/bin/env python3
"""Check the local Hephaestus Network surface without opening auth popups.

The output is intended for dogfood QA logs, so it redacts machine-specific paths
and never prints tokens or credential material.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BENCHMARKS = ROOT / ".agentlas/routing-benchmarks.jsonl"


def resolve_runner() -> Path | None:
    candidates = [
        Path.home() / ".agentlas/runtime/current/bin/hephaestus",
        ROOT / "bin/hephaestus",
    ]
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return candidate

    for cache in [
        Path.home() / ".claude/plugins/cache/agentlas-core-engine/hephaestus",
        Path.home() / ".codex/plugins/cache/agentlas-core-engine/hephaestus",
    ]:
        if not cache.exists():
            continue
        matches = sorted(cache.glob("*/bin/hephaestus"))
        for candidate in reversed(matches):
            if candidate.exists() and os.access(candidate, os.X_OK):
                return candidate
    return None


def run_json(runner: Path, args: list[str]) -> dict:
    env = os.environ.copy()
    env["HEPHAESTUS_AUTH_AUTOPOPUP"] = "0"
    completed = subprocess.run(
        [str(runner), *args],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    payload = {
        "args": args,
        "returncode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }
    if completed.stdout.strip().startswith("{"):
        try:
            payload["json"] = json.loads(completed.stdout)
            payload["stdout"] = "<json>"
        except json.JSONDecodeError:
            pass
    return payload


def load_routing_benchmarks() -> list[dict]:
    if not BENCHMARKS.exists():
        return []
    cases = []
    for line in BENCHMARKS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        cases.append(json.loads(line))
    return cases


def run_startup_route_benchmarks(runner: Path) -> dict:
    cases = load_routing_benchmarks()
    results = []
    for case in cases:
        probe = run_json(runner, ["route", case["input"], "--project", ".", "--no-hub"])
        payload = probe.get("json", {})
        selected = payload.get("selected") if isinstance(payload, dict) else {}
        if not isinstance(selected, dict):
            selected = {}
        selected_id = selected.get("id")
        results.append(
            {
                "id": case.get("id"),
                "locale": case.get("locale"),
                "input": case.get("input"),
                "expected": case.get("expected"),
                "selected": selected_id,
                "passed": probe["returncode"] == 0 and selected_id == case.get("expected"),
                "receipt_id": payload.get("receipt_id") if isinstance(payload, dict) else None,
            }
        )

    passed = sum(1 for item in results if item["passed"])
    total = len(results)
    return {
        "cases": total,
        "passed": passed,
        "failed": total - passed,
        "top1_accuracy": round(passed / total, 4) if total else None,
        "results": results,
    }


def run_hub_visibility(runner: Path) -> dict:
    """Public distribution check: users do not have local Paid/Startup folders.
    The Startup Studio must be discoverable through Hub-only routing/search."""
    route = run_json(runner, ["route", "startup founder studio", "--project", ".", "--hub-only"])
    search = run_json(runner, ["hep-search", "startup founder studio", "--limit", "5"])

    route_results = (((route.get("json") or {}).get("hub") or {}).get("results") or [])
    search_results = ((((search.get("json") or {}).get("sections") or {}).get("hub") or {}).get("results") or [])

    def normalize(items: list[dict]) -> list[str]:
        out = []
        for item in items:
            if isinstance(item, dict) and item.get("slug"):
                out.append(str(item["slug"]))
        return out

    route_slugs = normalize(route_results)
    search_slugs = normalize(search_results)
    return {
        "route_returncode": route["returncode"],
        "search_returncode": search["returncode"],
        "route_receipt_id": (route.get("json") or {}).get("receipt_id"),
        "search_receipt_id": (search.get("json") or {}).get("receipt_id"),
        "route_top_slugs": route_slugs[:5],
        "search_top_slugs": search_slugs[:5],
        "ok": (
            route["returncode"] == 0
            and search["returncode"] == 0
            and "agentlas-startup-founder-studio" in route_slugs[:3]
            and search_slugs[:1] == ["agentlas-startup-founder-studio"]
        ),
    }


def redact(payload: object) -> object:
    if isinstance(payload, dict):
        redacted = {}
        for key, value in payload.items():
            if key in {"token_path", "path", "home", "source"}:
                redacted[key] = "<redacted-path>"
            else:
                redacted[key] = redact(value)
        return redacted
    if isinstance(payload, list):
        return [redact(item) for item in payload]
    if isinstance(payload, str):
        home = str(Path.home())
        return payload.replace(home, "<home>") if home in payload else payload
    return payload


def main() -> int:
    runner = resolve_runner()
    if runner is None:
        print(json.dumps({"status": "missing_runner"}, indent=2))
        return 1

    checks = {
        "auth_status": run_json(runner, ["auth", "status"]),
        "network_status": run_json(runner, ["network", "status"]),
        "network_bench": run_json(runner, ["network", "bench"]),
        "route_probe": run_json(
            runner, ["route", "startup founder studio", "--project", ".", "--no-hub"]
        ),
    }
    startup_benchmark = run_startup_route_benchmarks(runner)
    hub_visibility = run_hub_visibility(runner)
    result = {
        "status": "checked",
        "runner": "<redacted-path>",
        "checks": checks,
        "startup_route_benchmark": startup_benchmark,
        "startup_hub_visibility": hub_visibility,
        "notes": [],
    }

    help_completed = subprocess.run(
        [str(runner)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    help_text = f"{help_completed.stdout}\n{help_completed.stderr}"
    if "bin/hephaestus route " not in help_text:
        result["notes"].append(
            "installed runner exposes network status/bench but not the older route command"
        )

    route_payload = checks["route_probe"].get("json", {})
    commands = route_payload.get("agent_os_router", {}).get("commands", {})
    if commands.get("network") not in {None, "hephaestus-network"}:
        result["notes"].append(
            f"route payload reports unexpected network command name: {commands.get('network')}"
        )

    network_case_count = (
        checks["network_bench"]
        .get("json", {})
        .get("metrics", {})
        .get("cases")
    )
    if startup_benchmark["cases"] and network_case_count == 0:
        result["notes"].append(
            "global network bench reports 0 cases; package-local Startup route benchmarks are used instead"
        )

    print(json.dumps(redact(result), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
