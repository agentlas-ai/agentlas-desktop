"use strict";

// The Agentlas Science host loads this exact path with CommonJS require().
// The implementation remains single-sourced in the sibling ESM module; the
// bundled Node runtime supports synchronous require() of ESM without top-level
// await, so both entry points expose the same function and error identities.
const runtime = require("./world-bank-client.mjs");

module.exports = {
  APPROVED_AGGREGATE_CODES: runtime.APPROVED_AGGREGATE_CODES,
  EconomicDataError: runtime.EconomicDataError,
  WORLD_BANK_BASE_URL: runtime.WORLD_BANK_BASE_URL,
  WORLD_BANK_HOST: runtime.WORLD_BANK_HOST,
  buildWorldBankUrl: runtime.buildWorldBankUrl,
  normalizeWorldBankResponse: runtime.normalizeWorldBankResponse,
  createEconomicDataClient: runtime.createEconomicDataClient,
};
