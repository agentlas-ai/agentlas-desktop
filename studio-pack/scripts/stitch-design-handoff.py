#!/usr/bin/env python3
"""Build a Google Stitch handoff package from the Startup dogfood PRD.

The package is safe to commit: it contains prompts, file references, command
hints, and redacted readiness checks, but no account identifiers, local paths,
tokens, cookies, or API keys.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs/dogfood/startup-agent-app/stitch/stitch-handoff-package.json"
GENERATED_DIR = ROOT / "docs/dogfood/startup-agent-app/stitch/generated"
INPUT_FILES = [
    "docs/dogfood/startup-agent-app/prd/spec.md",
    "docs/dogfood/startup-agent-app/stitch/stitch-brief.md",
    "docs/dogfood/startup-agent-app/05-build-plan.md",
    "docs/dogfood/startup-agent-app/07-sales-demo.md",
    "docs/design.md",
]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def redact_text(value: str) -> str:
    home = str(Path.home())
    value = value.replace(home, "<home>")
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "<redacted-email>", value)
    value = re.sub(r"/Users/[^\\s\"']+", "<redacted-path>", value)
    value = re.sub(r"AIza[0-9A-Za-z_-]{20,}", "<redacted-api-key>", value)
    return value


def redact(value: object) -> object:
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def extract_json(text: str) -> dict | None:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def run_stitch_doctor() -> dict:
    env = os.environ.copy()
    try:
        completed = subprocess.run(
            ["npx", "@_davideast/stitch-mcp", "doctor", "--json"],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            timeout=45,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return redact(
            {
                "command": "npx @_davideast/stitch-mcp doctor --json",
                "returncode": "timeout",
                "all_passed": False,
                "blocked_checks": [
                    {
                        "name": "Stitch doctor timeout",
                        "message": "Provider readiness check did not finish within 45 seconds.",
                        "suggestion": "Run `npx @_davideast/stitch-mcp doctor --json` directly after setting the active Stitch/GCP project.",
                    }
                ],
                "partial_output": f"{exc.stdout or ''}\n{exc.stderr or ''}".strip(),
            }
        )
    parsed = extract_json(f"{completed.stdout}\n{completed.stderr}")
    doctor = {
        "command": "npx @_davideast/stitch-mcp doctor --json",
        "returncode": completed.returncode,
        "parsed": parsed,
    }
    if parsed:
        checks = parsed.get("data", {}).get("checks", [])
        doctor["blocked_checks"] = [
            {
                "name": item.get("name"),
                "message": item.get("message"),
                "suggestion": item.get("suggestion"),
            }
            for item in checks
            if not item.get("passed")
        ]
        doctor["all_passed"] = bool(parsed.get("data", {}).get("allPassed"))
    else:
        doctor["raw"] = f"{completed.stdout}\n{completed.stderr}".strip()
        doctor["all_passed"] = False
    return redact(doctor)


def build_package(include_doctor: bool) -> dict:
    inputs = []
    for path in INPUT_FILES:
        text = read_text(path)
        inputs.append(
            {
                "path": path,
                "chars": len(text),
                "sha_hint": f"len:{len(text)}",
            }
        )

    prompt = "\n\n".join(
        [
            "# Google Stitch Design Request",
            "Design the Startup Studio product surface from these source files.",
            "The output must preserve the lifecycle workflow, the right dock's app web prototype plus web artifact, and Founder Packet handoff.",
            "Do not include account data, local paths, secrets, unsupported market claims, or private screenshots.",
            "",
            read_text("docs/dogfood/startup-agent-app/stitch/stitch-brief.md"),
            "",
            read_text("docs/dogfood/startup-agent-app/07-sales-demo.md"),
        ]
    )

    package = {
        "schema": "agentlas.startup.stitch-handoff.v1",
        "provider": "Google Stitch",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": "generated_desktop_source_available"
        if (GENERATED_DIR / "ref-gen-stitch-001-v2.html").exists()
        else "handoff_ready_without_provider_check",
        "input_files": inputs,
        "generated_sources": [
            {
                "source_id": "REF-GEN-STITCH-001-v2",
                "project_id": "3890069885648704489",
                "screen_id": "e47d5e29b5684f908d7891a65697e069",
                "status": "current_desktop_visual_source",
                "files": [
                    "docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001-v2.png",
                    "docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001-v2.html",
                ],
            },
            {
                "source_id": "REF-GEN-STITCH-001",
                "project_id": "3890069885648704489",
                "screen_id": "15b051f4155047a4b72e9253bdd4be1d",
                "status": "superseded",
                "reason": "First pass kept English/action-label residue and incomplete package visibility.",
                "files": [
                    "docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001.png",
                    "docs/dogfood/startup-agent-app/stitch/generated/ref-gen-stitch-001.html",
                ],
            },
        ],
        "prompt": prompt,
        "mcp_commands": {
            "doctor": "npx @_davideast/stitch-mcp doctor --json",
            "login": "npx @_davideast/stitch-mcp init",
            "proxy": "npx @_davideast/stitch-mcp proxy",
            "upload_html": "npx @_davideast/stitch-mcp upload --project <project-id> --file webapp/index.html --title 'Startup Studio'",
            "list_screens": "npx @_davideast/stitch-mcp screens --project <project-id>",
            "export_site": "npx @_davideast/stitch-mcp site --project <project-id> --output docs/dogfood/startup-agent-app/stitch/generated-site",
        },
        "expected_outputs": [
            "desktop screen design",
            "mobile screen design",
            "app web prototype dock treatment",
            "web artifact dock treatment",
            "component/state notes mapped to REQ/FLOW/SCR/WF anchors",
            "preview URL, screenshots, or exported site files",
        ],
        "acceptance": [
            "Generated screen preserves the seven founder lifecycle stages.",
            "Right rail shows a clickable app web prototype and a web artifact preview.",
            "Founder Packet or equivalent handoff is visible.",
            "No credentials, raw cookies, account identifiers, or local paths appear in outputs.",
        ],
    }

    if include_doctor:
        doctor = run_stitch_doctor()
        package["doctor"] = doctor
        package["status"] = (
            "provider_ready" if doctor.get("all_passed") else "blocked_provider_config"
        )

    return package


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--doctor", action="store_true", help="Run stitch-mcp doctor and redact the result")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Where to write the handoff package")
    parser.add_argument("--no-write", action="store_true", help="Print the package without writing it")
    args = parser.parse_args()

    package = build_package(include_doctor=args.doctor)
    payload = json.dumps(redact(package), ensure_ascii=False, indent=2)

    if not args.no_write:
        output = Path(args.output)
        if not output.is_absolute():
            output = ROOT / output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload + "\n", encoding="utf-8")

    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
