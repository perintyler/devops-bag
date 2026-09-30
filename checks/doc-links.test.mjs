/**
 * A link resolves to what the checkout tracks, not to whatever sits on disk.
 *
 * Twice an ignored leftover (an old package's node_modules, at adapters/llms
 * and then adapters/agents) kept a dead link green here while a fresh clone
 * had nothing at that path. Each case builds its own repository, so a check
 * that stopped looking would fail the positive case too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(import.meta.dirname, "doc-links.mjs");

/** A repository with `files` committed, and anything under gone/ on disk but ignored. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "doc-links-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, ".gitignore"), "gone/\n");
  mkdirSync(join(dir, "gone", "package", "node_modules"), { recursive: true });
  writeFileSync(join(dir, "gone", "package", "node_modules", "left.txt"), "residue\n");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git("add", "-A");
  return dir;
}

const check = (dir) => spawnSync(process.execPath, [CHECK], { cwd: dir, encoding: "utf8" });

test("a link to a tracked file passes", () => {
  const r = check(repo({ "README.md": "See [the code](src/main.ts).\n", "src/main.ts": "export {};\n" }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK \(1 markdown file/);
});

test("a link into an ignored leftover fails, though the path exists on disk", () => {
  const r = check(repo({ "README.md": "See [the old package](gone/package/).\n" }));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout + r.stderr, /README\.md:1 {2}broken link -> gone\/package\//);
});

test("a path named in backticks inside an ignored leftover is stale", () => {
  const r = check(repo({ "README.md": "It lived in `gone/package`.\n" }));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout + r.stderr, /stale path reference -> gone\/package/);
});
