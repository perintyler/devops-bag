#!/usr/bin/env node
/**
 * Fails where Barry's own repo names a hosting vendor.
 *
 * Hosting is installation policy (`~/.config/barry/hosting.yaml`), carried out
 * by provider bags that live in their own repositories: `caddy` for local
 * names, `tailscale-sidecar` and `cloudflare` for tunnels. Core speaks only in
 * the policy's own words (`local`, `tunnels`, `reach`, `gate`), so an install
 * that uses none of those vendors carries none of their code, config or
 * assumptions. Core used to know one installation's Caddy, tailnet and
 * `barry.lan` domain by name; this keeps that from creeping back.
 *
 * `barry.rocks` (the product's own site) and Cloudflare the platform are not
 * banned: they are not how an installation is hosted.
 *
 * An exception names a file and the exact strings it may hold, with the reason.
 * An exception whose file or string is gone fails too, so the list cannot
 * outlive what it excuses.
 *
 * Usage: node checks/vendor-neutral.mjs [--list <file of paths>] [file...]
 * With files (or a list), checks exactly those; without, every tracked file
 * outside plans/ (dated design records). Scanning nothing fails.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BANNED = /tailscale|tailnet|caddy|cloudflared|barry\.lan/i;

/** Files this check and its test must name the words to do their job. */
const SELF = new Set([]);

const EXCEPTIONS = [
  {
    file: "sdk/cli/src/setup/launchd.ts",
    strings: ["com.barry.caddy", "com.barry.cloudflared", "com.barry.bag.tailscale-sidecar.daemon"],
    why: "the launchd jobs `barry setup` retires at the cutover; it can only remove them by name",
  },
  {
    file: "sdk/lib/src/host/manifest.ts",
    strings: ["tailnet"],
    why: "a retired manifest key, rejected by name with a message naming its replacement",
  },
  {
    file: "sdk/lib/src/host/__tests__/manifest.test.ts",
    strings: ["tailnet"],
    why: "the test that the retired key is rejected",
  },
];

const argv = process.argv.slice(2);
let files;
if (argv[0] === "--list") {
  files = readFileSync(argv[1], "utf8").split("\n").filter(Boolean);
} else if (argv.length > 0) {
  files = argv;
} else {
  files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.startsWith("plans/") && !SELF.has(f));
}

const violations = [];
const unusedExceptions = [];
let scanned = 0;

// Only a full scan can say an exception is stale; a planted file in a test is
// not where the exceptions live.
for (const exception of argv.length === 0 ? EXCEPTIONS : []) {
  let text = "";
  try {
    text = readFileSync(exception.file, "utf8");
  } catch {
    // reported below as unused
  }
  for (const s of exception.strings) {
    if (!text.includes(s)) unusedExceptions.push(`${exception.file}: "${s}"`);
  }
}

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree, or not a file
  }
  if (text.includes("\0")) continue; // binary
  scanned += 1;
  const allowed = EXCEPTIONS.filter((e) => e.file === file).flatMap((e) => e.strings);
  text.split("\n").forEach((line, i) => {
    let rest = line;
    for (const s of allowed) rest = rest.split(s).join("");
    const match = BANNED.exec(rest);
    if (match) violations.push(`${file}:${i + 1}: "${match[0]}" — ${line.trim().slice(0, 120)}`);
  });
}

if (scanned === 0) {
  console.error("vendor-neutral: scanned ZERO files, so it checked nothing. The file list is wrong, not the repo clean.");
  process.exit(1);
}

if (violations.length > 0 || unusedExceptions.length > 0) {
  if (violations.length > 0) {
    console.error(`vendor-neutral: ${violations.length} mention(s) of a hosting vendor in core:\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      "\nHosting is installation policy (hosting.yaml) carried out by provider bags. Say it in the\n" +
        "policy's words (local, tunnel, provider), or move the vendor detail into its provider bag.",
    );
  }
  if (unusedExceptions.length > 0) {
    console.error(`\nvendor-neutral: ${unusedExceptions.length} exception(s) excuse something that is no longer there:`);
    for (const u of unusedExceptions) console.error(`  ${u}`);
    console.error("Drop them from EXCEPTIONS.");
  }
  process.exit(1);
}

console.log(`vendor-neutral: clean — ${scanned} files scanned, ${EXCEPTIONS.length} named exceptions still needed.`);
