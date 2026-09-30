/**
 * Whether a path is something the checkout tracks, for checks that verify
 * references to repo paths.
 *
 * "It exists on disk" is the wrong test: an ignored leftover (an old package's
 * node_modules, at adapters/llms and then adapters/agents) kept dead links and
 * stale paths passing locally while a fresh clone had nothing there. A path
 * counts when it is a file in the index or a directory above one. Outside the
 * repository only the disk can say.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function trackedPaths(repoRoot) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tracked = new Set();
  for (const file of out.split("\0").filter(Boolean)) {
    tracked.add(file);
    for (let dir = path.posix.dirname(file); dir !== "." && !tracked.has(dir); dir = path.posix.dirname(dir)) {
      tracked.add(dir);
    }
  }
  return (abs) => {
    const rel = path.relative(repoRoot, abs);
    if (rel === "") return true;
    if (rel.startsWith("..") || path.isAbsolute(rel)) return existsSync(abs);
    return tracked.has(rel.split(path.sep).join("/"));
  };
}
