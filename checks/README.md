# Barry repository checks

This standalone package owns Barry's architecture guards, audits, test discovery,
and the regression tests for those checks. It installs independently of the bag:

```sh
pnpm --dir checks install --ignore-workspace --frozen-lockfile
node checks/run.mjs /path/to/barry check:bag-host-reach
node checks/run.mjs /path/to/barry test:ci:unit --scope=sdk
pnpm --dir checks test
```

Every task runs against the explicit Barry checkout, including its source files,
workspace inventory, lint configuration and installed test tools. Dependencies
needed by the checks themselves belong to this package. Checks that load runtime
stores use a temporary `BARRY_HOME` and decoy `HOME`.

Barry's `ci/devops.json` pins the public checks package by full commit SHA.
Its launcher fetches and installs that revision on first use, then caches it
under `node_modules/.cache/barry-devops/`. Fetch, install and check failures fail
CI; a missing checkout never means success. Test lanes watch `ci/**`, so changing
the pin or launcher runs every suite.

To test an unpublished change, set `BARRY_DEVOPS_DIR` to this bag's checkout.
Install this package first, then run Barry's usual `pnpm check:*` commands.
The local Docker launcher mounts this checkout and installs the package in its
own container volume.

The public `perintyler/devops-bag` repository receives only this package's
`files` entries under `checks/`; the private bag's operating scripts stay in
its source repository. Publish the package before updating Barry's pin.

To prepare a public update, run `pnpm --dir checks pack --pack-destination /tmp/checks-package`,
then extract the tarball into `checks/` in a checkout of `perintyler/devops-bag`
with `--strip-components=1`. Review that directory's diff, commit and push it,
then put that commit SHA in Barry's `ci/devops.json`. Packing applies the
package's allowlist and excludes the other operational checks in this bag.
