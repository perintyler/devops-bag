#!/usr/bin/env node
/**
 * Fails when the Brewfile and the repo disagree about system dependencies.
 *
 * The Brewfile was the one dependency manifest nothing verified. pnpm has knip,
 * npm packages have the security audit — `brew` entries had prose comments and
 * nothing else, and both of the defects found on 2026-09-16 were the kind a
 * reader would have to already know about to spot:
 *
 * - A versioned database formula was pinned as "Barry local database" while the
 *   database ran in a container and the host binaries were a different major
 *   version. The pin had been wrong for months. Nothing read it, so nothing
 *   could notice. (Both that entry and the database are gone now; it is kept
 *   here as the case that motivated the check.)
 * - `ffmpeg` was declared "Used by screen-recorder tools". The string `ffmpeg`
 *   appeared nowhere else in the repo. The tool it named lives in a different
 *   repository entirely.
 *
 * Both are the same failure: a manifest whose broken state is indistinguishable
 * from its healthy one, because no code path consults it.
 *
 * WHAT THIS CHECKS, AND WHAT IT CANNOT
 *
 * For each declared formula, that its name appears somewhere the repo could
 * plausibly invoke it — source, scripts, workflows, or a documented explanation
 * in the Brewfile itself. That is a weak claim on purpose. It catches the
 * `ffmpeg` case (declared, referenced nowhere) and it cannot catch a tool that
 * is referenced but unnecessary. A stronger check would need to actually run
 * the installer on a clean machine, which is CI's job, not a lint's.
 *
 * The inverse direction matters more and is checked too: a command invoked by
 * `barry setup` that NO Brewfile entry provides is a tool a fresh install lacks. That
 * is the failure a new user hits, and the one the Brewfile exists to prevent.
 *
 * WHY CASKS ARE EXEMPT FROM THE USAGE RULE
 *
 * A cask is an application, not a command on PATH. `claude-code` is invoked as
 * `claude`, `codex` as `codex`. Requiring a literal name match would fail on
 * them, so casks are checked only for being declared once and carrying a
 * comment. Their real verification is PROVIDES below.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const brewfilePath = path.join(repoRoot, "Brewfile");

/**
 * Commands a Brewfile entry puts on PATH under a DIFFERENT name.
 *
 * Without this the check would demand the repo literally say "claude-code",
 * which it never does — it says `claude`. Each entry is the reason
 * a formula/cask earns its place, so an entry here is a claim that must stay
 * true: delete the cask and the commands it provides go unprovided, which the
 * PROVIDES pass below turns into a failure.
 */
const PROVIDES = {
  "claude-code": ["claude"],
  codex: ["codex"],
  node: ["node"],
  pnpm: ["pnpm"],
  jq: ["jq"],
  gh: ["gh"],
};

/**
 * Commands that are POSIX/macOS built-ins or come with Xcode — never a Brewfile
 * entry's job to provide. Without this list the PROVIDES pass would demand a
 * formula for `git`, `curl` and `sed`, which would be noise that trains the
 * reader to ignore this check.
 */
const ASSUMED_PRESENT = new Set([
  "git", "curl", "sed", "awk", "grep", "find", "xargs", "sort", "uniq", "wc",
  "cat", "cut", "tr", "head", "tail", "ls", "cp", "mv", "rm", "mkdir", "chmod",
  "plutil", "defaults", "osascript", "security", "sw_vers", "open",
  "swift", "swiftc", "xcrun", "xcodebuild", "codesign", "bash", "zsh", "env",
  "printf", "echo", "test", "read", "date", "sleep", "kill", "ps", "lsof",
  "ssh", "scp", "rsync", "tar", "gzip", "unzip", "base64", "openssl", "diff",
  "which", "command", "sudo", "dscl", "id", "whoami", "stat", "du", "df",
  "networksetup", "scutil", "pmset", "caffeinate", "say", "afplay", "pbcopy",
]);

const errors = [];

if (!existsSync(brewfilePath)) {
  console.error("brewfile: no Brewfile at the repo root — nothing to verify.");
  process.exit(1);
}

const brewfileText = readFileSync(brewfilePath, "utf8");
const lines = brewfileText.split("\n");

/** Declared entries, in file order, with the line number for error messages. */
const entries = [];
lines.forEach((line, i) => {
  const m = line.match(/^\s*(brew|cask)\s+"([^"]+)"/);
  if (!m) return;
  entries.push({ kind: m[1], name: m[2], line: i + 1, raw: line });
});

if (entries.length === 0) {
  console.error("brewfile: parsed 0 entries from a non-empty Brewfile.");
  console.error("Either the file format changed or this parser is broken. A check");
  console.error("that silently examines nothing reports clean for the wrong reason.");
  process.exit(1);
}

// ---- Duplicate declarations -------------------------------------------------

const seen = new Map();
for (const e of entries) {
  if (seen.has(e.name)) {
    errors.push(`Brewfile:${e.line}: "${e.name}" is declared twice (also line ${seen.get(e.name)})`);
  } else {
    seen.set(e.name, e.line);
  }
}

// ---- Every entry carries a reason -------------------------------------------

for (const e of entries) {
  const hasInlineComment = /#\s*\S/.test(e.raw);
  // A comment block directly above counts too: some entries' reasoning
  // is six lines long and would not fit after the declaration.
  const above = lines[e.line - 2] ?? "";
  const hasCommentAbove = /^\s*#\s*\S/.test(above);
  if (!hasInlineComment && !hasCommentAbove) {
    errors.push(`Brewfile:${e.line}: "${e.name}" has no comment saying what needs it`);
  }
}

// ---- Declared formulae must be referenced somewhere --------------------------

/**
 * Does anything outside the Brewfile mention this term?
 *
 * `git grep` when there is a repo, because it sees TRACKED files only — a
 * stray reference in node_modules or a build cache must not keep a dead entry
 * alive. But the release mirror is an unpacked tree with no .git, and there
 * `git grep` exits non-zero for every term: the catch read that as "not found"
 * and reported all eight formulae unused. The check failed, which is the good
 * direction, but for a reason that had nothing to do with the Brewfile.
 *
 * So: walk the filesystem when git is unavailable, skipping the directories
 * git would have ignored anyway. Same question, answered two ways depending on
 * what the tree is.
 */
function mentionedOutsideBrewfile(term) {
  try {
    const out = execFileSync("git", ["grep", "-lI", "--", term], { cwd: repoRoot, encoding: "utf8" });
    return out
      .split("\n")
      .filter(Boolean)
      .some((f) => f !== "Brewfile" && f !== "checks/brewfile.mjs");
  } catch (error) {
    // Exit 1 means git searched and found nothing — a real answer, not a
    // missing repo. Anything else (128: not a repository, ENOENT: no git)
    // means the question was never asked, so fall back rather than guess.
    const status = /** @type {{ status?: number, code?: string }} */ (error).status;
    if (status === 1) return false;
    return mentionedOnDisk(term);
  }
}

const SKIP_WALK = new Set([
  ".git", "node_modules", "dist", "build", ".wrangler", ".build", ".claude",
  "venv", "tmp", ".release-staging",
]);

function mentionedOnDisk(term, dir = repoRoot) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_WALK.has(entry.name)) continue;
      if (mentionedOnDisk(term, full)) return true;
      continue;
    }
    // Skip the Brewfile itself, and this file: its header cites `ffmpeg` as the
    // entry that prompted the check, so a search for that term matches this
    // prose and reports the dead entry as used. Found by a negative control
    // that passed when it should have failed — git grep had the same blind
    // spot, hidden only because this file is tracked.
    if (full === path.join(repoRoot, "Brewfile")) continue;
    if (full === path.join(repoRoot, "checks", "brewfile.mjs")) continue;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue; // unreadable or binary — not a reference either way
    }
    if (text.includes(term)) return true;
  }
  return false;
}

for (const e of entries) {
  if (e.kind === "cask") continue; // see header: casks are verified via PROVIDES
  const names = [e.name, ...(PROVIDES[e.name] ?? [])];
  // A versioned formula (e.g. `foo@16`) is referenced as its base name too.
  const base = e.name.replace(/@[\d.]+$/, "");
  if (base !== e.name) names.push(base);

  // The Brewfile's own line never counts as a reference: an entry citing only
  // itself is exactly the ffmpeg case this exists to catch.
  const hit = names.some((n) => mentionedOutsideBrewfile(n));

  if (!hit) {
    errors.push(
      `Brewfile:${e.line}: "${e.name}" is declared but nothing outside the Brewfile mentions `
        + `it (tried: ${names.join(", ")}). Either something should use it, or drop the entry.`,
    );
  }
}

// ---- Commands the installer runs must be provided by something --------------

/**
 * The direction that actually bites a new user: `barry setup` running a
 * command no Brewfile entry installs. The declared-but-unused direction above
 * wastes disk; this one produces a failed install on a clean machine, which is
 * the failure the Brewfile exists to prevent.
 *
 * Scoped to setup's own modules on purpose. Scanning every file in the repo
 * would sweep up tools that are legitimately optional (a bag's dependency, a
 * maintainer's one-off) and the noise would train the reader to ignore this.
 * Setup is the one program whose every command must work on a machine that
 * has just been handed the repo.
 *
 * A command counts as run when it is the literal first argument of
 * `execFileSync`, `execFile`, `spawnSync` or `spawn`; one named by its system
 * path ships with macOS and counts as provided. A command setup only probes for (`has("claude")`) is
 * optional by construction: setup reports it missing and carries on.
 */
const installerFiles = [
  path.join(repoRoot, "sdk", "cli", "src", "commands", "setup.ts"),
  ...(existsSync(path.join(repoRoot, "sdk", "cli", "src", "setup"))
    ? readdirSync(path.join(repoRoot, "sdk", "cli", "src", "setup"))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => path.join(repoRoot, "sdk", "cli", "src", "setup", f))
    : []),
];
const missingInstaller = installerFiles.filter((f) => !existsSync(f));
if (missingInstaller.length > 0 || installerFiles.length < 2) {
  errors.push(
    `checks/brewfile.mjs: barry setup's modules are not where this check reads them `
      + `(${missingInstaller.map((f) => path.relative(repoRoot, f)).join(", ") || "sdk/cli/src/setup/ is empty"}), `
      + "so the commands a fresh install needs cannot be checked. Fix the paths rather than dropping the pass.",
  );
} else {
  const providedCommands = new Set();
  for (const e of entries) {
    providedCommands.add(e.name);
    for (const cmd of PROVIDES[e.name] ?? []) providedCommands.add(cmd);
  }

  const invoked = new Set();
  for (const file of installerFiles) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*["'`]([^"'`$]+)["'`]/g)) {
      // A command named by its system path (/bin, /usr/bin, /usr/sbin) ships
      // with macOS, so no Brewfile entry could be what provides it.
      if (/^\/(?:usr\/)?s?bin\//.test(m[1])) continue;
      invoked.add(path.basename(m[1]));
    }
  }

  if (invoked.size === 0) {
    errors.push(
      "checks/brewfile.mjs: found no command run by barry setup. It runs at least pnpm, "
        + "so this means the pattern no longer matches how setup runs commands, not that it runs none.",
    );
  }

  for (const cmd of [...invoked].sort()) {
    if (ASSUMED_PRESENT.has(cmd) || providedCommands.has(cmd)) continue;
    errors.push(
      `barry setup runs "${cmd}", but no Brewfile entry provides it. On a clean machine that `
        + `command is missing. Add it to the Brewfile, add it to PROVIDES if an existing entry `
        + `installs it under another name, or make setup probe for it and report it instead.`,
    );
  }
}

// ---- PROVIDES entries must name a real declaration --------------------------

for (const name of Object.keys(PROVIDES)) {
  if (!seen.has(name)) {
    errors.push(
      `checks/brewfile.mjs: PROVIDES names "${name}", which the Brewfile no longer `
        + `declares. A stale mapping silently satisfies commands nothing installs.`,
    );
  }
}

// ---- Report ------------------------------------------------------------------

if (errors.length > 0) {
  console.error("brewfile: found issues\n");
  for (const error of errors) console.error(`- ${error}`);
  console.error("");
  console.error("The Brewfile is the only dependency manifest a fresh machine reads.");
  console.error("An entry nothing uses installs a tool nobody needs; a tool nothing");
  console.error("declares is missing on a clean install and found by the new user.");
  process.exit(1);
}

// Name each pass rather than printing a single "clean". A success line that
// understates what ran is how a check quietly loses half its coverage: the
// reverse pass was added after this message already said "clean", and nothing
// in the output would have shown if it had silently stopped running.
const formulae = entries.filter((e) => e.kind === "brew").length;
const casks = entries.filter((e) => e.kind === "cask").length;
console.log(
  `brewfile: clean — ${formulae} formulae and ${casks} casks, each commented and referenced `
    + `outside the Brewfile; ${Object.keys(PROVIDES).length} PROVIDES mappings resolve; `
    + `every command barry setup runs is provided.`,
);
