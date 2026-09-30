/**
 * The check goes red on a vendor's name and on an empty file list, and stays
 * green on the policy's own words. Each case names its file explicitly, so a
 * check that silently scanned nothing would fail here too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(import.meta.dirname, "vendor-neutral.mjs");
const dir = mkdtempSync(join(tmpdir(), "vendor-neutral-"));

function run(source) {
  const file = join(dir, `planted-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  return spawnSync(process.execPath, [CHECK, file], { encoding: "utf8" });
}

for (const word of ["Tailscale", "tailnet", "Caddy", "cloudflared", "lists.barry.lan"]) {
  test(`naming ${word} fails`, () => {
    const r = run(`// served at ${word} for now\n`);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /mention\(s\) of a hosting vendor/);
  });
}

test("the policy's own words, the product site and Cloudflare the platform pass", () => {
  const r = run(`// a local name, a private tunnel, barry.rocks, a Cloudflare Worker\n`);
  assert.equal(r.status, 0, r.stderr);
});

test("an empty file list fails rather than passing on nothing", () => {
  const list = join(dir, "empty-list");
  writeFileSync(list, "");
  const r = spawnSync(process.execPath, [CHECK, "--list", list], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /scanned ZERO files/);
});
