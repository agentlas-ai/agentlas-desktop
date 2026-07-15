#!/usr/bin/env node
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = new Map(process.argv.slice(3).map((arg) => {
  const [key, ...value] = arg.split("=");
  return [key, value.join("=") || "1"];
}));
const action = process.argv[2];
const file = resolve(String(args.get("--file") || ""));
const officialTarget = "/Applications/Agentlas.app";

function validate(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.target !== officialTarget ||
    typeof value.stage !== "string" ||
    !/^\/Applications\/\.agentlas-install-stage\.[A-Za-z0-9]+\/Agentlas\.app$/.test(value.stage) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) ||
    typeof value.hadExisting !== "boolean" ||
    !["prepared", "swapped"].includes(value.phase)
  ) {
    throw new Error("invalid macOS install transaction journal");
  }
  return value;
}
function atomicWrite(value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    const directoryFd = openSync(dirname(file), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

if (!file) throw new Error("--file is required");
if (action === "write") {
  const value = validate({
    schemaVersion: 1,
    target: officialTarget,
    stage: resolve(String(args.get("--stage") || "")),
    version: String(args.get("--version") || ""),
    hadExisting: args.get("--had-existing") === "true",
    phase: String(args.get("--phase") || ""),
  });
  atomicWrite(value);
} else if (action === "read") {
  const value = validate(JSON.parse(readFileSync(file, "utf8")));
  process.stdout.write(`${[value.stage, value.version, value.hadExisting ? "1" : "0", value.phase].join("\t")}\n`);
} else if (action === "clear") {
  rmSync(file, { force: true });
} else if (action === "exists") {
  process.exit(existsSync(file) ? 0 : 1);
} else {
  throw new Error("action must be write, read, clear, or exists");
}
