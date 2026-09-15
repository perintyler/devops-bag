# devops

General repo operations: daily PR summaries and runtime environment audits.

## What it is

A skills-only bag — no tools, no server, no store. Two skills:

- **`daily-pr-summary`** reports today's PR activity (opened, in-review,
  shipped, closed, drafts) through the GitHub CLI. Written for a Slack-ready
  list, so it is the one to reach for when asked for a daily report.
- **`describe-environment`** describes the runtime environment of a repo,
  service, or app: env vars, dependencies, infrastructure.

Because it is skills-only, the auto-trait `devops` is what a session opts into,
and the skills come with it.

## Before you change anything here

`daily-pr-summary` shells out to `gh`. If it reports nothing, check that `gh` is
authenticated before concluding there was no PR activity — an unauthenticated
`gh` and a quiet day look the same from the output.

## Layout

| path | what |
|---|---|
| `bag.yaml` | the manifest |
| `skills/` | the two skills, each an `action.yaml` |
