# Oberon Real Render Codebase Change

## Implemented

- Added an Electron Oberon render service backed by Google GenAI / Veo.
- Added Oberon IPC methods for render start, polling, cancel, and output folder opening.
- Added renderer-side live render state, polling, real take materialization, and delivery outputs.
- Added Google API key gate that stores `GEMINI_API_KEY` in the existing Agentlas Keychain env vault.
- Added local MP4 clip saving plus ffmpeg-derived master MP4, MOV, and WAV files.
- Updated Google Veo provider metadata to Gemini API / Veo 3.1 Fast GA defaults.
- Removed automatic paid video start after keyframe approval.
- Fixed the keyframe money gate to use the same total cost as the header and cost ledger.

## Verification

- `npx tsc -p electron/tsconfig.json --noEmit`
- `cd renderer && npx tsc --noEmit`
- `cd renderer && npx next build`
- `npm run build:electron`
- Playwright opened `http://localhost:3101/oberon` and verified the setup flow and Google Veo key gate.

## Live API Smoke

Not executed yet. The local env vault and process environment currently do not contain `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_APPLICATION_CREDENTIALS`.
