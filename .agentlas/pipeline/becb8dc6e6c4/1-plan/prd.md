# Oberon Real Render PRD

## Objective

Turn Oberon from a deterministic production simulation into a desktop render studio that can create real Google Veo clips, play them inside the Electron app, and export/download MP4, MOV, and WAV outputs.

## Guardrails

- Renderer must never receive raw API keys.
- Google credentials come from the existing Agentlas env vault or process environment.
- The first production implementation targets Google Gemini API / Veo through the official `@google/genai` flow.
- Generated videos must be downloaded immediately to local disk because provider-hosted files are temporary.
- Static browser export must fail clearly when the Electron bridge is unavailable.
- Keep the existing Oberon shot, take, cost, and EDL model so planning and delivery exports still work.

## Scope

- Add Oberon-specific IPC for render job creation, polling, cancellation, and output-folder opening.
- Add an Electron render service that creates a bounded Google Veo job for selected shots.
- Store generated MP4 files under the app data directory and derive master MP4, MOV, and WAV files with ffmpeg when available.
- Update the video step to show real job progress, playback, and generated file downloads.
- Update the delivery step to include real render outputs when present.

## Initial Limits

- Default live render count is capped to three shots to avoid surprise spend.
- Text-to-video is the first live mode. Image-to-video and first/last-frame mode can follow once keyframe generation is wired.
- If Google API credentials are missing or invalid, the UI must report that directly instead of silently falling back to simulation.
