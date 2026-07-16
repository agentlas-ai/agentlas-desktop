// Pin the browser host. Resolving `latest` on every agent run caused startup
// drift, repeated npx downloads, and different behavior between long-lived
// Agentlas processes. Update this deliberately with browser regression QA.
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.78";
