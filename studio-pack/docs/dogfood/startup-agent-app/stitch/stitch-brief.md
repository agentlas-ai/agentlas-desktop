# Google Stitch Handoff Brief

## Provider

Google Stitch

Sources checked:

- [Google Developers Blog: Stitch introduction](https://developers.googleblog.com/stitch-a-new-way-to-design-uis/)
- [Google Blog: Stitch AI-native design canvas](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-ai-ui-design/)
- [Google Codelab: Design-to-Code with Antigravity and Stitch MCP](https://codelabs.developers.google.com/design-to-code-with-antigravity-stitch)
- [davideast/stitch-mcp](https://github.com/davideast/stitch-mcp)

## Readiness

| Item | Status |
|---|---|
| Stitch site | available at `stitch.withgoogle.com` |
| Local MCP helper | `npx @_davideast/stitch-mcp` resolves and exposes commands |
| Login helper | `scripts/design-provider-login.py --provider stitch --dry-run` returns `ready_to_run` |
| Actual Stitch account/API key | not stored in repo; must be completed by user-owned provider session |
| Handoff status | desktop design generated through Stitch MCP; additional mobile/state screens still pending |

## Generated Results

| Source ID | Stitch project | Screen | Status | Local evidence |
|---|---|---|---|---|
| `REF-GEN-STITCH-001` | `3890069885648704489` | `15b051f4155047a4b72e9253bdd4be1d` | superseded by v2; first pass kept English/action-label issues | `stitch/generated/ref-gen-stitch-001.png`, `stitch/generated/ref-gen-stitch-001.html` |
| `REF-GEN-STITCH-001-v2` | `3890069885648704489` | `e47d5e29b5684f908d7891a65697e069` | accepted as current desktop visual source with caveats | `stitch/generated/ref-gen-stitch-001-v2.png`, `stitch/generated/ref-gen-stitch-001-v2.html` |

Stitch v2 evidence includes the seven lifecycle stages, Starter/Studio/Concierge,
Pilot 01/02/03, `2/3` conversation progress, `검증 전`, `신뢰`, and
`지원사업 양식 비교`. It still contains non-visible English comments in exported
HTML, so the local webapp remains the stricter implementation contract.

## Stitch Prompt

Design a Korean-first SaaS product called "Startup Studio". It is a founder
operating board that helps a solo founder go from raw startup idea to market
validation, business plan, PRD, app build, web build, and QA/launch.

Create a high-fidelity responsive web app UI, not a marketing landing page.

Layout:

- Left rail with lifecycle stages:
  - 아이디어 구체화
  - 시장 검증
  - 사업 설계
  - PRD/화면 설계
  - 앱 제작
  - 웹 제작
  - QA/출시
- Center workspace:
  - raw idea input;
  - current decision card;
  - paid package selector with Starter, Studio, and Concierge choices;
  - paid-pilot tracker with three anonymous candidates, objection, and next action;
  - lifecycle timeline;
  - work board with stable IDs such as STU-101;
  - copyable work bundle action.
- Right dock:
  - componentized app web prototype with home, tasks, proof, action buttons, and bottom tabs;
  - web artifact preview;
  - current artifact status.

Visual style:

- compact founder operating board;
- neutral background, dark rail, restrained accent colors;
- Korean text must fit on mobile;
- avoid oversized hero marketing layout;
- use dense but readable SaaS workspace patterns;
- app/web previews should look real, inspectable, and clickable enough to judge the workflow before native builds.

Required screens:

1. Desktop workspace.
2. Mobile stacked workspace.
3. App build stage state with the right-side app web prototype visible.
4. Web build stage state.
5. Package selection state showing the selected paid offer.
6. Paid-pilot tracker state showing objection and next action.
7. QA/launch stage state.

Do not expose internal words like manifest, backend, token, system, or HQ in
founder-facing copy.

## Expected Stitch Output

- Desktop and mobile screen images.
- HTML/CSS or frontend code for the selected direction.
- A right-dock app prototype direction that can be implemented in web code before iOS/Android native work.
- A paid package selector mapped to `REQ-DOG-006`.
- A paid-pilot tracker mapped to `REQ-DOG-007`.
- Screen IDs to map back to `REQ-DOG-*`.
- A generated visual source ID: `REF-GEN-STITCH-001`.
- Current generated desktop source: `REF-GEN-STITCH-001-v2`.

## Next Command

```bash
python3 scripts/design-provider-login.py --provider stitch
```

Then create the Stitch design from the prompt above. After the design exists,
use the Stitch MCP helper to inspect, serve, or export screens.
