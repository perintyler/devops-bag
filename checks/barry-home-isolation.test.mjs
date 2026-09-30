/**
 * BARRY_HOME moves every store — proven by resolving and opening them all with
 * HOME pointed at a decoy, then checking the decoy is still empty.
 *
 * The decoy HOME matters: without it a regression would write into the
 * developer's real ~/.barry, the one place this test exists to protect. With
 * it, a store that ignores BARRY_HOME lands in the decoy and fails here.
 *
 * Per-store overrides (BARRY_SESSIONS_DB, …) are removed first — they win over
 * BARRY_HOME by design, so leaving any set would test the override instead.
 *
 * Run: pnpm check:barry-home
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const decoyHome = mkdtempSync(join(tmpdir(), "barry-decoy-home-"));
const barryHomeDir = mkdtempSync(join(tmpdir(), "barry-home-"));
for (const key of Object.keys(process.env)) {
  if (/^BARRY_.*(_DB|_SNAPSHOT|_BUILD_DIR|_CONFIG)$/.test(key) || key === "BARRY_HOME") delete process.env[key];
}
process.env.HOME = decoyHome;
process.env.BARRY_HOME = barryHomeDir;
// A fresh config store is empty on purpose here; its guard refuses that otherwise.
process.env.BARRY_CONFIG_ALLOW_EMPTY = "1";

const root = process.cwd();
const load = (p) => import(join(root, p));

test("every store path resolves under BARRY_HOME", async () => {
  const paths = {
    actions: (await load("builtin/actions/src/db.ts")).getDbPath(),
    events: (await load("builtin/events/src/db.ts")).getDbPath(),
    tracker: (await load("builtin/filesystem/tracker/src/db.ts")).getDbPath(),
    config: (await load("sdk/cli/src/lib/config-db.ts")).configDbPath(),
    identities: (await load("builtin/identities/src/store/identities-db.ts")).identitiesDbPath(),
    identityDirs: (await load("builtin/identities/src/paths.ts")).getIdentitiesDir(),
    memory: (await load("builtin/memory/src/db.ts")).getDbPath(),
    vectors: (await load("builtin/embeddings/src/db.ts")).getDbPath(),
    schedules: (await load("builtin/schedules/src/db.ts")).getDbPath(),
    todos: (await load("builtin/todos/src/db.ts")).getDbPath(),
    sessions: (await load("builtin/sessions/src/store/sessions-db.ts")).sessionsDbPath(),
    apiUsage: (await load("builtin/sessions/api/src/telemetry.ts")).usageDbPath(),
    logs: (await load("builtin/telemetry/logs/src/store.ts")).logsDbPath(),
    metrics: (await load("builtin/telemetry/src/store.ts")).defaultDbPath(),
    errors: (await load("builtin/telemetry/src/usage/errors.ts")).errorsDbPath(),
    requests: (await load("builtin/telemetry/src/usage/requests.ts")).requestsDbPath(),
    usage: (await load("builtin/telemetry/src/usage/telemetry.ts")).usageDbPath(),
    bagCache: (await load("sdk/lib/src/host/cache.ts")).getBagCacheDir("x"),
    appSupport: (await load("sdk/lib/src/host/paths.ts")).getIdentitySupportDir(),
    buildCache: (await load("sdk/lib/src/host/paths.ts")).getBarryCacheDir(),
    registrySnapshot: (await load("sdk/lib/src/host/paths.ts")).getRegistrySnapshotPath(),
    configDir: (await load("sdk/lib/src/services/home.mjs")).barryConfigDir(),
    logsDir: (await load("sdk/lib/src/services/home.mjs")).barryLogsDir(),
  };
  const outside = Object.entries(paths).filter(([, p]) => !(p === barryHomeDir || p.startsWith(barryHomeDir + "/")));
  assert.deepEqual(outside, [], "stores resolving outside BARRY_HOME");
});

test("opening stores writes nothing into HOME", async () => {
  // The locks store keeps its path private; the open handle knows it.
  const locksPath = (await load("builtin/filesystem/locks/src/db.ts")).getDb().name;
  const sessions = await load("builtin/sessions/src/store/sessions-db.ts");
  sessions.getSessionsSqlite();
  const config = await load("sdk/cli/src/lib/config-db.ts");
  config.getConfigSqlite();
  const identities = await load("builtin/identities/src/store/identities-db.ts");
  identities.getIdentitiesSqlite();
  const metrics = await load("builtin/telemetry/src/store.ts");
  metrics.openDb().close();

  assert.deepEqual(readdirSync(decoyHome), [], "decoy HOME was written to");
  const opened = [
    locksPath,
    sessions.sessionsDbPath(),
    config.configDbPath(),
    identities.identitiesDbPath(),
    metrics.defaultDbPath(),
  ];
  for (const f of opened) {
    assert.ok(f.startsWith(barryHomeDir + "/"), `${f} is outside BARRY_HOME`);
    assert.ok(existsSync(f), `${f} was not created`);
  }
});
