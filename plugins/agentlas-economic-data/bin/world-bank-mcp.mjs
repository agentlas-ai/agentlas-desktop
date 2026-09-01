#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import {
  EconomicDataError,
  createEconomicDataClient,
} from "../runtime/world-bank-client.mjs";

const toolsDocument = JSON.parse(readFileSync(new URL("../schemas/tools.json", import.meta.url), "utf8"));
const capabilities = JSON.parse(readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"));

const toolDefinitions = toolsDocument.tools.map((tool) => {
  if (tool.outputSchema?.$ref === "#/$defs/indicatorResult") {
    return { ...tool, outputSchema: toolsDocument.$defs.indicatorResult };
  }
  return tool;
});

function textContent(value) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function ensureRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0") {
    throw new EconomicDataError("INVALID_RPC_REQUEST", "JSON-RPC request must be a 2.0 object");
  }
  if (typeof request.method !== "string") {
    throw new EconomicDataError("INVALID_RPC_REQUEST", "JSON-RPC request method is required");
  }
}

function strictEmptyArguments(value) {
  const args = value ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0) {
    throw new EconomicDataError(
      "INVALID_INPUT",
      "describe_economic_data_capabilities accepts an empty object only",
      { details: { fields: args && typeof args === "object" ? Object.keys(args) : [] } },
    );
  }
}

export function createMcpHandler(options = {}) {
  const client = options.client ?? createEconomicDataClient(options.clientOptions);

  return async function handleMcpRequest(request) {
    ensureRequest(request);
    const id = request.id;
    const notification = id === undefined;

    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
      return null;
    }
    if (notification) return null;

    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agentlas-economic-data", version: "1.0.0" },
          instructions: "Fetch one bounded World Bank indicator series or describe this server's exact capability contract.",
        },
      };
    }

    if (request.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: toolDefinitions } };
    }

    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      try {
        let result;
        if (name === "describe_economic_data_capabilities") {
          strictEmptyArguments(args);
          result = capabilities;
        } else if (name === "fetch_world_bank_indicator") {
          result = await client.fetchWorldBankIndicator(args);
        } else {
          throw new EconomicDataError("TOOL_NOT_FOUND", "Unknown economic data tool", {
            details: { name: typeof name === "string" ? name : null },
          });
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent(result),
            structuredContent: result,
            isError: false,
          },
        };
      } catch (error) {
        const structured = error instanceof EconomicDataError
          ? error.toJSON()
          : new EconomicDataError("INTERNAL_ERROR", "Economic data tool failed", { cause: error }).toJSON();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent({ error: structured }),
            structuredContent: { error: structured },
            isError: true,
          },
        };
      }
    }

    return rpcError(id, -32601, "Method not found", { method: request.method });
  };
}

export async function runStdioServer({ input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler();
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();

  lines.on("line", (line) => {
    if (line.trim() === "") return;
    queue = queue.then(async () => {
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        output.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
        return;
      }
      try {
        const response = await handle(request);
        if (response !== null) output.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        const data = error instanceof EconomicDataError ? error.toJSON() : undefined;
        output.write(`${JSON.stringify(rpcError(request?.id, -32600, "Invalid Request", data))}\n`);
      }
    });
  });

  await new Promise((resolve, reject) => {
    lines.once("close", resolve);
    lines.once("error", reject);
  });
  await queue;
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) {
  runStdioServer().catch((error) => {
    process.stderr.write(`agentlas-economic-data MCP server failed: ${error?.message ?? "unknown error"}\n`);
    process.exitCode = 1;
  });
}
