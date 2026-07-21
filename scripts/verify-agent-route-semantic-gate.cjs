#!/usr/bin/env node
// Regression for local semantic agent routing (v0.8.63).
// Café beta finding (betatester/03-audit/official-v2-cut-feedback.md #6): a local
// café restock draft was mis-routed to "Meme Shorts Studio" because One's local
// selection used a bag-of-words lexical scorer with no semantic discrimination.
//
// selectAutoRoutedAgent now applies the on-device multilingual model as a
// PRECISION VETO over lexical recruitment: an agent the lexical scorer picked via
// incidental keyword overlap is dropped unless the local model is semantically
// confident about it. We inject that verdict so the decision is deterministic
// without shipping the model asset into CI.
//
// Run: npm run build:electron && node scripts/verify-agent-route-semantic-gate.cjs
const assert = require("node:assert/strict");
const { selectAutoRoutedAgent } = require("../dist/electron/agents/auto-router.js");

function agent(id, name, systemPrompt) {
  return { id, slug: id, name, nameEn: name, tagline: "", taglineEn: "", systemPrompt, mcpServers: [], envRequirements: [], kind: "single", visibility: "normal" };
}

// meme shares enough incidental café tokens to clear the lexical bar — this is
// exactly how the real mis-route happened.
const meme = agent(
  "meme-shorts-studio",
  "Meme Shorts Studio",
  "Meme Shorts Studio makes local markdown draft plans and restock notes for cafe short-form videos.",
);
const copywriter = agent(
  "cafe-copywriter",
  "Counter Copywriter",
  "Writes local cafe restock draft notes in markdown for the counter sign of a small coffee shop.",
);

const cafePrompt = "Make one local markdown cafe restock draft. Keep it local, nothing else.";
const active = (ids) => () => ({ activeModel: true, eligibleIds: new Set(ids) });
const inactive = () => ({ activeModel: false, eligibleIds: new Set() });

// Control: with the model OFF, meme DOES clear the lexical bar and routes — this
// proves the null in the next case is the semantic veto, not a low lexical score.
const control = selectAutoRoutedAgent(cafePrompt, [meme], "en", { allowFallback: false, semanticRoute: inactive });
assert.ok(control && control.agent.id === "meme-shorts-studio", "control: meme is lexically eligible with the model off");

// 1) Model ON, meme not semantically eligible → veto the mis-route → stay solo.
assert.equal(
  selectAutoRoutedAgent(cafePrompt, [meme], "en", { allowFallback: false, semanticRoute: active([]) }),
  null,
  "café draft must not be mis-routed to an unrelated studio",
);

// 2) Model ON, a relevant specialist IS eligible → route to it, skipping the
//    lexically-strong but semantically-vetoed studio.
const routed = selectAutoRoutedAgent(cafePrompt, [meme, copywriter], "en", { allowFallback: false, semanticRoute: active(["cafe-copywriter"]) });
assert.ok(routed && routed.agent.id === "cafe-copywriter", "an eligible café specialist must be routed, not the studio");

// 3) Explicit intent (the user names the agent) overrides the semantic veto.
const named = selectAutoRoutedAgent("Use Meme Shorts Studio to cut my clip into a short", [meme], "en", { allowFallback: false, semanticRoute: active([]) });
assert.ok(named && named.agent.id === "meme-shorts-studio", "an explicitly named agent must still route");

// 4) Model ON, nothing eligible, fallback allowed → the coordinator, never the
//    vetoed studio.
const pmSoul = agent("agentlas-pm-soul", "Project Coordinator", "Coordinate work and plan next steps.");
const fell = selectAutoRoutedAgent(cafePrompt, [meme, pmSoul], "en", { allowFallback: true, semanticRoute: active([]) });
assert.ok(fell && fell.agent.id === "agentlas-pm-soul", "fallback must be the coordinator, not a mis-routed studio");

process.stdout.write(`${JSON.stringify({ ok: true, semanticVeto: true, cases: 5 })}\n`);
