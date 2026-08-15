// GENERATED FILE — do not edit by hand. Regenerate with:
//   node scripts/build-model-catalog-snapshot.cjs
// Tier-1 (offline) layer of the 4-tier model catalog. See shared/model-catalog.ts.
// Attribution: models.dev (anomalyco/models.dev), MIT. Providers trimmed to Agentlas backends.
import type { CatalogSnapshot } from "./model-catalog";

export const MODEL_CATALOG_SNAPSHOT: CatalogSnapshot = {
  "schemaVersion": "agentlas.model-catalog-snapshot.v1",
  "generatedAt": "2026-08-15",
  "source": "https://models.dev/api.json",
  "attribution": "Data © models.dev contributors (anomalyco/models.dev), MIT License. Trimmed to the providers Agentlas routes to.",
  "upstream": {
    "providers": 185,
    "models": 6583
  },
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic"
    },
    {
      "id": "openai",
      "name": "OpenAI"
    },
    {
      "id": "google",
      "name": "Google"
    },
    {
      "id": "xai",
      "name": "xAI"
    },
    {
      "id": "deepseek",
      "name": "DeepSeek"
    },
    {
      "id": "moonshotai",
      "name": "Moonshot AI"
    },
    {
      "id": "kimi-for-coding",
      "name": "Kimi For Coding"
    },
    {
      "id": "zai",
      "name": "Z.AI"
    },
    {
      "id": "zai-coding-plan",
      "name": "Z.AI Coding Plan"
    },
    {
      "id": "minimax",
      "name": "MiniMax (minimax.io)"
    },
    {
      "id": "upstage",
      "name": "Upstage"
    },
    {
      "id": "mistral",
      "name": "Mistral"
    }
  ],
  "models": [
    {
      "provider": "anthropic",
      "id": "claude-fable-5",
      "name": "Claude Fable 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 10,
        "output": 50
      },
      "releaseDate": "2026-06-07"
    },
    {
      "provider": "anthropic",
      "id": "claude-haiku-4-5",
      "name": "Claude Haiku 4.5 (latest)",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1,
        "output": 5
      },
      "releaseDate": "2025-10-15"
    },
    {
      "provider": "anthropic",
      "id": "claude-haiku-4-5-20251001",
      "name": "Claude Haiku 4.5",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1,
        "output": 5
      },
      "releaseDate": "2025-10-15"
    },
    {
      "provider": "anthropic",
      "id": "claude-opus-4-5",
      "name": "Claude Opus 4.5 (latest)",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 25
      },
      "releaseDate": "2025-11-24"
    },
    {
      "provider": "anthropic",
      "id": "claude-opus-4-5-20251101",
      "name": "Claude Opus 4.5",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 25
      },
      "releaseDate": "2025-11-24"
    },
    {
      "provider": "anthropic",
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 25
      },
      "releaseDate": "2026-02-04"
    },
    {
      "provider": "anthropic",
      "id": "claude-opus-4-7",
      "name": "Claude Opus 4.7",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 25
      },
      "releaseDate": "2026-04-14"
    },
    {
      "provider": "anthropic",
      "id": "claude-opus-4-8",
      "name": "Claude Opus 4.8",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 25
      },
      "releaseDate": "2026-05-28"
    },
    {
      "provider": "anthropic",
      "id": "claude-opus-5",
      "name": "Claude Opus 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 25
      },
      "releaseDate": "2026-07-24"
    },
    {
      "provider": "anthropic",
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5 (latest)",
      "contextWindow": 1000000,
      "maxOutput": 64000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 3,
        "output": 15
      },
      "releaseDate": "2025-09-29"
    },
    {
      "provider": "anthropic",
      "id": "claude-sonnet-4-5-20250929",
      "name": "Claude Sonnet 4.5",
      "contextWindow": 1000000,
      "maxOutput": 64000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 3,
        "output": 15
      },
      "releaseDate": "2025-09-29"
    },
    {
      "provider": "anthropic",
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 3,
        "output": 15
      },
      "releaseDate": "2026-02-17"
    },
    {
      "provider": "anthropic",
      "id": "claude-sonnet-5",
      "name": "Claude Sonnet 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 10
      },
      "releaseDate": "2026-06-29"
    },
    {
      "provider": "deepseek",
      "id": "deepseek-chat",
      "name": "DeepSeek Chat",
      "contextWindow": 1000000,
      "maxOutput": 384000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.14,
        "output": 0.28
      },
      "releaseDate": "2025-12-01"
    },
    {
      "provider": "deepseek",
      "id": "deepseek-reasoner",
      "name": "DeepSeek Reasoner",
      "contextWindow": 1000000,
      "maxOutput": 384000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.14,
        "output": 0.28
      },
      "releaseDate": "2025-12-01"
    },
    {
      "provider": "deepseek",
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "contextWindow": 1000000,
      "maxOutput": 384000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.14,
        "output": 0.28
      },
      "releaseDate": "2026-07-31"
    },
    {
      "provider": "deepseek",
      "id": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "contextWindow": 1000000,
      "maxOutput": 384000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "high",
        "max"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.435,
        "output": 0.87
      },
      "releaseDate": "2026-08-12"
    },
    {
      "provider": "google",
      "id": "deep-research-max-preview-04-2026",
      "name": "Deep Research Max Preview (Apr-21-2026)",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 12
      },
      "releaseDate": "2026-04-21"
    },
    {
      "provider": "google",
      "id": "deep-research-preview-04-2026",
      "name": "Deep Research Preview (Apr-21-2026)",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 12
      },
      "releaseDate": "2026-04-21"
    },
    {
      "provider": "google",
      "id": "gemini-2.5-computer-use-preview-10-2025",
      "name": "Gemini 2.5 Computer Use Preview 10-2025",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10
      },
      "releaseDate": "2025-10-07"
    },
    {
      "provider": "google",
      "id": "gemini-2.5-flash",
      "name": "Gemini 2.5 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "audio",
        "video",
        "pdf"
      ],
      "cost": {
        "input": 0.3,
        "output": 2.5
      },
      "releaseDate": "2025-06-17"
    },
    {
      "provider": "google",
      "id": "gemini-2.5-flash-image",
      "name": "Nano Banana",
      "contextWindow": 32768,
      "maxOutput": 32768,
      "toolCall": false,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.3,
        "output": 30
      },
      "releaseDate": "2025-08-26"
    },
    {
      "provider": "google",
      "id": "gemini-2.5-flash-lite",
      "name": "Gemini 2.5 Flash-Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "audio",
        "video",
        "pdf"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.4
      },
      "releaseDate": "2025-06-17"
    },
    {
      "provider": "google",
      "id": "gemini-2.5-flash-preview-tts",
      "name": "Gemini 2.5 Flash Preview TTS",
      "contextWindow": 8192,
      "maxOutput": 16384,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.5,
        "output": 10
      },
      "releaseDate": "2025-05-01"
    },
    {
      "provider": "google",
      "id": "gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "audio",
        "video",
        "pdf"
      ],
      "cost": {
        "input": 1.25,
        "output": 10
      },
      "releaseDate": "2025-06-17"
    },
    {
      "provider": "google",
      "id": "gemini-2.5-pro-preview-tts",
      "name": "Gemini 2.5 Pro Preview TTS",
      "contextWindow": 8192,
      "maxOutput": 16384,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1,
        "output": 20
      },
      "releaseDate": "2025-05-01"
    },
    {
      "provider": "google",
      "id": "gemini-3-flash-preview",
      "name": "Gemini 3 Flash Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 0.5,
        "output": 3
      },
      "releaseDate": "2025-12-17"
    },
    {
      "provider": "google",
      "id": "gemini-3-pro-image",
      "name": "Nano Banana Pro",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "toolCall": false,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 120
      },
      "releaseDate": "2026-05-28"
    },
    {
      "provider": "google",
      "id": "gemini-3-pro-image-preview",
      "name": "Nano Banana Pro",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "toolCall": false,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 120
      },
      "releaseDate": "2025-11-20"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-flash-image",
      "name": "Nano Banana 2",
      "contextWindow": 65536,
      "maxOutput": 65536,
      "toolCall": false,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "pdf"
      ],
      "cost": {
        "input": 0.5,
        "output": 60
      },
      "releaseDate": "2026-05-28"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-flash-image-preview",
      "name": "Nano Banana 2",
      "contextWindow": 65536,
      "maxOutput": 65536,
      "toolCall": false,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 0.5,
        "output": 60
      },
      "releaseDate": "2026-02-26"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-flash-lite",
      "name": "Gemini 3.1 Flash Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 0.25,
        "output": 1.5
      },
      "releaseDate": "2026-05-07"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-flash-lite-image",
      "name": "Nano Banana 2 Lite",
      "contextWindow": 65536,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.25,
        "output": 30
      },
      "releaseDate": "2026-06-30"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-flash-lite-preview",
      "name": "Gemini 3.1 Flash Lite Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 0.25,
        "output": 1.5
      },
      "releaseDate": "2026-03-03"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-flash-live-preview",
      "name": "Gemini 3.1 Flash Live Preview",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio"
      ],
      "cost": {
        "input": 0.75,
        "output": 4.5
      },
      "releaseDate": "2026-03-26"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-flash-tts-preview",
      "name": "Gemini 3.1 Flash TTS Preview",
      "contextWindow": 8192,
      "maxOutput": 16384,
      "toolCall": false,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1,
        "output": 20
      },
      "releaseDate": "2026-04-15"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-pro-preview",
      "name": "Gemini 3.1 Pro Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 12
      },
      "releaseDate": "2026-02-19"
    },
    {
      "provider": "google",
      "id": "gemini-3.1-pro-preview-customtools",
      "name": "Gemini 3.1 Pro Preview Custom Tools",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 12
      },
      "releaseDate": "2026-02-19"
    },
    {
      "provider": "google",
      "id": "gemini-3.5-flash",
      "name": "Gemini 3.5 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 1.5,
        "output": 9
      },
      "releaseDate": "2026-05-19"
    },
    {
      "provider": "google",
      "id": "gemini-3.5-flash-lite",
      "name": "Gemini 3.5 Flash Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 0.3,
        "output": 2.5
      },
      "releaseDate": "2026-07-21"
    },
    {
      "provider": "google",
      "id": "gemini-3.5-live-translate-preview",
      "name": "Gemini 3.5 Live Translate Preview",
      "contextWindow": 16384,
      "maxOutput": 32768,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "audio"
      ],
      "cost": {
        "input": 3.5,
        "output": 21
      },
      "releaseDate": "2026-06-09"
    },
    {
      "provider": "google",
      "id": "gemini-3.6-flash",
      "name": "Gemini 3.6 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 1.5,
        "output": 7.5
      },
      "releaseDate": "2026-07-21"
    },
    {
      "provider": "google",
      "id": "gemini-3.7-flash",
      "name": "Gemini 3.7 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 0.75,
        "output": 3.75
      },
      "releaseDate": "2026-08-13"
    },
    {
      "provider": "google",
      "id": "gemini-embedding-001",
      "name": "Gemini Embedding 001",
      "contextWindow": 2048,
      "maxOutput": 1,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.15,
        "output": 0
      },
      "releaseDate": "2025-05-20"
    },
    {
      "provider": "google",
      "id": "gemini-embedding-2",
      "name": "Gemini Embedding 2",
      "contextWindow": 8192,
      "maxOutput": 1,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "audio",
        "video",
        "pdf"
      ],
      "cost": {
        "input": 0.2,
        "output": 0
      },
      "releaseDate": "2026-04-22"
    },
    {
      "provider": "google",
      "id": "gemini-flash-latest",
      "name": "Gemini Flash Latest",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 1.5,
        "output": 9
      },
      "releaseDate": "2026-05-19"
    },
    {
      "provider": "google",
      "id": "gemini-flash-lite-latest",
      "name": "Gemini Flash-Lite Latest",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio",
        "pdf"
      ],
      "cost": {
        "input": 0.25,
        "output": 1.5
      },
      "releaseDate": "2026-05-07"
    },
    {
      "provider": "google",
      "id": "gemini-omni-flash-preview",
      "name": "Gemini Omni Flash Preview",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "toolCall": false,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 1.5,
        "output": 17.5
      },
      "releaseDate": "2026-06-30"
    },
    {
      "provider": "google",
      "id": "gemini-robotics-er-1.6-preview",
      "name": "Gemini Robotics-ER 1.6 Preview",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video",
        "audio"
      ],
      "cost": {
        "input": 1,
        "output": 5
      },
      "releaseDate": "2026-04-14"
    },
    {
      "provider": "google",
      "id": "gemma-4-26b-a4b-it",
      "name": "Gemma 4 26B A4B IT",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2026-04-02"
    },
    {
      "provider": "google",
      "id": "gemma-4-31b-it",
      "name": "Gemma 4 31B IT",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2026-04-02"
    },
    {
      "provider": "google",
      "id": "lyria-3-clip-preview",
      "name": "Lyria 3 Clip Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-03-25"
    },
    {
      "provider": "google",
      "id": "lyria-3-pro-preview",
      "name": "Lyria 3 Pro Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-03-25"
    },
    {
      "provider": "google",
      "id": "veo-3.1-fast-generate-preview",
      "name": "Veo 3.1 fast",
      "contextWindow": 480,
      "maxOutput": 8192,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "releaseDate": "2025-10-15"
    },
    {
      "provider": "google",
      "id": "veo-3.1-generate-preview",
      "name": "Veo 3.1",
      "contextWindow": 480,
      "maxOutput": 8192,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2025-10-15"
    },
    {
      "provider": "google",
      "id": "veo-3.1-lite-generate-preview",
      "name": "Veo 3.1 lite",
      "contextWindow": 480,
      "maxOutput": 8192,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2026-03-31"
    },
    {
      "provider": "kimi-for-coding",
      "id": "k3",
      "name": "Kimi K3",
      "contextWindow": 1048576,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-07-16"
    },
    {
      "provider": "kimi-for-coding",
      "id": "k3-256k",
      "name": "Kimi K3-256K",
      "contextWindow": 262144,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-07-16"
    },
    {
      "provider": "kimi-for-coding",
      "id": "kimi-for-coding",
      "name": "Kimi K2.7 Code",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-06-12"
    },
    {
      "provider": "kimi-for-coding",
      "id": "kimi-for-coding-highspeed",
      "name": "Kimi For Coding HighSpeed",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-06-12"
    },
    {
      "provider": "minimax",
      "id": "MiniMax-M2",
      "name": "MiniMax-M2",
      "contextWindow": 196608,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.3,
        "output": 1.2
      },
      "releaseDate": "2025-10-27"
    },
    {
      "provider": "minimax",
      "id": "MiniMax-M2.1",
      "name": "MiniMax-M2.1",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.3,
        "output": 1.2
      },
      "releaseDate": "2025-12-23"
    },
    {
      "provider": "minimax",
      "id": "MiniMax-M2.5",
      "name": "MiniMax-M2.5",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.3,
        "output": 1.2
      },
      "releaseDate": "2026-02-12"
    },
    {
      "provider": "minimax",
      "id": "MiniMax-M2.5-highspeed",
      "name": "MiniMax-M2.5-highspeed",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.4
      },
      "releaseDate": "2026-02-13"
    },
    {
      "provider": "minimax",
      "id": "MiniMax-M2.7",
      "name": "MiniMax-M2.7",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.3,
        "output": 1.2
      },
      "releaseDate": "2026-03-18"
    },
    {
      "provider": "minimax",
      "id": "MiniMax-M2.7-highspeed",
      "name": "MiniMax-M2.7-highspeed",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.4
      },
      "releaseDate": "2026-03-18"
    },
    {
      "provider": "minimax",
      "id": "MiniMax-M3",
      "name": "MiniMax-M3",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0.3,
        "output": 1.2
      },
      "releaseDate": "2026-06-01"
    },
    {
      "provider": "mistral",
      "id": "codestral-latest",
      "name": "Codestral (latest)",
      "contextWindow": 256000,
      "maxOutput": 4096,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.3,
        "output": 0.9
      },
      "releaseDate": "2024-05-29"
    },
    {
      "provider": "mistral",
      "id": "devstral-2512",
      "name": "Devstral 2",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.4,
        "output": 2
      },
      "releaseDate": "2025-12-09"
    },
    {
      "provider": "mistral",
      "id": "devstral-latest",
      "name": "Devstral 2",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.4,
        "output": 2
      },
      "releaseDate": "2025-12-09"
    },
    {
      "provider": "mistral",
      "id": "devstral-medium-2507",
      "name": "Devstral Medium",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.4,
        "output": 2
      },
      "releaseDate": "2025-07-10"
    },
    {
      "provider": "mistral",
      "id": "devstral-medium-latest",
      "name": "Devstral 2 (latest)",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.4,
        "output": 2
      },
      "releaseDate": "2025-12-02"
    },
    {
      "provider": "mistral",
      "id": "devstral-small-2505",
      "name": "Devstral Small 2505",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.3
      },
      "releaseDate": "2025-05-07"
    },
    {
      "provider": "mistral",
      "id": "devstral-small-2507",
      "name": "Devstral Small",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.3
      },
      "releaseDate": "2025-07-10"
    },
    {
      "provider": "mistral",
      "id": "labs-devstral-small-2512",
      "name": "Devstral Small 2",
      "contextWindow": 256000,
      "maxOutput": 256000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2025-12-09"
    },
    {
      "provider": "mistral",
      "id": "magistral-medium-latest",
      "name": "Magistral Medium (latest)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 2,
        "output": 5
      },
      "releaseDate": "2025-03-17"
    },
    {
      "provider": "mistral",
      "id": "magistral-small",
      "name": "Magistral Small",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.5,
        "output": 1.5
      },
      "releaseDate": "2025-03-17"
    },
    {
      "provider": "mistral",
      "id": "ministral-3b-latest",
      "name": "Ministral 3B (latest)",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.04,
        "output": 0.04
      },
      "releaseDate": "2024-10-01"
    },
    {
      "provider": "mistral",
      "id": "ministral-8b-latest",
      "name": "Ministral 8B (latest)",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.1
      },
      "releaseDate": "2024-10-01"
    },
    {
      "provider": "mistral",
      "id": "mistral-embed",
      "name": "Mistral Embed",
      "contextWindow": 8000,
      "maxOutput": 3072,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.1,
        "output": 0
      },
      "releaseDate": "2023-12-11"
    },
    {
      "provider": "mistral",
      "id": "mistral-large-2411",
      "name": "Mistral Large 2.1",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 2,
        "output": 6
      },
      "releaseDate": "2024-11-18"
    },
    {
      "provider": "mistral",
      "id": "mistral-large-2512",
      "name": "Mistral Large 3",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.5,
        "output": 1.5
      },
      "releaseDate": "2024-11-01"
    },
    {
      "provider": "mistral",
      "id": "mistral-large-latest",
      "name": "Mistral Large (latest)",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.5,
        "output": 1.5
      },
      "releaseDate": "2024-11-01"
    },
    {
      "provider": "mistral",
      "id": "mistral-medium-2505",
      "name": "Mistral Medium 3",
      "contextWindow": 131072,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.4,
        "output": 2
      },
      "releaseDate": "2025-05-07"
    },
    {
      "provider": "mistral",
      "id": "mistral-medium-2508",
      "name": "Mistral Medium 3.1",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.4,
        "output": 2
      },
      "releaseDate": "2025-08-12"
    },
    {
      "provider": "mistral",
      "id": "mistral-medium-2604",
      "name": "Mistral Medium 3.5",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.5,
        "output": 7.5
      },
      "releaseDate": "2026-04-29"
    },
    {
      "provider": "mistral",
      "id": "mistral-medium-latest",
      "name": "Mistral Medium (latest)",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.5,
        "output": 7.5
      },
      "releaseDate": "2026-04-29"
    },
    {
      "provider": "mistral",
      "id": "mistral-nemo",
      "name": "Mistral Nemo",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.15,
        "output": 0.15
      },
      "releaseDate": "2024-07-01"
    },
    {
      "provider": "mistral",
      "id": "mistral-small-2506",
      "name": "Mistral Small 3.2",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.3
      },
      "releaseDate": "2025-06-20"
    },
    {
      "provider": "mistral",
      "id": "mistral-small-2603",
      "name": "Mistral Small 4",
      "contextWindow": 256000,
      "maxOutput": 256000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.15,
        "output": 0.6
      },
      "releaseDate": "2026-03-16"
    },
    {
      "provider": "mistral",
      "id": "mistral-small-latest",
      "name": "Mistral Small (latest)",
      "contextWindow": 256000,
      "maxOutput": 256000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.15,
        "output": 0.6
      },
      "releaseDate": "2026-03-16"
    },
    {
      "provider": "mistral",
      "id": "open-mistral-7b",
      "name": "Mistral 7B",
      "contextWindow": 8000,
      "maxOutput": 8000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.25,
        "output": 0.25
      },
      "releaseDate": "2023-09-27"
    },
    {
      "provider": "mistral",
      "id": "open-mistral-nemo",
      "name": "Open Mistral Nemo",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.15,
        "output": 0.15
      },
      "releaseDate": "2024-07-01"
    },
    {
      "provider": "mistral",
      "id": "open-mixtral-8x22b",
      "name": "Mixtral 8x22B",
      "contextWindow": 64000,
      "maxOutput": 64000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 2,
        "output": 6
      },
      "releaseDate": "2024-04-17"
    },
    {
      "provider": "mistral",
      "id": "open-mixtral-8x7b",
      "name": "Mixtral 8x7B",
      "contextWindow": 32000,
      "maxOutput": 32000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.7,
        "output": 0.7
      },
      "releaseDate": "2023-12-11"
    },
    {
      "provider": "mistral",
      "id": "pixtral-12b",
      "name": "Pixtral 12B",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.15,
        "output": 0.15
      },
      "releaseDate": "2024-09-01"
    },
    {
      "provider": "mistral",
      "id": "pixtral-large-latest",
      "name": "Pixtral Large (latest)",
      "contextWindow": 128000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 6
      },
      "releaseDate": "2024-11-01"
    },
    {
      "provider": "mistral",
      "id": "voxtral-mini-latest",
      "name": "Voxtral Mini (latest)",
      "contextWindow": 0,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "audio"
      ],
      "releaseDate": "2026-02-01"
    },
    {
      "provider": "mistral",
      "id": "voxtral-mini-tts-latest",
      "name": "Voxtral Mini TTS (latest)",
      "contextWindow": 0,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "releaseDate": "2026-03-01"
    },
    {
      "provider": "mistral",
      "id": "voxtral-small-latest",
      "name": "Voxtral Small (latest)",
      "contextWindow": 32000,
      "maxOutput": 32000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "audio"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.3
      },
      "releaseDate": "2025-07-15"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2-0711-preview",
      "name": "Kimi K2 0711",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.5
      },
      "releaseDate": "2025-07-14"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2-0905-preview",
      "name": "Kimi K2 0905",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.5
      },
      "releaseDate": "2025-09-05"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2-thinking",
      "name": "Kimi K2 Thinking",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.5
      },
      "releaseDate": "2025-11-06"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2-thinking-turbo",
      "name": "Kimi K2 Thinking Turbo",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1.15,
        "output": 8
      },
      "releaseDate": "2025-11-06"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2-turbo-preview",
      "name": "Kimi K2 Turbo",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 2.4,
        "output": 10
      },
      "releaseDate": "2025-09-05"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2.5",
      "name": "Kimi K2.5",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0.6,
        "output": 3
      },
      "releaseDate": "2026-01"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2.6",
      "name": "Kimi K2.6",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0.95,
        "output": 4
      },
      "releaseDate": "2026-04-21"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2.7-code",
      "name": "Kimi K2.7 Code",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0.95,
        "output": 4
      },
      "releaseDate": "2026-06-12"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k2.7-code-highspeed",
      "name": "Kimi K2.7 Code HighSpeed",
      "contextWindow": 262144,
      "maxOutput": 262144,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 1.9,
        "output": 8
      },
      "releaseDate": "2026-06-12"
    },
    {
      "provider": "moonshotai",
      "id": "kimi-k3",
      "name": "Kimi K3",
      "contextWindow": 1048576,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 3,
        "output": 15
      },
      "releaseDate": "2026-07-16"
    },
    {
      "provider": "openai",
      "id": "chatgpt-image-latest",
      "name": "chatgpt-image-latest",
      "contextWindow": 0,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2025-12-16"
    },
    {
      "provider": "openai",
      "id": "gpt-3.5-turbo",
      "name": "GPT-3.5-turbo",
      "contextWindow": 16385,
      "maxOutput": 4096,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.5,
        "output": 1.5
      },
      "releaseDate": "2023-03-01"
    },
    {
      "provider": "openai",
      "id": "gpt-4",
      "name": "GPT-4",
      "contextWindow": 8192,
      "maxOutput": 8192,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 30,
        "output": 60
      },
      "releaseDate": "2023-11-06"
    },
    {
      "provider": "openai",
      "id": "gpt-4-turbo",
      "name": "GPT-4 Turbo",
      "contextWindow": 128000,
      "maxOutput": 4096,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 10,
        "output": 30
      },
      "releaseDate": "2023-11-06"
    },
    {
      "provider": "openai",
      "id": "gpt-4.1",
      "name": "GPT-4.1",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 8
      },
      "releaseDate": "2025-04-14"
    },
    {
      "provider": "openai",
      "id": "gpt-4.1-mini",
      "name": "GPT-4.1 mini",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 0.4,
        "output": 1.6
      },
      "releaseDate": "2025-04-14"
    },
    {
      "provider": "openai",
      "id": "gpt-4.1-nano",
      "name": "GPT-4.1 nano",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.4
      },
      "releaseDate": "2025-04-14"
    },
    {
      "provider": "openai",
      "id": "gpt-4o",
      "name": "GPT-4o",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2.5,
        "output": 10
      },
      "releaseDate": "2024-05-13"
    },
    {
      "provider": "openai",
      "id": "gpt-4o-2024-05-13",
      "name": "GPT-4o (2024-05-13)",
      "contextWindow": 128000,
      "maxOutput": 4096,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 15
      },
      "releaseDate": "2024-05-13"
    },
    {
      "provider": "openai",
      "id": "gpt-4o-2024-08-06",
      "name": "GPT-4o (2024-08-06)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2.5,
        "output": 10
      },
      "releaseDate": "2024-08-06"
    },
    {
      "provider": "openai",
      "id": "gpt-4o-2024-11-20",
      "name": "GPT-4o (2024-11-20)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2.5,
        "output": 10
      },
      "releaseDate": "2024-11-20"
    },
    {
      "provider": "openai",
      "id": "gpt-4o-mini",
      "name": "GPT-4o mini",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 0.15,
        "output": 0.6
      },
      "releaseDate": "2024-07-18"
    },
    {
      "provider": "openai",
      "id": "gpt-5",
      "name": "GPT-5",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10
      },
      "releaseDate": "2025-08-07"
    },
    {
      "provider": "openai",
      "id": "gpt-5-mini",
      "name": "GPT-5 Mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.25,
        "output": 2
      },
      "releaseDate": "2025-08-07"
    },
    {
      "provider": "openai",
      "id": "gpt-5-nano",
      "name": "GPT-5 Nano",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.05,
        "output": 0.4
      },
      "releaseDate": "2025-08-07"
    },
    {
      "provider": "openai",
      "id": "gpt-5-pro",
      "name": "GPT-5 Pro",
      "contextWindow": 400000,
      "maxOutput": 272000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 120
      },
      "releaseDate": "2025-10-06"
    },
    {
      "provider": "openai",
      "id": "gpt-5.1",
      "name": "GPT-5.1",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10
      },
      "releaseDate": "2025-11-13"
    },
    {
      "provider": "openai",
      "id": "gpt-5.2",
      "name": "GPT-5.2",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.75,
        "output": 14
      },
      "releaseDate": "2025-12-11"
    },
    {
      "provider": "openai",
      "id": "gpt-5.2-chat-latest",
      "name": "GPT-5.2 Chat",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "medium"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.75,
        "output": 14
      },
      "releaseDate": "2025-12-11"
    },
    {
      "provider": "openai",
      "id": "gpt-5.2-pro",
      "name": "GPT-5.2 Pro",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 21,
        "output": 168
      },
      "releaseDate": "2025-12-11"
    },
    {
      "provider": "openai",
      "id": "gpt-5.3-chat-latest",
      "name": "GPT-5.3 Chat (latest)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.75,
        "output": 14
      },
      "releaseDate": "2026-03-03"
    },
    {
      "provider": "openai",
      "id": "gpt-5.3-codex",
      "name": "GPT-5.3 Codex",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1.75,
        "output": 14
      },
      "releaseDate": "2026-02-05"
    },
    {
      "provider": "openai",
      "id": "gpt-5.3-codex-spark",
      "name": "GPT-5.3 Codex Spark",
      "contextWindow": 128000,
      "maxOutput": 32000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1.75,
        "output": 14
      },
      "releaseDate": "2026-02-05"
    },
    {
      "provider": "openai",
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2.5,
        "output": 15
      },
      "releaseDate": "2026-03-05"
    },
    {
      "provider": "openai",
      "id": "gpt-5.4-mini",
      "name": "GPT-5.4 mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.75,
        "output": 4.5
      },
      "releaseDate": "2026-03-17"
    },
    {
      "provider": "openai",
      "id": "gpt-5.4-nano",
      "name": "GPT-5.4 nano",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.2,
        "output": 1.25
      },
      "releaseDate": "2026-03-17"
    },
    {
      "provider": "openai",
      "id": "gpt-5.4-pro",
      "name": "GPT-5.4 Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 30,
        "output": 180
      },
      "releaseDate": "2026-03-05"
    },
    {
      "provider": "openai",
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 30
      },
      "releaseDate": "2026-04-23"
    },
    {
      "provider": "openai",
      "id": "gpt-5.5-pro",
      "name": "GPT-5.5 Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 30,
        "output": 180
      },
      "releaseDate": "2026-04-23"
    },
    {
      "provider": "openai",
      "id": "gpt-5.6",
      "name": "GPT-5.6",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 30
      },
      "releaseDate": "2026-07-09"
    },
    {
      "provider": "openai",
      "id": "gpt-5.6-luna",
      "name": "GPT-5.6 Luna",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 0.2,
        "output": 1.2
      },
      "releaseDate": "2026-07-09"
    },
    {
      "provider": "openai",
      "id": "gpt-5.6-sol",
      "name": "GPT-5.6 Sol",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 5,
        "output": 30
      },
      "releaseDate": "2026-07-09"
    },
    {
      "provider": "openai",
      "id": "gpt-5.6-terra",
      "name": "GPT-5.6 Terra",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 12
      },
      "releaseDate": "2026-07-09"
    },
    {
      "provider": "openai",
      "id": "gpt-image-1",
      "name": "gpt-image-1",
      "contextWindow": 0,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2025-04-24"
    },
    {
      "provider": "openai",
      "id": "gpt-image-1-mini",
      "name": "gpt-image-1-mini",
      "contextWindow": 0,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2025-09-26"
    },
    {
      "provider": "openai",
      "id": "gpt-image-1.5",
      "name": "gpt-image-1.5",
      "contextWindow": 0,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "releaseDate": "2025-11-25"
    },
    {
      "provider": "openai",
      "id": "gpt-image-2",
      "name": "gpt-image-2",
      "contextWindow": 0,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 30
      },
      "releaseDate": "2026-04-21"
    },
    {
      "provider": "openai",
      "id": "gpt-realtime-2.1",
      "name": "GPT-Realtime-2.1",
      "contextWindow": 128000,
      "maxOutput": 32000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "audio",
        "image"
      ],
      "cost": {
        "input": 4,
        "output": 24
      },
      "releaseDate": "2026-07-06"
    },
    {
      "provider": "openai",
      "id": "o1",
      "name": "o1",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 15,
        "output": 60
      },
      "releaseDate": "2024-12-05"
    },
    {
      "provider": "openai",
      "id": "o1-pro",
      "name": "o1-pro",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 150,
        "output": 600
      },
      "releaseDate": "2025-03-19"
    },
    {
      "provider": "openai",
      "id": "o3",
      "name": "o3",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 8
      },
      "releaseDate": "2025-04-16"
    },
    {
      "provider": "openai",
      "id": "o3-mini",
      "name": "o3-mini",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1.1,
        "output": 4.4
      },
      "releaseDate": "2024-12-20"
    },
    {
      "provider": "openai",
      "id": "o3-pro",
      "name": "o3-pro",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 20,
        "output": 80
      },
      "releaseDate": "2025-06-10"
    },
    {
      "provider": "openai",
      "id": "o4-mini",
      "name": "o4-mini",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.1,
        "output": 4.4
      },
      "releaseDate": "2025-04-16"
    },
    {
      "provider": "openai",
      "id": "text-embedding-3-large",
      "name": "text-embedding-3-large",
      "contextWindow": 8191,
      "maxOutput": 3072,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.13,
        "output": 0
      },
      "releaseDate": "2024-01-25"
    },
    {
      "provider": "openai",
      "id": "text-embedding-3-small",
      "name": "text-embedding-3-small",
      "contextWindow": 8191,
      "maxOutput": 1536,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.02,
        "output": 0
      },
      "releaseDate": "2024-01-25"
    },
    {
      "provider": "openai",
      "id": "text-embedding-ada-002",
      "name": "text-embedding-ada-002",
      "contextWindow": 8192,
      "maxOutput": 1536,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.1,
        "output": 0
      },
      "releaseDate": "2022-12-15"
    },
    {
      "provider": "upstage",
      "id": "solar-mini",
      "name": "solar-mini",
      "contextWindow": 32768,
      "maxOutput": 4096,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.15,
        "output": 0.15
      },
      "releaseDate": "2024-06-12"
    },
    {
      "provider": "upstage",
      "id": "solar-pro2",
      "name": "solar-pro2",
      "contextWindow": 65536,
      "maxOutput": 8192,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "minimal",
        "high"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.25,
        "output": 0.25
      },
      "releaseDate": "2025-05-20"
    },
    {
      "provider": "upstage",
      "id": "solar-pro3",
      "name": "solar-pro3",
      "contextWindow": 131072,
      "maxOutput": 8192,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.25,
        "output": 0.25
      },
      "releaseDate": "2026-01"
    },
    {
      "provider": "upstage",
      "id": "solar-pro4",
      "name": "Solar Pro 4",
      "contextWindow": 524288,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.3,
        "output": 1.2
      },
      "releaseDate": "2026-08-06"
    },
    {
      "provider": "xai",
      "id": "grok-4.20-0309-non-reasoning",
      "name": "Grok 4.20 (Non-Reasoning)",
      "contextWindow": 1000000,
      "maxOutput": 30000,
      "toolCall": true,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1.25,
        "output": 2.5
      },
      "releaseDate": "2026-03-09"
    },
    {
      "provider": "xai",
      "id": "grok-4.20-0309-reasoning",
      "name": "Grok 4.20 (Reasoning)",
      "contextWindow": 1000000,
      "maxOutput": 30000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1.25,
        "output": 2.5
      },
      "releaseDate": "2026-03-09"
    },
    {
      "provider": "xai",
      "id": "grok-4.20-multi-agent-0309",
      "name": "Grok 4.20 Multi-Agent",
      "contextWindow": 1000000,
      "maxOutput": 30000,
      "toolCall": false,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1.25,
        "output": 2.5
      },
      "releaseDate": "2026-03-09"
    },
    {
      "provider": "xai",
      "id": "grok-4.3",
      "name": "Grok 4.3",
      "contextWindow": 1000000,
      "maxOutput": 30000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1.25,
        "output": 2.5
      },
      "releaseDate": "2026-04-17"
    },
    {
      "provider": "xai",
      "id": "grok-4.5",
      "name": "Grok 4.5",
      "contextWindow": 500000,
      "maxOutput": 500000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 6
      },
      "releaseDate": "2026-07-08"
    },
    {
      "provider": "xai",
      "id": "grok-4.6",
      "name": "Grok 4.6",
      "contextWindow": 500000,
      "maxOutput": 500000,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 2,
        "output": 6
      },
      "releaseDate": "2026-08-12"
    },
    {
      "provider": "xai",
      "id": "grok-build-0.1",
      "name": "Grok Build 0.1",
      "contextWindow": 256000,
      "maxOutput": 256000,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "cost": {
        "input": 1,
        "output": 2
      },
      "releaseDate": "2026-04-16"
    },
    {
      "provider": "xai",
      "id": "grok-imagine-image",
      "name": "Grok Imagine Image",
      "contextWindow": 8000,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "releaseDate": "2026-01-28"
    },
    {
      "provider": "xai",
      "id": "grok-imagine-image-quality",
      "name": "Grok Imagine Image Quality",
      "contextWindow": 8000,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "pdf"
      ],
      "releaseDate": "2026-04-03"
    },
    {
      "provider": "xai",
      "id": "grok-imagine-video",
      "name": "Grok Imagine Video",
      "contextWindow": 1024,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "video",
        "pdf"
      ],
      "releaseDate": "2026-01-28"
    },
    {
      "provider": "xai",
      "id": "grok-imagine-video-1.5",
      "name": "Grok Imagine Video 1.5",
      "contextWindow": 1024,
      "maxOutput": 0,
      "toolCall": false,
      "reasoning": false,
      "inputModalities": [
        "text",
        "image",
        "audio",
        "pdf"
      ],
      "releaseDate": "2026-05-30"
    },
    {
      "provider": "zai-coding-plan",
      "id": "glm-4.7",
      "name": "GLM-4.7",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2025-12-22"
    },
    {
      "provider": "zai-coding-plan",
      "id": "glm-5-turbo",
      "name": "GLM-5-Turbo",
      "contextWindow": 200000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-03-16"
    },
    {
      "provider": "zai-coding-plan",
      "id": "glm-5.2",
      "name": "GLM-5.2",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "high",
        "max"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-06-13"
    },
    {
      "provider": "zai-coding-plan",
      "id": "glm-5.2-highspeed",
      "name": "GLM-5.2 Highspeed",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "high",
        "max"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-06-13"
    },
    {
      "provider": "zai-coding-plan",
      "id": "glm-5.3",
      "name": "GLM-5.3",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-08-14"
    },
    {
      "provider": "zai",
      "id": "glm-4.5",
      "name": "GLM-4.5",
      "contextWindow": 131072,
      "maxOutput": 98304,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.2
      },
      "releaseDate": "2025-07-28"
    },
    {
      "provider": "zai",
      "id": "glm-4.5-air",
      "name": "GLM-4.5-Air",
      "contextWindow": 131072,
      "maxOutput": 98304,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.2,
        "output": 1.1
      },
      "releaseDate": "2025-07-28"
    },
    {
      "provider": "zai",
      "id": "glm-4.5-flash",
      "name": "GLM-4.5-Flash",
      "contextWindow": 131072,
      "maxOutput": 98304,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2025-07-28"
    },
    {
      "provider": "zai",
      "id": "glm-4.5v",
      "name": "GLM-4.5V",
      "contextWindow": 64000,
      "maxOutput": 16384,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0.6,
        "output": 1.8
      },
      "releaseDate": "2025-08-11"
    },
    {
      "provider": "zai",
      "id": "glm-4.6",
      "name": "GLM-4.6",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.2
      },
      "releaseDate": "2025-09-30"
    },
    {
      "provider": "zai",
      "id": "glm-4.6v",
      "name": "GLM-4.6V",
      "contextWindow": 128000,
      "maxOutput": 32768,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video"
      ],
      "cost": {
        "input": 0.3,
        "output": 0.9
      },
      "releaseDate": "2025-12-08"
    },
    {
      "provider": "zai",
      "id": "glm-4.7",
      "name": "GLM-4.7",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.2
      },
      "releaseDate": "2025-12-22"
    },
    {
      "provider": "zai",
      "id": "glm-4.7-flash",
      "name": "GLM-4.7-Flash",
      "contextWindow": 200000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0
      },
      "releaseDate": "2026-01-19"
    },
    {
      "provider": "zai",
      "id": "glm-4.7-flashx",
      "name": "GLM-4.7-FlashX",
      "contextWindow": 200000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 0.07,
        "output": 0.4
      },
      "releaseDate": "2026-01-19"
    },
    {
      "provider": "zai",
      "id": "glm-5",
      "name": "GLM-5",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1,
        "output": 3.2
      },
      "releaseDate": "2026-02-12"
    },
    {
      "provider": "zai",
      "id": "glm-5-turbo",
      "name": "GLM-5-Turbo",
      "contextWindow": 200000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1.2,
        "output": 4
      },
      "releaseDate": "2026-03-16"
    },
    {
      "provider": "zai",
      "id": "glm-5.1",
      "name": "GLM-5.1",
      "contextWindow": 200000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1.4,
        "output": 4.4
      },
      "releaseDate": "2026-04-07"
    },
    {
      "provider": "zai",
      "id": "glm-5.2",
      "name": "GLM-5.2",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "reasoningEfforts": [
        "high",
        "max"
      ],
      "inputModalities": [
        "text"
      ],
      "cost": {
        "input": 1.4,
        "output": 4.4
      },
      "releaseDate": "2026-06-13"
    },
    {
      "provider": "zai",
      "id": "glm-5v-turbo",
      "name": "GLM-5V-Turbo",
      "contextWindow": 200000,
      "maxOutput": 131072,
      "toolCall": true,
      "reasoning": true,
      "inputModalities": [
        "text",
        "image",
        "video",
        "pdf"
      ],
      "cost": {
        "input": 1.2,
        "output": 4
      },
      "releaseDate": "2026-04-01"
    }
  ]
};
