#!/usr/bin/env python3
"""Open or run the selected design-provider sign-in flow.

This script is intentionally small: it does not store credentials itself. Each
provider owns its browser or CLI session. The Startup package records only the
fact that a reusable session is expected.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".agentlas" / "design-provider-mcp.json"


def load_config() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def provider_by_id(config: dict, provider_id: str) -> dict:
    for provider in config.get("providers", []):
        if provider.get("id") == provider_id:
            return provider
    raise SystemExit(f"Unknown provider: {provider_id}")


def run_stitch(provider: dict, dry_run: bool) -> dict:
    command_hint = provider["auth_action"]["command_hint"]
    command = ["npx", "@_davideast/stitch-mcp", "init"]
    available = shutil.which("npx") is not None
    result = {
        "provider": provider["id"],
        "action": "stitch_cli_init",
        "command_hint": command_hint,
        "npx_available": available,
        "dry_run": dry_run,
    }
    if dry_run or not available:
        result["status"] = "needs_user_action" if not available else "ready_to_run"
        return result

    completed = subprocess.run(command, cwd=ROOT)
    result["status"] = "completed" if completed.returncode == 0 else "failed"
    result["returncode"] = completed.returncode
    return result


def run_claude_design(provider: dict, dry_run: bool) -> dict:
    url = "https://claude.ai/"
    result = {
        "provider": provider["id"],
        "action": "open_provider_sign_in",
        "url": url,
        "dry_run": dry_run,
        "note": provider["auth_action"]["session_expectation"],
    }
    if dry_run:
        result["status"] = "ready_to_open"
        return result

    opened = webbrowser.open(url)
    result["status"] = "opened" if opened else "open_failed"
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Design provider sign-in helper")
    parser.add_argument("--provider", choices=["stitch", "claude-design"], required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = load_config()
    provider = provider_by_id(config, args.provider)

    if args.provider == "stitch":
      result = run_stitch(provider, args.dry_run)
    else:
      result = run_claude_design(provider, args.dry_run)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in {"completed", "opened", "ready_to_run", "ready_to_open"} else 1


if __name__ == "__main__":
    sys.exit(main())
