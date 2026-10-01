#!/usr/bin/env node
/**
 * Fails when a test lane can be made to skip itself.
 *
 * Every test lane selects by path. That is fine for the code a lane owns, but
 * the lanes also depend on infrastructure that decides WHICH TESTS EXIST and
 * HOW THEY RUN — and none of them listed it. The consequence is a check that
 * cannot fail: edit the runner that discovers the tests, and no lane triggers,
 * so CI is green because nothing ran.
 *
 * The sharpest instance, found 2026-09-16: test-servers.yml runs
 * `node checks/ci/run-unit-tests.mjs --scope=servers` and did not trigger on
 * `checks/ci/**`. Changing the discovery script itself ran no tests. The same
 * hole covered `vitest.base.config.ts` (the config every suite inherits) and
 * `config/workspace-entries.json` (which declares the workspaces to walk).
 * `verify.yml` is static checks and builds — it is not a fallback test run.
 *
 * Two deliberate choices, both about this check's own durability:
 *
 * - Lanes are DISCOVERED by glob, not listed here. A hardcoded lane list would
 *   be the same hand-maintained inventory whose silent rot this exists to
 *   prevent: adding `test-foo.yml` would simply escape the policy. Globbing
 *   means a new lane is subject to it the moment it appears, which is the point
 *   even though it will surprise whoever adds one.
 * - It asserts only SHARED inputs — things every lane's result depends on
 *   regardless of what it tests. Per-lane dependency lists are explicitly not
 *   the mechanism here; the review that prompted this (Q3) argues a broad
 *   `packages/**` trigger beats an incomplete list, because the incomplete list
 *   fails silently.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const workflowDir = path.join(repoRoot, ".github", "workflows");

/**
 * Inputs every test lane's outcome depends on, whatever it tests.
 *
 * Each must ALSO exist on disk — a required input naming a path that has moved
 * would make this check assert against a file nobody edits, which is a check
 * that cannot fail wearing the costume of one that can.
 */
const REQUIRED_INPUTS = [
  "vitest.base.config.ts",
  ".github/ci/**",
  ".github/actions/setup/action.yml",
  "package.json",
  // Repo ROOT, not config/. The review that prompted this check cites it as
  // `workspace-entries.json` under config/, which is where it used to live; the
  // existence guard above is what caught the stale path, and it is the reason
  // that guard exists at all.
  "workspace-entries.json",
];

/**
 * Lanes the shared-input rule does not apply to, and why.
 *
 * Empty since the Swift packages left this repo: `test-macos.yml` was the only
 * entry, exempt because `swift test` runs against SwiftPM packages outside the
 * pnpm workspace, where none of the required inputs could affect the result.
 * Those packages are their own repos now and test through the shared lane
 * BarryKit hosts, so the lane and its exemption both went with them.
 *
 * This is an escape hatch, so it stays an explicit per-lane list with a stated
 * reason rather than a pattern: a rule like "skip lanes that look non-Node"
 * would silently start exempting lanes it was never meant to. The dead-trigger
 * and dead-scope rules below apply to every lane, exemptions included.
 */
const EXEMPT_LANES = new Map([]);

/**
 * Workspaces covered by a lane that never says `--scope=`, and the lane that
 * covers them.
 *
 * The scope-based coverage assertion below can only see lanes that select
 * suites through run-unit-tests.mjs. `test-cli.yml` runs the CLI's
 * integration suite through its own command instead, so no scope names
 * `cli` — this map records that hand-link explicitly rather than letting the
 * coverage assertion either fail forever or grow a "looks covered" guess.
 *
 * Checked in both directions like every other inventory here: an entry whose
 * lane no longer exists, or whose workspace has left the repo, is an error —
 * a stale entry would be a silent exemption, which is the defect this check
 * exists to prevent.
 */
const NON_SCOPE_COVERAGE = new Map([
  ["sdk/cli", "test-cli.yml"],
]);

/** The on-disk path a required input refers to, for the existence check. */
function inputTarget(input) {
  return input.replace(/\/\*\*$/, "");
}

/**
 * The quoted paths in a lane's `paths:` list.
 *
 * Every trigger in these lanes is written as a quoted scalar on its own `- `
 * line, so this reads them without a YAML parser. Comment lines are skipped —
 * the triggers now carry explanatory comments, and a `#` line has no quoted
 * path to find anyway.
 */
function declaredTriggers(source) {
  const found = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const match = /^- "([^"]+)"$/.exec(trimmed);
    if (match) found.push(match[1]);
  }
  return [...new Set(found)];
}

/**
 * Does this trigger match at least one file that exists?
 *
 * A trigger that can never fire is the same defect class as a check that can
 * never fail, and it is cheap to assert. Found live 2026-09-16:
 * test-bags.yml watched `config/*.builtin.yaml` after config/ was dissolved in
 * 43ed1d0b and the seeds moved to packages/db/seed/, so the bags lane had gone
 * deaf to exactly the registry files it was written to watch. It was masked in
 * aggregate — three other lanes trigger on `packages/db/**` and still ran —
 * which is what let it survive.
 *
 * Deliberately conservative: it handles the three glob shapes these lanes
 * actually use (`dir/**`, `dir/*.ext`, and a literal path) and treats anything
 * else as matching. A cleverer matcher would risk failing a valid trigger it
 * merely failed to understand, and a false failure here would get the whole
 * check disabled.
 */
function triggerMatchesSomething(trigger) {
  if (trigger.endsWith("/**")) {
    return existsSync(path.join(repoRoot, trigger.slice(0, -3)));
  }
  const starIndex = trigger.indexOf("*");
  if (starIndex === -1) {
    return existsSync(path.join(repoRoot, trigger));
  }
  const slashIndex = trigger.lastIndexOf("/", starIndex);
  // A glob with no directory part (e.g. `*.md`) — not a shape these lanes use;
  // treat as matching rather than guess.
  if (slashIndex === -1) return true;
  const dir = trigger.slice(0, slashIndex);
  const pattern = trigger.slice(slashIndex + 1);
  // Only `*` is supported, and it never spans a directory separator.
  if (pattern.includes("**") || pattern.lastIndexOf("*") !== pattern.indexOf("*")) return true;
  const [prefix, suffix] = pattern.split("*");
  let entries;
  try {
    entries = readdirSync(path.join(repoRoot, dir));
  } catch {
    return false; // the directory itself is gone
  }
  return entries.some((name) => name.startsWith(prefix) && name.endsWith(suffix));
}

/**
 * The `--scope=` values a lane passes to the unit-test runner.
 *
 * A lane selects its suites twice: by `paths:` (does it run at all) and by
 * `--scope=` (what it runs once it does). Only the first was asserted, so a
 * scope naming a directory that had moved silently selected nothing.
 */
function declaredScopes(source) {
  const found = [];
  for (const line of source.split("\n")) {
    // Only a `command:` line, never a comment: prose explaining a past scope
    // mistake would otherwise be read as a live scope and fail the check for
    // describing the very bug it documents.
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.startsWith("command:")) continue;
    const match = /--scope=([A-Za-z0-9_,\-/]+)/.exec(trimmed);
    if (!match) continue;
    for (const scope of match[1].split(",")) {
      if (scope) found.push(scope);
    }
  }
  return [...new Set(found)];
}

/**
 * Does this scope select at least one workspace?
 *
 * Mirrors `inScope` in checks/ci/run-unit-tests.mjs — a scope matches a
 * workspace key exactly or as a path prefix. The runner already exits 1 when a
 * scope run discovers nothing, but that guard only fires when the WHOLE run is
 * empty: `--scope=packages,sdks` found 12 suites under `packages` and never
 * reported that `sdks` contributed none. Found 2026-09-22 — every sdk/*
 * package had been unreachable since the tree was renamed from sdks/.
 */
function scopeMatchesWorkspace(scope) {
  return WORKSPACE_KEYS.some((key) => key === scope || key.startsWith(`${scope}/`));
}

/**
 * Does this workspace declare a unit `test` script?
 *
 * The coverage assertion runs in this direction deliberately: the dead-scope
 * rule above catches a scope naming nothing, but a whole NEW TREE (adapters/
 * escaped every lane for the first year of its existence) matches no scope
 * and triggers no error unless coverage is asserted from the workspace side.
 */
function workspaceHasTestScript(key) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, key, "package.json"), "utf8"));
    return Boolean(pkg.scripts?.test);
  } catch {
    return false;
  }
}

const WORKSPACE_KEYS = Object.keys(
  JSON.parse(readFileSync(path.join(repoRoot, "workspace-entries.json"), "utf8")),
);

const errors = [];

for (const input of REQUIRED_INPUTS) {
  if (!existsSync(path.join(repoRoot, inputTarget(input)))) {
    errors.push(
      `required input "${input}" does not exist on disk — either it moved (repoint it here) or it left (drop it)`,
    );
  }
}

const lanes = readdirSync(workflowDir)
  .filter((name) => /^test-.*\.ya?ml$/.test(name))
  .sort();

if (lanes.length === 0) {
  errors.push(`no test lanes found in .github/workflows — expected files matching test-*.yml`);
}

// An exemption for a lane that no longer exists is a silent weakening: if the
// lane comes back under the same name it is exempt again, for a reason nobody
// re-examined. Same defect class as the dead triggers below.
for (const [lane, reason] of EXEMPT_LANES) {
  if (!lanes.includes(lane)) {
    errors.push(
      `exemption for "${lane}" (${reason}) names a lane that does not exist — drop it`,
    );
  }
}

for (const lane of lanes) {
  // Read the raw text rather than parsing YAML: the lanes use a `&paths`
  // anchor aliased into pull_request, so the literal list appears once and a
  // substring check sees exactly what GitHub expands. No YAML dependency for a
  // check that must run anywhere.
  const source = readFileSync(path.join(workflowDir, lane), "utf8");
  if (!EXEMPT_LANES.has(lane)) {
    for (const input of REQUIRED_INPUTS) {
      if (!source.includes(`"${input}"`)) {
        errors.push(`${lane}: missing required trigger input "${input}"`);
      }
    }
  }
  for (const trigger of declaredTriggers(source)) {
    if (!triggerMatchesSomething(trigger)) {
      errors.push(
        `${lane}: trigger "${trigger}" matches no file on disk — it can never fire`,
      );
    }
  }
  for (const scope of declaredScopes(source)) {
    if (!scopeMatchesWorkspace(scope)) {
      errors.push(
        `${lane}: --scope=${scope} matches no workspace — those suites never run`,
      );
    }
  }
}

// Coverage, from the workspace side. The scope rule above proves a scope is
// not dead; this proves the scopes jointly miss nothing.
const declaredScopeUnion = lanes.flatMap((lane) =>
  declaredScopes(readFileSync(path.join(workflowDir, lane), "utf8")),
);

for (const [key, lane] of NON_SCOPE_COVERAGE) {
  if (!lanes.includes(lane)) {
    errors.push(
      `non-scope coverage map names "${lane}" for ${key} — that lane does not exist`,
    );
  }
  if (!WORKSPACE_KEYS.includes(key) || !workspaceHasTestScript(key)) {
    errors.push(
      `non-scope coverage map names "${key}" — it is gone from the workspace inventory or has no test script; drop the entry`,
    );
  }
}

const testBearingWorkspaces = WORKSPACE_KEYS.filter(workspaceHasTestScript);
const uncovered = testBearingWorkspaces.filter(
  (key) =>
    !NON_SCOPE_COVERAGE.has(key) &&
    !declaredScopeUnion.some((scope) => key === scope || key.startsWith(`${scope}/`)),
);
for (const key of uncovered) {
  errors.push(
    `no test lane selects "${key}" — its suites run only on whoever remembers to`,
  );
}

if (errors.length > 0) {
  console.error("Test lanes are missing shared trigger inputs:\n");
  for (const error of errors) console.error(`- ${error}`);
  console.error("\nA lane that does not trigger on the infrastructure deciding which");
  console.error("tests exist can be made to skip itself: change the runner, run nothing,");
  console.error("and CI reports green. Add the input to that lane's `paths:` list.");
  process.exit(1);
}

// Name the exemptions rather than folding them into a single count: "5 lanes
// declare 3 inputs" would be false, and a success line that overstates what was
// checked is how a check quietly stops meaning anything.
const checked = lanes.filter((lane) => !EXEMPT_LANES.has(lane));
const scopeCount = lanes.reduce(
  (total, lane) => total + declaredScopes(readFileSync(path.join(workflowDir, lane), "utf8")).length,
  0,
);
console.log(
  `workflow-test-triggers: clean — ${checked.length} of ${lanes.length} lanes declare all `
    + `${REQUIRED_INPUTS.length} shared inputs; every trigger in all ${lanes.length} resolves; `
    + `all ${scopeCount} declared scopes select a workspace; all `
    + `${testBearingWorkspaces.length} test-bearing workspaces are covered by a lane `
    + `(${NON_SCOPE_COVERAGE.size} via the non-scope map).`,
);
