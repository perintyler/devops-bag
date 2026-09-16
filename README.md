# devops

General repo operations: runtime environment audits.

## What it is

A skills-only bag — no tools, no server, no store. One skill:

- **`describe-environment`** describes the runtime environment of a repo,
  service, or app: env vars, dependencies, infrastructure.

Because it is skills-only, the auto-trait `devops` is what a session opts into,
and the skill comes with it.

## Layout

| path | what |
|---|---|
| `bag.yaml` | the manifest |
| `skills/` | the one skill, an `action.yaml` |

## History

`daily-pr-summary` used to live here and moved to a work-specific bag. It
resolves Linear tickets from branch names and posts to a particular Slack
workspace, so it belongs alongside the repos it reports on. This bag stays
general-purpose.
