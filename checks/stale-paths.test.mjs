import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleImport = (name) => `import { value } from "./${name}.mjs";\n`;

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "stale-paths-cache-"));
  const put = (root, file, text) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(repo, "init", "-q");
  put(repo, ".gitignore", "node_modules/\n");
  put(repo, "sdk/lib/src/services/home.mjs", 'export const barryAppSupportDir = () => "/nonexistent-instance";\n');
  put(repo, "sdk/cli/src/index.ts", "export {};\n");
  put(repo, "sdk/cli/bin/barry", '#!/bin/sh\nnode "$BARRY_DIR/sdk/cli/src/index.ts"\n');
  put(repo, ".github/ci/run.mjs", moduleImport("support"));
  put(repo, ".github/ci/support.mjs", "export {};\n");
  git(repo, "add", ".");
  const cache = join(repo, "node_modules/.cache/devops");
  mkdirSync(cache, { recursive: true });
  git(cache, "init", "-q");
  for (const file of ["stale-paths.mjs", "tracked-paths.mjs"]) {
    copyFileSync(join(import.meta.dirname, file), join(cache, file));
  }
  put(cache, ".gitignore", "untracked.mjs\n");
  git(cache, "add", ".");
  const run = () => spawnSync(process.execPath, [join(cache, "stale-paths.mjs")], {
    cwd: repo, encoding: "utf8", env: { ...process.env, BARRY_BAGS_SNAPSHOT: join(repo, "absent.json") },
  });
  return { repo, cache, put, run };
}

test("cached checks validate their own tracked imports and the relocated launcher", () => {
  const f = fixture();
  try {
    const healthy = f.run();
    assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
    execFileSync("git", ["rm", "--cached", ".github/ci/support.mjs"], { cwd: f.repo, stdio: "ignore" });
    const missing = f.run();
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /\.github\/ci\/run\.mjs.*support\.mjs/);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("an ignored leftover in the cached checks does not satisfy an import", () => {
  const f = fixture();
  try {
    f.put(f.cache, "untracked.mjs", "export {};\n");
    f.put(f.cache, "consumer.mjs", moduleImport("untracked"));
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /consumer\.mjs.*untracked\.mjs.*not tracked/);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});
