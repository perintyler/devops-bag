#!/usr/bin/env node
/**
 * Fails when tooling references a repo path that no longer exists.
 *
 * Reorgs move directories; the code that moves with them keeps working, but the
 * *tooling* that names those directories as strings does not. Nothing type-checks
 * a path inside a YAML matrix entry, a check-script allowlist, or a
 * `.package(path:)`, so the reference just goes quietly dead:
 *
 *   - the macOS CI matrix pointed at `bags/sessions/app` and `bags/bdiff/app`
 *     after both moved, so the lane failed with "Could not find Package.swift"
 *   - identity-residue allowlisted a legacy client type at those same two paths,
 *     so 7 deliberate survivors started reading as violations
 *   - the sessions app's `.package(path:)` still had three `../` after moving a
 *     level deeper, resolving to `bags/packages/BarryKit`
 *
 * All three shipped in one release and were only caught by running the lanes.
 * A dead path reference is always a bug: either the target moved (fix the
 * reference) or it left (drop the reference).
 *
 * Deliberately narrow: it only checks references that name a concrete path in a
 * known syntactic position. It does not parse prose or guess at globs.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { trackedPaths } from "./tracked-paths.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = process.cwd();
const checksRoot = fileURLToPath(new URL(".", import.meta.url));
const { barryAppSupportDir } = await import(pathToFileURL(path.join(repoRoot, "sdk/lib/src/services/home.mjs")));
/** References resolve to what the checkout tracks (see tracked-paths.mjs). */
const tracked = trackedPaths(repoRoot);
const errors = [];

/** Directories never worth walking. */
// `.claude` holds other sessions' scratch worktrees — gitignored, not repo
// content. Walking it made this check's result depend on whatever a parallel
// session happened to have checked out, which is both flaky and not this
// check's business. `venv`/`tmp` are the same kind of local-only noise, and so
// is `.barry-dev`, the contributor instance `pnpm dev` keeps in the checkout.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".wrangler", ".build",
  ".claude", "venv", "tmp", ".barry-dev",
]);

async function walk(relativeDir, match, onFile) {
  await walkDir(repoRoot, relativeDir, match, onFile);
}

/** Walk an arbitrary root directory, calling onFile(rel) for each match. */
async function walkDir(root, relativeDir, match, onFile) {
  let entries;
  try {
    entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDir(root, rel, match, onFile);
    } else if (match(entry.name, rel)) {
      await onFile(rel);
    }
  }
}
/**
 * 1. GitHub workflow matrix paths.
 *
 * `path:`/`package-path:`/`working-directory:` naming a repo-relative directory.
 * Values with an expression (`${{ … }}`) are skipped — they are resolved from a
 * matrix entry elsewhere in the same file, which this check sees on its own line.
 */
async function checkWorkflowPaths() {
  await walk(".github", (name) => /\.ya?ml$/.test(name), async (rel) => {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    content.split("\n").forEach((line, i) => {
      const m = /^\s*(?:-\s+)?(path|package-path|working-directory):\s*["']?([^"'\s#]+)["']?\s*$/.exec(line);
      if (!m) return;
      const value = m[2];
      if (value.includes("${{") || value.startsWith("~") || value.startsWith("/")) return;
      // `path: |` opens a block scalar (actions/cache lists several paths, each
      // typically templated); the entries land on their own lines.
      if (value === "|" || value === ">" || value === "|-" || value === ">-") return;
      // `path:` under actions/cache is a cache key glob, not a source directory.
      if (value.includes("*")) return;
      if (!tracked(path.join(repoRoot, value))) {
        errors.push(`${rel}:${i + 1}: ${m[1]} "${value}" does not exist`);
      }
    });
  });
}

/**
 * 2. Allowlist prefixes in check scripts.
 *
 * An allowlist entry naming a path that no longer exists is worse than useless:
 * it silently stops exempting whatever it was written to exempt, so the next run
 * reports deliberate survivors as fresh violations.
 */
async function checkAllowlistPrefixes() {
  await walkDir(checksRoot, ".", (name) => /\.mjs$/.test(name), async (rel) => {
    if (rel.endsWith("stale-paths.mjs")) return;
    const content = await readFile(path.join(checksRoot, rel), "utf8");
    // Two spellings, because checks use both and only one was covered. The
    // `prefix: "..."` object form is what the ALLOWLIST arrays use. The bare
    // string form is what SKIPPED_PREFIXES uses -- and a dead
    // `packages/db/migrations/` sat in identity-residue's list unnoticed
    // precisely because this rule could not see that spelling.
    let inSkipList = false;
    content.split("\n").forEach((line, i) => {
      const report = (value) => {
        if (!value.includes("/")) return;
        if (!tracked(path.join(repoRoot, value))) {
          errors.push(`${rel}:${i + 1}: allowlist prefix "${value}" does not exist`);
        }
      };

      const objectForm = /prefix:\s*"([^"]+)"/.exec(line);
      if (objectForm) report(objectForm[1]);

      // SKIPPED_PREFIXES, on one line or spread across several.
      if (/SKIPPED_PREFIXES\s*=/.test(line)) inSkipList = true;
      if (inSkipList) {
        for (const m of line.matchAll(/"([^"]+)"/g)) report(m[1]);
        if (line.includes("]")) inSkipList = false;
      }
    });
  });
}

/**
 * 3. SwiftPM local package dependencies.
 *
 * `.package(path: "../../foo")` is resolved relative to the Package.swift, so
 * moving the package a level deeper silently repoints it at a sibling that does
 * not exist.
 */
async function checkSwiftPackagePaths() {
  await walk(".", (name) => name === "Package.swift", async (rel) => {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    content.split("\n").forEach((line, i) => {
      const m = /\.package\(path:\s*"([^"]+)"\)/.exec(line);
      if (!m) return;
      const resolved = path.resolve(path.dirname(path.join(repoRoot, rel)), m[1]);
      if (!tracked(resolved)) {
        const shown = path.relative(repoRoot, resolved) || m[1];
        errors.push(`${rel}:${i + 1}: .package(path: "${m[1]}") resolves to ${shown}, which does not exist`);
      }
    });
  });
}

/**
 * 4. Repo-relative directory arguments in shell scripts.
 *
 * A wrapper script handing a directory to a helper — `deploy-worker.sh
 * sdks/links` — names a path nothing type-checks and nothing resolves until
 * the script runs. When sdks/links moved out to its own bag, two such wrappers
 * kept passing a directory that no longer existed, and this check reported
 * clean throughout: it did not read .sh files at all. That is the exact class
 * the header describes, so the omission made a green here mean less than it
 * looked like it did.
 *
 * Matches only an argument that follows an invoked *.sh and looks like a
 * repo-relative directory (`a/b`, no leading ./ ~ / $ and no glob), which is
 * the position those wrappers used. Quoted, variable and flag arguments are
 * left alone rather than guessed at.
 *
 * Note what this does and does not buy: as of writing it scans 36 .sh files
 * and matches ZERO lines, because the two scripts that used this shape were
 * deleted with the directories they named. So it currently passes by matching
 * nothing, which is the same thing a broken check looks like. It is here as a
 * tripwire for the next wrapper written in that shape, not as evidence about
 * today's tree — verified by recreating the deleted deploy-links.sh, which it
 * catches by file, line and path, and by a valid path, which it ignores. If
 * this grows a third failure mode, widen the match rather than trusting the
 * green.
 */
async function checkShellScriptPathArgs() {
  await walk(".", (name) => name.endsWith(".sh"), async (rel) => {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    content.split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("#")) return;
      const m = /\.sh"?\s+([a-z][a-z0-9_-]*(?:\/[a-z0-9_.-]+)+)\s*$/.exec(line);
      if (!m) return;
      const value = m[1];
      if (value.includes("*") || value.includes("$")) return;
      if (!tracked(path.join(repoRoot, value))) {
        errors.push(`${rel}:${i + 1}: passes "${value}" to a script, but that path does not exist`);
      }
    });
  });
}

/**
 * 5. Documentation citations inside check scripts.
 *
 * A check that names its rationale — "see docs/architecture.md" — is read
 * when CI just failed and someone went looking for why. Two of those pointers went stale the same day. One cited a
 * section that had moved to another document; the other cited a document
 * renamed by the very rename that check exists to police. Neither was visible
 * to anything: doc-links only reads *.md, and the citations live in .mjs prose.
 *
 * Checks the file exists, and — when a citation carries `:line` — that the
 * line is in range. It cannot verify the line still says the right thing;
 * that part stays on the author.
 *
 * The match is lowercase-only, matching this repo's doc naming. A first
 * negative control here used `docs/GONE-doc.md` and passed — not because the
 * scanner worked, but because the regex never looked at it. Worth knowing if
 * a doc is ever added with a capital in the name: it would be invisible here.
 *
 * Scanned across every source extension, not just checks/*.mjs where
 * this started. Deleting docs/storage-boundaries.md left a citation in an
 * applied SQL migration, and the negative control for it passed: the regex
 * would have matched, but the walk never opened a .sql file. Same shape as the
 * capital-letter trap above — the scanner was fine, its reach was not.
 */
const CITING_SOURCE = /\.(mjs|js|ts|tsx|sql|sh|swift|yaml|yml)$/;

/**
 * Tests are excluded because a test's doc-shaped strings are usually invented,
 * not cited: `docs/readme.md` as a fixture filename in an ownership map, or a
 * path written into a temp dir to prove a filter keeps it. Widening the scan
 * surfaced five of those and zero real citations from test files. A fixture
 * that must not exist on disk is the opposite of a citation, and failing on it
 * would train the next person to silence this check.
 */
const IS_TEST = /\.(test|spec)\.[a-z]+$|(^|\/)(test|tests|__tests__)\//;

async function checkDocCitations() {
  const lineCounts = new Map();
  await walk(".", (name, rel) => CITING_SOURCE.test(name) && !IS_TEST.test(rel), async (rel) => {
    // Skip self, as checkAllowlistPrefixes does: this file's prose discusses
    // citations and would otherwise match its own examples.
    if (rel.endsWith("stale-paths.mjs")) return;
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    content.split("\n").forEach((line, i) => {
      // Include nested docs and their full repo-relative prefix: checking only
      // the docs/ suffix misreads a bag doc as a missing root doc.
      // `docs/` only. `principles/` was scanned here until those four
      // documents became the coding-principles bag; nothing in this repo can
      // cite them by path any more. Dropping the alternative rather than
      // guarding it with a word boundary also removes a false positive: the
      // pattern has no left anchor, so the bag's own name written in prose —
      // `coding-principles/naming.md` — matched on the substring and failed a
      // check for a file that was never claimed to be here.
      for (const m of line.matchAll(/\b(?:[a-z0-9-]+\/)*docs\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.md(?::(\d+)(?:-\d+)?)?/g)) {
        const [cited, lineNo] = [m[0], m[1]];
        const file = cited.split(":")[0];
        const abs = path.join(repoRoot, file);
        if (!tracked(abs)) {
          errors.push(`${rel}:${i + 1}: cites ${file}, which does not exist`);
          continue;
        }
        if (!lineNo) continue;
        if (!lineCounts.has(file)) {
          lineCounts.set(file, readFileSync(abs, "utf8").split("\n").length);
        }
        if (Number(lineNo) > lineCounts.get(file)) {
          errors.push(
            `${rel}:${i + 1}: cites ${cited}, but that file has only ${lineCounts.get(file)} lines`,
          );
        }
      }
    });
  });
}

/**
 * 7. Relative module specifiers in repo tooling.
 *
 * The eleven-package fold moved sdk/bag-host/src and sdk/services/src into
 * sdk/lib/src. Six tooling scripts kept importing the old paths
 * (the old host generators, a check test) and this file reported clean, because
 * no rule above reads an import specifier. Typecheck did not help either:
 * that tooling was in no tsconfig project. The failure surfaced only when
 * someone ran the script.
 *
 * Resolves each `./` or `../` specifier in from/import()/require against the
 * importing file. A `.js` specifier also accepts the `.ts`/`.mts` source, which
 * is how NodeNext spells a TypeScript import.
 */
const TOOLING_DIRS = [".github/ci", "sdk/cli/bin", "sdk/cli/scripts"];
async function checkToolingImports() {
  let checked = 0;
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  const roots = [...TOOLING_DIRS.map((dir) => [repoRoot, dir]), [checksRoot, "."]];
  for (const [root, dir] of roots) {
    const tracksImport = root === checksRoot ? trackedPaths(checksRoot) : tracked;
    await walkDir(root, dir, (name) => /\.(?:[cm]?[jt]s)$/.test(name), async (rel) => {
      const content = await readFile(path.join(root, rel), "utf8");
      content.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
        for (const m of line.matchAll(specifier)) {
          const value = m[1];
          if (value.includes("${")) continue;
          checked += 1;
          const target = path.resolve(path.dirname(path.join(root, rel)), value);
          const candidates = [target];
          if (/\.m?js$/.test(target)) candidates.push(target.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts"));
          if (!candidates.some((c) => tracksImport(c))) {
            errors.push(`${rel}:${i + 1}: imports "${value}", which resolves to ${path.relative(repoRoot, target)} -- not tracked`);
          }
        }
      });
    });
  }
  if (checked === 0) errors.push(`${TOOLING_DIRS.join(", ")}: no relative imports matched -- rule 8 is not inspecting anything`);
}

/**
 * 8. Repo paths inside shell scripts, including extensionless ones.
 *
 * Rule 4 only reads *.sh. Two scripts that broke in the fold have no extension:
 * the hook dispatcher's shell shim exec'd "$ROOT/sdk/bag-host/src/hook-dispatch.ts",
 * which killed every Stop hook in every session with ERR_MODULE_NOT_FOUND, and
 * builtin/services/jobs/contract-drift named its suite as
 * "bags/sessions/api/src/...", so the hourly drift job exited 2 on every tick
 * and the drift it existed to report went unmeasured.
 *
 * A shell script is any .sh file or any extensionless file whose first line is
 * a sh/bash shebang. Two positions are checked, both concrete:
 *   - `$ROOT/...`, `${ROOT_DIR}/...` and similar repo-root variables
 *   - a quoted repo-relative path that ends in a file extension
 * Anything carrying another variable or a glob is left alone rather than guessed.
 */
const SHELL_DIRS = ["ci", "builtin", "sdk/cli/bin"];
const ROOT_VARS = /\$\{?(?:ROOT|ROOT_DIR|REPO_ROOT|BARRY_DIR|BARRY_ROOT)\}?\/([A-Za-z0-9_./-]+)/g;
const QUOTED_FILE = /["']((?:[a-z][a-z0-9_.-]*\/)+[A-Za-z0-9_.-]+\.(?:ts|mts|mjs|js|sh|json|ya?ml|py))["']/g;
async function checkShellScriptPaths() {
  let scripts = 0;
  let checked = 0;
  for (const dir of SHELL_DIRS) {
    await walk(dir, (name) => name.endsWith(".sh") || !name.includes("."), async (rel) => {
      const content = await readFile(path.join(repoRoot, rel), "utf8");
      if (!rel.endsWith(".sh") && !/^#!.*\b(?:ba)?sh\b/.test(content.split("\n", 1)[0])) return;
      scripts += 1;
      content.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("#")) return;
        const seen = new Set();
        for (const m of line.matchAll(ROOT_VARS)) seen.add(m[1].replace(/[./]+$/, ""));
        for (const m of line.matchAll(QUOTED_FILE)) seen.add(m[1]);
        for (const value of seen) {
          if (!value || value.includes("$") || value.includes("*")) continue;
          // .env files are the operator's secrets, never tracked, and scripts
          // test for them before sourcing -- absent is a normal state.
          if (path.basename(value).startsWith(".env")) continue;
          // Runtime artifacts: log files, hidden dirs (.worktrees), and
          // other paths that are created at runtime, not checked-in source.
          // The monorepo rules avoid these via narrow directory scope;
          // external bags need explicit filtering.
          if (path.basename(value).endsWith(".log")) continue;
          if (value.split("/").some((s) => s.startsWith("."))) continue;
          checked += 1;
          if (!tracked(path.join(repoRoot, value))) {
            errors.push(`${rel}:${i + 1}: names "${value}", which the checkout does not track`);
          }
        }
      });
    });
  }
  if (scripts === 0) errors.push(`${SHELL_DIRS.join(", ")}: found no shell scripts -- rule 9 is not inspecting anything`);
  else if (checked === 0) errors.push(`rule 9 read ${scripts} shell scripts and matched no repo path -- it is not inspecting anything`);
}


/**
 * 9. Repo paths inside external bag repositories.
 *
 * External bags live in their own repos (~/repos/bags/*, ~/repos/barry-bux/bags/*)
 * and reference the barry monorepo via $BARRY_DIR. When a directory inside the
 * monorepo moves, those references go silently dead — exactly the class of bug
 * that motivated this script. The nightly backup broke for three nights because
 * barry-devops/jobs/backup ran `tsx $BARRY_DIR/cli/src/index.ts` after cli/
 * moved to sdk/cli/, and alerting was gated on the same stale path so it
 * silently did nothing.
 *
 * Reads the instance's bag registry snapshot to discover local bags. Entries
 * that are remote, disabled, or whose path is absent on this machine are
 * skipped — that is normal (other machines have different sets). Each present
 * bag is walked for shell scripts and source files, and $BARRY_DIR/... refs are
 * resolved against the monorepo root just as the in-tree rule 9 does.
 */
function loadExternalBags() {
  const registryPath =
    process.env.BARRY_BAGS_SNAPSHOT ?? path.join(barryAppSupportDir(), "bags.snapshot.json");
  // A bare clone (CI) has no instance, so no external bags to check.
  if (!existsSync(registryPath)) return [];
  const { bags: entries = {} } = JSON.parse(readFileSync(registryPath, "utf8"));
  const bags = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.type !== "local" || !entry.path || entry.disabled || entry.access === "disabled") continue;
    const resolved = entry.path.startsWith("~") ? path.join(homedir(), entry.path.slice(1)) : entry.path;
    bags.push({ name, path: resolved });
  }
  return bags;
}

async function checkExternalBagPaths() {
  const bags = loadExternalBags();
  let scanned = 0;
  for (const bag of bags) {
    if (!existsSync(bag.path)) continue;
    scanned += 1;
    await walkDir(bag.path, ".", (name) => name.endsWith(".sh") || !name.includes("."), async (rel) => {
      const abs = path.join(bag.path, rel);
      // A symlink to a directory passes the name filter; only files hold paths.
      if (!statSync(abs).isFile()) return;
      const content = await readFile(abs, "utf8");
      if (!rel.endsWith(".sh") && !/^#!.*\b(?:ba)?sh\b/.test(content.split("\n", 1)[0])) return;
      content.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("#")) return;
        const seen = new Set();
        for (const m of line.matchAll(ROOT_VARS)) seen.add(m[1].replace(/[./]+$/, ""));
        for (const m of line.matchAll(QUOTED_FILE)) seen.add(m[1]);
        for (const value of seen) {
          if (!value || value.includes("$") || value.includes("*")) continue;
          if (path.basename(value).startsWith(".env")) continue;
          // Runtime artifacts: log files, hidden dirs (.worktrees), and
          // other paths that are created at runtime, not checked-in source.
          // The monorepo rules avoid these via narrow directory scope;
          // external bags need explicit filtering.
          if (path.basename(value).endsWith(".log")) continue;
          if (value.split("/").some((s) => s.startsWith("."))) continue;
          if (!tracked(path.join(repoRoot, value))) {
            errors.push(`[bag:${bag.name}] ${rel}:${i + 1}: names "${value}", which the barry checkout does not track`);
          }
        }
      });
    });
  }
  if (scanned > 0) {
    console.log(`stale-paths: scanned ${scanned} external bag(s) for repo-path references.`);
  }
}

await checkWorkflowPaths();
await checkAllowlistPrefixes();
await checkSwiftPackagePaths();
await checkShellScriptPathArgs();
await checkDocCitations();
await checkToolingImports();
await checkShellScriptPaths();
await checkExternalBagPaths();

if (errors.length > 0) {
  console.error("Stale path references:\n");
  for (const error of errors) console.error(`- ${error}`);
  console.error("\nEach reference names a path the checkout does not track (a file that is only on\ndisk, like an ignored leftover, does not count). Either the");
  console.error("target moved (repoint it) or it left the repo (drop it).");
  process.exit(1);
}

console.log("stale-paths: clean — every referenced path exists.");
