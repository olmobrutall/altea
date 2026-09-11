# altea CLIs

Three command-line tools that work on an altea APPLICATION's source. They are separate commands because a
developer reaches for them at different moments, and separate packages so each installs on its own.

| | |
| --- | --- |
| [`altea-upgrade`](altea-upgrade) | Apply the pending SOURCE upgrades to this application, one at a time — Signum.Upgrade's counterpart. Also holds the toolkit an upgrade is written with. |
| [`altea-clone`](altea-clone) | Copy this application into a NEW project, renamed, with its own git repository and the altea submodule pinned to the same commit. |
| [`altea-simplify`](altea-simplify) | Remove the optional modules an application does not need, following its `Modules.xml`. |

The usual first-run sequence for a new application:

```bash
altea-clone --name northbreeze     # from inside an existing altea workspace
cd ../northbreeze
altea-simplify                     # untick what you do not need; one commit per module
pnpm install
pnpm --filter quote-transformer build
pnpm --filter northbreeze build:types
```

`altea-simplify` comes BEFORE `pnpm install` on purpose: it is pure text editing and needs no dependencies,
and installing first leaves an untracked `pnpm-lock.yaml` that it would then refuse to work over (every
command here insists on a clean git tree, because the diff is the only review there is).

## Why `altea-clone` and `altea-simplify` depend on `altea-upgrade`

The shared layer — finding the application in the workspace, the casing-aware rename, git, the console
prompts, and `CodeFile`'s source editing — lives in `altea-upgrade`, because it IS the upgrade-writing API:
an upgrade script's whole vocabulary is `UpgradeContext` + `CodeFile`. The other two need only a corner of
it, which is not enough to earn a fourth package. The cost is a dependency edge that reads oddly; the
alternative was an `altea-cli-core` nobody would ever invoke.

## Not ported from Signum.Upgrade

- `UpdateNugetReference*` / `AddNugetReference` / `RemoveNugetReference` — no NuGet. The npm equivalents
  are ported, and gain the `workspace:*` case Signum has no counterpart for.
- `Solution_AddProject` / `Solution_RemoveProject` / `Solution_AddFolder` / `Solution_AddSolutionItem` —
  no `.sln`. The counterpart is a `pnpm-workspace.yaml` entry, which `UpgradeContext.changeWorkspace` edits.
- `LibGit2Sharp` — Node has no maintained equivalent, so `Git` shells out to the `git` every developer
  already has.
