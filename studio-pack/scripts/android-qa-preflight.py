#!/usr/bin/env python3
"""Report whether the Founder mobile Android QA plan can run locally."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
QA_PLAN = ROOT / "apps" / "founder-mobile" / "android" / "qa-plan.md"


def command_state(name: str) -> dict[str, object]:
    path = shutil.which(name)
    return {
        "command": name,
        "present": path is not None,
        "path": path,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", help="Optional APK path to validate before emulator QA.")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return a non-zero exit code when QA is blocked.",
    )
    args = parser.parse_args()

    tools = {name: command_state(name) for name in ("adb", "gradle", "java")}
    missing_tools = [name for name, state in tools.items() if not state["present"]]

    apk_state = {"required": False, "provided": False, "exists": False, "path": None}
    if args.apk:
        apk = Path(args.apk).expanduser()
        if not apk.is_absolute():
            apk = ROOT / apk
        apk_state = {
            "required": True,
            "provided": True,
            "exists": apk.is_file(),
            "path": str(apk),
        }

    if missing_tools:
        status = "blocked_missing_tools"
    elif apk_state["required"] and not apk_state["exists"]:
        status = "blocked_missing_apk"
    elif not args.apk:
        status = "blocked_missing_apk"
        apk_state["required"] = True
    else:
        status = "ready_to_run_emulator_qa"

    payload = {
        "schema": "agentlas.startup.android-qa-preflight.v1",
        "status": status,
        "plan": str(QA_PLAN.relative_to(ROOT)),
        "tools": tools,
        "missing_tools": missing_tools,
        "apk": apk_state,
        "next_actions": [],
    }

    if status == "blocked_missing_tools":
        payload["next_actions"].append(
            "Install Android platform tools and Gradle, then rerun this preflight before emulator QA."
        )
    if status == "blocked_missing_apk":
        payload["next_actions"].append(
            "Create a buildable Android target and pass --apk path/to/app.apk before running emulator QA."
        )

    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 1 if args.strict and status != "ready_to_run_emulator_qa" else 0


if __name__ == "__main__":
    raise SystemExit(main())
