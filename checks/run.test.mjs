import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const runner = join(import.meta.dirname, "run.mjs");
test("the runner checks its explicit checkout and propagates a violation", () => {
  const repo = mkdtempSync(join(tmpdir(), "devops-target-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git("init", "--quiet");
    writeFileSync(join(repo, "workspace-entries.json"), "{}");
    mkdirSync(join(repo, "builtin/alpha/src"), { recursive: true });
    writeFileSync(join(repo, "builtin/alpha/bag.yaml"), "name: alpha\n");
    const source = join(repo, "builtin/alpha/src/db.ts");
    writeFileSync(source, 'bagDataDir("alpha");\n');
    for (const file of ["builtin/telemetry/src/usage/stores.ts", "builtin/sessions/api/src/telemetry.ts", "builtin/embeddings/src/db.ts"]) {
      const path = join(repo, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, 'bagDataDir("other");\n');
    }
    git("add", ".");
    const run = () => spawnSync(process.execPath, [runner, repo, "check:bag-data-dirs"], { cwd: tmpdir(), encoding: "utf8" });
    const own = run();
    assert.equal(own.status, 0, own.stderr);
    assert.match(own.stdout, /4 bagDataDir calls/);
    writeFileSync(source, 'bagDataDir("sessions");\n');
    const violation = run();
    assert.equal(violation.status, 1, violation.stdout);
    assert.match(violation.stderr, /from bag "alpha"/);
    assert.match(violation.stderr, /builtin\/alpha\/src\/db.ts/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a missing checkout and an unknown task fail", () => {
  const missing = spawnSync(process.execPath, [runner, tmpdir(), "check:monorepo"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Barry checkout/);
  const repo = mkdtempSync(join(tmpdir(), "devops-unknown-"));
  try {
    writeFileSync(join(repo, "workspace-entries.json"), "{}");
    const unknown = spawnSync(process.execPath, [runner, repo, "unknown"], { encoding: "utf8" });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown check task/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unit discovery forwards scopes and refuses an empty selection", () => {
  const repo = mkdtempSync(join(tmpdir(), "devops-discovery-"));
  try {
    mkdirSync(join(repo, "sdk/example"), { recursive: true });
    writeFileSync(join(repo, "workspace-entries.json"), '{"sdk/example":{}}');
    writeFileSync(join(repo, "sdk/example/package.json"), '{"scripts":{"test":"vitest run"}}');
    const run = (...args) => spawnSync(process.execPath, [runner, repo, "test:ci:unit", "--list", ...args], { cwd: tmpdir(), encoding: "utf8" });
    const sdk = run("--scope=sdk");
    assert.equal(sdk.status, 0, sdk.stderr);
    assert.match(sdk.stdout, /sdk\/example\ttest/);
    const missing = run("--scope=missing");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /matched no workspace/);
    writeFileSync(join(repo, "workspace-entries.json"), '{}');
    assert.equal(run().status, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
