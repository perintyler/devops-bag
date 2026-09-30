#!/usr/bin/env node
/**
 * The repo's dependency boundaries, asserted rather than trusted.
 *
 * Three rules, each guarding a direction the tree layout implies but nothing
 * enforces:
 *
 *   1. A bag's module graph must not REACH host-only machinery (transitively).
 *   2. An `sdk/` package must not DEPEND on an implementation.
 *   3. A `builtin/` bag must not either, except at a composition root.
 *   4. the vendor call packages depend on the SDK and nothing else — vendors
 *      are data plus plain HTTP, so every process can afford to load them.
 *      The one allowed edge between them is `decisions/` and `embeddings/`
 *      reusing `completion/`'s transports, because one daemon (Ollama) or one
 *      API (Anthropic Messages) serves several kinds.
 *
 * Rules 2 and 3 replaced two standing exceptions in AGENTS.md that were only
 * ever prose. Both were removed by making the contracts take a resolver as an
 * argument; nothing but this stops a third from arriving as a
 * reasonable-looking import.
 *
 * Rule 1's original premise has since reversed — `sdk/bag-host` was destined
 * to become a sibling under `engine/`, and the restructure instead folds it
 * into the SDK. The rule outlived the premise because it was never really
 * about where the package lives: a bag must not drag an MCP client, its
 * transports and an on-disk cache into a process that only READS already-loaded
 * bags. The edge that kept breaking it
 * was `loader -> remote -> {cache, transport}`: an MCP client, its transports
 * and an on-disk cache, pulled into six bag entrypoints that only ever READ
 * already-loaded bags. `loader` now takes remote discovery as an injection and
 * the host installs it (`sdk/lib/src/host/remote-loader.ts`).
 *
 * WHY A GRAPH CHECK AND NOT tsc: every earlier attempt at this cut was green
 * to `tsc` and still shipped the edge. Type-checking sees declarations;
 * reachability is what actually drags code into a process. An import-grep is
 * no better — the edge here is transitive, and a previous session's grep audit
 * missed it entirely.
 *
 * TWO WAYS THIS CHECK COULD LOOK HEALTHY WHILE BLIND, both guarded below:
 *
 * 1. **A build that resolves nothing reaches nothing.** If workspace imports
 *    fail to resolve, the bundle is one module and every host module is
 *    trivially absent — a PASS that means "I measured nothing". So each
 *    entrypoint must be shown to actually traverse `loader`; if it does not,
 *    that is a FAILURE, not a pass.
 * 2. **A build error is not a clean result.** esbuild failing for any reason
 *    exits this check non-zero rather than skipping the entrypoint.
 */
import { build } from "esbuild";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const ROOT = process.cwd();

/** Modules a bag must never reach. */
const HOST_MODULES = [
  "sdk/lib/src/host/remote.ts",
  "sdk/lib/src/host/cache.ts",
  "sdk/lib/src/host/transport.ts",
];

/**
 * Bag entrypoints that import the loader. Listed explicitly rather than
 * globbed: a glob that silently matches nothing is the same false pass as (1).
 */
const WITNESS = "sdk/lib/src/host/loader.ts";

/**
 * Each entrypoint with the workspace module it must be shown to traverse —
 * the proof that resolution worked, so an empty reach means something.
 *
 * The loader was once the witness for everything, because every entry listed
 * here imported it. A bag's prompt entry need not: memory's reaches the SDK
 * through `definePrompt` and has no business near the loader, so demanding it
 * would have forced either a pointless import or leaving the entry unchecked.
 */
const BAG_ENTRYPOINTS = [
  ["builtin/actions/src/tools.ts", WITNESS],
  ["builtin/identities/src/store/identity-bags.ts", WITNESS],
  ["builtin/identities/src/traits-catalog.ts", WITNESS],
  ["builtin/instructions/src/tools.ts", WITNESS],
  ["builtin/sessions/api/src/routes/actions.ts", WITNESS],
  ["builtin/sessions/api/src/session-runtime.ts", WITNESS],
  // Runs in a child process at every session start, in CLI and API alike.
  ["builtin/memory/prompt.ts", "sdk/lib/src/bags/define-prompt.ts"],
];

/**
 * Trees that hold workspace packages.
 *
 * Filtered against disk at startup rather than listed and hoped for: `find`
 * exits non-zero when any root is missing, so a dissolved directory turned
 * this check into a crash. Filtering alone would be the opposite failure — a
 * typo'd root would silently narrow the search — so the count of packages
 * found is asserted below.
 */
const WORKSPACE_ROOTS = ["builtin", "sdk", "adapters"].filter((r) =>
  existsSync(join(ROOT, r)),
);

function workspacePackages() {
  // `packages/` is empty now -- everything moved to sdk/ or bags/ -- and find
  // exits non-zero on a root that does not exist, which took this check down
  // on any tree without the untracked leftover directory. Filtering to roots
  // that exist keeps that from being an error; the count assertion below is
  // what keeps it from silently becoming a no-op.
  const roots = WORKSPACE_ROOTS;
  const out = execFileSync(
    "find",
    [...roots, "-name", "package.json",
     "-not", "-path", "*/node_modules/*", "-maxdepth", "4"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const pkgs = new Map();
  for (const rel of out.trim().split("\n").filter(Boolean)) {
    try {
      const json = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
      if (json.name) pkgs.set(json.name, { dir: join(ROOT, rel, ".."), exports: json.exports });
    } catch {
      // A malformed package.json is not this check's business.
    }
  }
  // A resolver that resolves nothing reaches nothing, and would pass every
  // assertion below. The repo has ~38 workspace packages; a collapse to a
  // handful means the roots or the find broke, not that packages left.
  if (pkgs.size < 20) {
    console.error(
      `workspace resolution found only ${pkgs.size} packages under ` +
        `${WORKSPACE_ROOTS.join(", ")} — too few to be a real result. Every reach ` +
        `measurement below would be meaningless.`,
    );
    process.exit(1);
  }
  return pkgs;
}

/**
 * Resolves `@barry-rocks/*` to real files through each package's `exports`
 * map, so the bag -> sdk/bag-host edge is genuinely traversed. Third-party
 * deps stay external; none are host-classed, so excluding them cannot hide
 * the edge under test.
 */
function workspacePlugin(pkgs) {
  return {
    name: "workspace",
    setup(b) {
      b.onResolve({ filter: /^@barry-rocks\// }, (a) => {
        let best = null;
        for (const name of pkgs.keys()) {
          if (a.path === name || a.path.startsWith(name + "/")) {
            if (!best || name.length > best.length) best = name;
          }
        }
        if (!best) return { external: true };
        const { dir, exports: exp } = pkgs.get(best);
        const sub = a.path === best ? "." : "./" + a.path.slice(best.length + 1);
        let target = exp?.[sub];
        if (target && typeof target === "object") target = target.types ?? target.default ?? target.import;
        if (typeof target !== "string") return { external: true };
        const p = resolve(dir, target);
        return existsSync(p) ? { path: p } : { external: true };
      });
    },
  };
}

async function reachOf(entry, witness, pkgs) {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true, write: false, metafile: true,
    platform: "node", format: "esm", logLevel: "silent",
    plugins: [workspacePlugin(pkgs)],
    packages: "external",
  });
  const inputs = Object.keys(result.metafile.inputs);
  return {
    hostHits: HOST_MODULES.filter((h) => inputs.some((i) => i.endsWith(h))),
    traversedWitness: inputs.some((i) => i.endsWith(witness)),
    moduleCount: inputs.length,
  };
}

const pkgs = workspacePackages();
const failures = [];

for (const [entry, witness] of BAG_ENTRYPOINTS) {
  if (!existsSync(join(ROOT, entry))) {
    failures.push(`${entry}: listed entrypoint does not exist (update this check or restore the file)`);
    continue;
  }
  let reach;
  try {
    reach = await reachOf(entry, witness, pkgs);
  } catch (err) {
    failures.push(`${entry}: could not be analyzed — ${String(err).split("\n").slice(0, 3).join(" ")}`);
    continue;
  }
  if (!reach.traversedWitness) {
    failures.push(
      `${entry}: did not traverse ${witness} (${reach.moduleCount} modules bundled). ` +
        `Either it no longer imports that module — pick another witness — or workspace ` +
        `resolution broke and this measurement is meaningless.`,
    );
    continue;
  }
  if (reach.hostHits.length > 0) {
    failures.push(`${entry}: reaches host-only ${reach.hostHits.join(", ")}`);
  }
}

/**
 * RULE 2: `sdk/` must not depend on `adapters/`.
 *
 * The dependency rule AGENTS.md states, asserted rather than trusted. It had
 * two standing exceptions until recently — `sdk/adapters/llms`'s `/registry`
 * subpath and `sdk/adapters/agents`'s side-effect import of the agent registry
 * — and both were removed by making each contract take a resolver as an
 * argument. Nothing stops a third from being added by a reasonable-looking
 * import except this.
 *
 * Read from package.json rather than from source: a declared dependency is
 * what makes the edge real for a consumer installing the package, and it is
 * the thing a reviewer skims past.
 */
/**
 * Implementation packages, found by WHERE they live rather than by name.
 *
 * This used to be a list of name prefixes (`@barry-rocks/adapter-`, and the two
 * registries). The adapters were later renamed to `@barry-rocks/claude`,
 * `@barry-rocks/ollama` and so on, the prefix stopped matching anything, and
 * rules 2 and 3 went on passing while able to catch only the registries. A
 * directory is the thing the tree layout actually promises, so it is what this
 * reads — and the count is asserted, so a move that empties the set fails here
 * instead of silently blinding both rules again.
 */
const IMPLEMENTATION_PACKAGES = new Set(
  [...pkgs].filter(([, { dir }]) => dir.slice(ROOT.length + 1).startsWith("adapters/")).map(([name]) => name),
);
if (IMPLEMENTATION_PACKAGES.size === 0) {
  failures.push(
    "found no implementation packages under adapters/ — rules 2 and 3 cannot catch anything",
  );
}

/**
 * Packages entitled to name an implementation, because they ARE composition
 * roots — the process that starts is allowed to choose what it ships.
 *
 * `sdk/cli` sits under sdk/ by location and is not a contract by role. It was
 * exempt implicitly while it lived at `cli/` and this rule only scanned `sdk/`;
 * the move made the exemption explicit, which is better — a reader can now see
 * that it is deliberate rather than an artifact of where the directory sat.
 * `sdk/engine` is the same: the MCP engine is the process that serves bag
 * tools, so it installs the models they reach. `builtin/identities/server` is
 * the identities service's entry point, split from its bag so that only the
 * process that starts names the vendor catalog it installs.
 */
const COMPOSITION_ROOT_PACKAGES = new Set([
  "barry",
  "@barry-rocks/sessions-api",
  "@barry-rocks/engine",
  "@barry-rocks/identities-service",
]);

let sdkPackagesChecked = 0;
for (const [name, { dir }] of pkgs) {
  const rel = dir.slice(ROOT.length + 1);
  if (!rel.startsWith("sdk/")) continue;
  sdkPackagesChecked += 1;
  if (COMPOSITION_ROOT_PACKAGES.has(name)) continue;
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(json.dependencies ?? {})) {
    if (IMPLEMENTATION_PACKAGES.has(dep)) {
      failures.push(
        `${rel}/package.json: ${name} depends on ${dep}. A contract must not name an ` +
          `implementation — take a resolver as an argument and let a composition root supply it.`,
      );
    }
  }
}
if (sdkPackagesChecked === 0) {
  failures.push("rule 2 inspected no sdk/ package — the rule is not running");
}

/**
 * RULE 3: a builtin bag must not depend on an implementation either.
 *
 * Same rule, one tree over, and the one that actually kept being violated:
 * four bags declared an LLM package they reached through a contract subpath,
 * and two named `@barry-rocks/ollama` outright. A bag that imports a
 * vendor has skipped the injection the composition root exists to perform, and
 * pins Barry to one backend for everyone who installs that bag.
 *
 * A service ENTRY POINT inside a bag is the exception, because it IS a
 * composition root — it is the process that starts, so it is entitled to name
 * what it ships. Listed by package, not waved through by filename, so a new
 * one is a deliberate decision.
 */
const COMPOSITION_ROOTS = COMPOSITION_ROOT_PACKAGES;
let builtinPackagesChecked = 0;
for (const [name, { dir }] of pkgs) {
  const rel = dir.slice(ROOT.length + 1);
  if (!rel.startsWith("builtin/")) continue;
  builtinPackagesChecked += 1;
  if (COMPOSITION_ROOTS.has(name)) continue;
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(json.dependencies ?? {})) {
    if (IMPLEMENTATION_PACKAGES.has(dep)) {
      failures.push(
        `${rel}/package.json: bag ${name} depends on ${dep}. Bags resolve an interface; ` +
          `the composition root injects the implementation at boot.`,
      );
    }
  }
}
if (builtinPackagesChecked === 0) {
  failures.push("rule 3 inspected no builtin/ package — the rule is not running");
}

/**
 * RULE 4: the vendors package depends on the SDK and nothing else.
 *
 * Every process that hosts a bag loads it — the API, the engine, the CLI, each
 * job — so one vendor SDK added here would be paid by all of them. A vendor is
 * its models and a few `fetch` calls; anything more belongs in a harness.
 */
const KIND_PACKAGES = ["adapters/sessions/completion", "adapters/embeddings", "adapters/decisions"];
const KIND_PACKAGE_DEPS = new Set(["@barry-rocks/sdk", "@barry-rocks/completion"]);
const kindPackagesChecked = [];
for (const kindDir of KIND_PACKAGES) {
  const found = [...pkgs].find(([, { dir }]) => dir.slice(ROOT.length + 1) === kindDir);
  if (!found) {
    failures.push(`rule 4 found no package at ${kindDir} — the rule is not running`);
    continue;
  }
  kindPackagesChecked.push(kindDir);
  const [name, { dir }] = found;
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(json.dependencies ?? {})) {
    if (!KIND_PACKAGE_DEPS.has(dep)) {
      failures.push(
        `${kindDir}/package.json: ${name} depends on ${dep}. ` +
          `Vendors are data plus plain HTTP; a vendor SDK belongs in a harness.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("boundary check FAILED:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nA bag must not reach host-only machinery. If a bag genuinely needs remote bag\n` +
      `discovery, take it as an injection the host installs — see\n` +
      `sdk/lib/src/host/remote-loader.ts and the dissolution record in barry-history.`,
  );
  process.exit(1);
}

console.log(
  `boundaries OK — ${BAG_ENTRYPOINTS.length} entrypoints each traversing its witness; ${kindPackagesChecked.length} vendor call packages checked; ` +
    `${sdkPackagesChecked} sdk/ and ${builtinPackagesChecked} builtin/ packages name none of the ` +
    `${IMPLEMENTATION_PACKAGES.size} implementation packages.`,
);
