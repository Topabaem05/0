import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DSH_PURGE_PACKAGE,
  DEFAULT_MCP_TOOLS,
  UsageError,
  assertRequestedEnvironment,
  buildDshArgs,
  buildDshPurgeRows,
  buildMcpArgs,
  buildProfilePatch,
  parseRunnerArgs,
  runRunner,
} from "./dsh-0-mcp.mjs";

const baseArgs = [
  "--target", "https://example.test",
  "--scan-id", "scan-123",
  "--scope", "scope.json",
  "Use only 0 MCP tools.",
];

test("DSH runner requires an explicitly scoped target and one task", () => {
  assert.throws(
    () => parseRunnerArgs(["--target", "https://example.test", "--scan-id", "scan-123", "task"]),
    UsageError,
  );
  assert.throws(
    () => parseRunnerArgs([...baseArgs, "unexpected"]),
    /exactly one non-empty headless task/,
  );
});

test("DSH runner defaults to the bounded recon tool set", () => {
  const options = parseRunnerArgs(baseArgs, "/workspace");
  assert.equal(options.mcpTools, DEFAULT_MCP_TOOLS);
  assert.deepEqual(
    buildMcpArgs(options, "/opt/0/dist/0.js").slice(-2),
    ["--tools", DEFAULT_MCP_TOOLS],
  );
});

test("DSH runner preserves 0 engagement arguments", () => {
  const options = parseRunnerArgs([
    "--target", "https://example.test",
    "--scan-id", "scan-123",
    "--scope", "scope.json",
    "--db-path", "runs/scan.sqlite",
    "--timeout", "45000",
    "--rate-limit", "example.test=1",
    "--mcp-tools", "http_request,crawl",
    "--engagement-profile", "conservative",
    "--allow-scanners",
    "--no-waf-evasion",
    "--mcp-env", "ZERO_MCP_AUTH_JSON",
    "--mcp-env", "ZERO_MCP_AUTH_JSON",
    "Use only 0 MCP tools.",
  ], "/workspace");

  assert.equal(options.scope, "/workspace/scope.json");
  assert.equal(options.dbPath, "/workspace/runs/scan.sqlite");
  assert.deepEqual(options.mcpEnv, ["ZERO_MCP_AUTH_JSON"]);
  assert.deepEqual(
    buildMcpArgs(options, "/opt/0/dist/0.js"),
    [
      "/opt/0/dist/0.js",
      "mcp-server",
      "--target", "https://example.test",
      "--scan-id", "scan-123",
      "--scope", "/workspace/scope.json",
      "--db-path", "/workspace/runs/scan.sqlite",
      "--timeout", "45000",
      "--rate-limit", "example.test=1",
      "--tools", "http_request,crawl",
      "--engagement-profile", "conservative",
      "--allow-scanners",
      "--no-waf-evasion",
    ],
  );
});


test("dsh-purge harness plugin is off unless requested", () => {
  const options = parseRunnerArgs(baseArgs, "/workspace");
  assert.equal(options.withDshPurge, false);
  assert.equal(options.dshPurgePackage, DEFAULT_DSH_PURGE_PACKAGE);

  const patch = buildProfilePatch({
    entrypoint: "/opt/0/dist/0.js",
    serverCwd: "/opt/0",
    mcpArgs: buildMcpArgs(options, "/opt/0/dist/0.js"),
    mcpEnv: [],
  });
  assert.equal(patch.includes("dsh-purge"), false);
  assert.equal(patch.includes("system-prompt"), false);
});

test("--with-dsh-purge mounts the dsh-purge rows ahead of the 0 MCP client", () => {
  const options = parseRunnerArgs([...baseArgs.slice(0, -1), "--with-dsh-purge", baseArgs.at(-1)], "/workspace");
  assert.equal(options.withDshPurge, true);

  const patch = buildProfilePatch({
    entrypoint: "/opt/0/dist/0.js",
    serverCwd: "/opt/0",
    mcpArgs: buildMcpArgs(options, "/opt/0/dist/0.js"),
    mcpEnv: [],
    withDshPurge: options.withDshPurge,
    dshPurgePackage: options.dshPurgePackage,
  });

  assert.match(patch, /- id: dsh-purge\n\s+name: "dsh-purge-community"\n\s+inject: \[systemPrompt, tools\]/);
  assert.match(patch, /name: "dsh-purge-community\/presets-plugin"/);
  assert.match(patch, /autoApplyOnStart: false/);
  assert.match(patch, /autoUpdateOnStart: false/);
  assert.ok(patch.indexOf("id: dsh-purge") < patch.indexOf("id: mcp-0"));
  // The 0-only tool boundary stays in place with the plugin mounted.
  assert.match(patch, /- id: tool-bash\n  disabled: true/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
});

test("dsh-purge package name can be overridden but must be a package name", () => {
  const options = parseRunnerArgs([
    ...baseArgs.slice(0, -1),
    "--with-dsh-purge",
    "--dsh-purge-package", "@scope/dsh-purge-fork",
    baseArgs.at(-1),
  ], "/workspace");
  assert.equal(options.dshPurgePackage, "@scope/dsh-purge-fork");
  assert.match(buildDshPurgeRows(options.dshPurgePackage), /name: "@scope\/dsh-purge-fork\/presets-plugin"/);

  assert.throws(
    () => parseRunnerArgs([...baseArgs.slice(0, -1), "--dsh-purge-package", "dsh-purge", baseArgs.at(-1)]),
    /requires --with-dsh-purge/,
  );
  assert.throws(
    () => parseRunnerArgs([...baseArgs.slice(0, -1), "--with-dsh-purge", "--dsh-purge-package", "../evil: x", baseArgs.at(-1)]),
    /npm package name/,
  );
  assert.throws(() => buildDshPurgeRows("not a package"), UsageError);
});

test("DSH invocation stays a one-shot headless profile command", () => {
  assert.deepEqual(
    buildDshArgs("/tmp/0-mcp.patch.yml", "Use only 0 MCP tools."),
    [
      "--profile",
      "headless",
      "--patch",
      "/tmp/0-mcp.patch.yml",
      "Use only 0 MCP tools.",
    ],
  );
});

test("explicit child environment variables must exist", () => {
  assert.doesNotThrow(() => assertRequestedEnvironment(["ZEROSEC_TOKEN"], { ZEROSEC_TOKEN: "value" }));
  assert.throws(
    () => assertRequestedEnvironment(["ZEROSEC_TOKEN"], {}),
    /ZEROSEC_TOKEN was requested but is not set/,
  );
});

test("invalid child environment names are rejected", () => {
  assert.throws(
    () => parseRunnerArgs([...baseArgs.slice(0, -1), "--mcp-env", "ZERO-BAD", baseArgs.at(-1)]),
    /environment-variable name/,
  );
});

test("runner gives DSH a private patch and removes it after the one-shot", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "0-dsh-runner-test-"));
  const entrypoint = join(fixture, "0.js");
  const scope = join(fixture, "scope.json");
  const observed = join(fixture, "observed.json");
  const dsh = join(fixture, "dsh.mjs");

  try {
    await writeFile(entrypoint, "");
    await writeFile(scope, "{\"in_scope\":[\"example.test\"]}");
    await writeFile(
      dsh,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "--profile" || args[1] !== "headless" || args[2] !== "--patch" || args.length !== 5) {
  process.exit(23);
}
const patchPath = args[3];
if (!existsSync(patchPath)) process.exit(24);
const patch = readFileSync(patchPath, "utf8");
if (!patch.includes("name: '@deepseek-ai/dsh-mcp-client'") || !patch.includes("--scan-id")) {
  process.exit(25);
}
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ args, patchPath }));
`,
      { mode: 0o700 },
    );
    await chmod(dsh, 0o700);

    const exitCode = await runRunner([
      "--target", "https://example.test",
      "--scan-id", "scan-123",
      "--scope", scope,
      "--entrypoint", entrypoint,
      "--dsh-bin", dsh,
      "Use only 0 MCP tools.",
    ]);

    assert.equal(exitCode, 0);
    const result = JSON.parse(await readFile(observed, "utf8"));
    assert.deepEqual(result.args.slice(0, 3), ["--profile", "headless", "--patch"]);
    assert.equal(result.args.at(-1), "Use only 0 MCP tools.");
    assert.equal(existsSync(result.patchPath), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
