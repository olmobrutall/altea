# altea CLIs

Three command-line tools that work on an altea APPLICATION's source, plus the package they share.
Separate commands because a developer reaches for them at different moments; separate packages so each
stands alone.

| | |
| --- | --- |
| [`altea-cli-utils`](altea-cli-utils) | Not a command — the plumbing the three share: locating the application in the workspace, the casing-aware rename, git, the console, argument parsing. |
| [`altea-upgrade`](altea-upgrade) | Apply the pending SOURCE upgrades to this application, one at a time — Signum.Upgrade's counterpart. Also holds the toolkit an upgrade is written with. |
| [`altea-clone`](altea-clone) | Copy this application into a NEW project, renamed, with its own git repository and the altea submodule pinned to the same commit. |
| [`altea-simplify`](altea-simplify) | Remove the optional modules an application does not need, following its `Modules.xml`. Also validates that file (`--check`). |

```
altea-cli-utils  ←  altea-upgrade
                 ←  altea-clone
                 ←  altea-simplify   (+ fast-xml-parser)
```

**No CLI depends on another CLI.** `altea-clone` needing `Git` is not a reason for it to depend on
`altea-upgrade`; the common half has a package of its own, and that package depends on nothing.

## What they must NOT depend on

Nothing here imports `@altea/altea`. Not tidiness — each tool runs where the framework could not be
relied on:

- **`altea-clone` CREATES the project** a dependency would have to be installed into.
- **`altea-upgrade` edits source that does not compile.** That is frequently what an upgrade exists to
  fix, so the tool must not be built on the thing it is repairing.
- **`altea-simplify` deletes whole modules**, and has to keep working while the result temporarily does
  not build.

So `altea-cli-utils` replaces the two pieces that came from the framework:

| was | now |
| --- | --- |
| `@altea/altea`'s `SafeConsole` + chalk | [`Console.ts`](altea-cli-utils/Console.ts) — the same prompts, raw SGR escapes, suppressed when stdout is not a TTY or `NO_COLOR` is set |
| `UpgradeContext`'s discovery half | [`ApplicationContext.ts`](altea-cli-utils/ApplicationContext.ts) — where the application is, what it is called, and the `eastwind` → `<name>` rename. `UpgradeContext` extends it with the source-EDITING half, which only `altea-upgrade` uses |

They also do not extend altea's tsconfig preset — that configures the quote-transformer ts-patch plugin,
and nothing here touches an entity or a query. Plain `tsc`.

`fast-xml-parser` stays: `Modules.xml` is XML, and a hand-rolled reader for it would be a second parser to
maintain for no gain.

## Using them

```bash
pnpm --filter @altea/altea-clone build     # or: cd cli/altea-clone && npx tsc -b
node cli/altea-clone/dist/main.js --help
```

The usual first-run sequence for a new application:

```bash
node <altea>/cli/altea-clone/dist/main.js --name northbreeze
cd ../northbreeze
node <altea>/cli/altea-simplify/dist/main.js     # untick what you do not need; one commit per module
pnpm install
pnpm --filter quote-transformer build
pnpm --filter northbreeze build:types
```

`altea-clone` prints those lines with the real paths filled in, because in a project that has not been
installed yet the CLIs are neither linked onto `PATH` nor built — but the one you just ran is, and its
sibling sits beside it.

**`altea-simplify` comes BEFORE `pnpm install`.** Every command here insists on a clean git tree, since
the diff is the only review there is, and installing first can leave the lockfile modified. The clone
copies `pnpm-lock.yaml` for the same reason: the new project's first install then reproduces the source's
resolution instead of inventing its own.

## Not ported from Signum.Upgrade

- `UpdateNugetReference*` / `AddNugetReference` / `RemoveNugetReference` — no NuGet. The npm equivalents
  are ported, and gain the `workspace:*` case Signum has no counterpart for.
- `Solution_AddProject` / `Solution_RemoveProject` / `Solution_AddFolder` / `Solution_AddSolutionItem` —
  no `.sln`. The counterpart is a `pnpm-workspace.yaml` entry, which `UpgradeContext.changeWorkspace` edits.
- `LibGit2Sharp` — no maintained JS equivalent, and it would be a dependency. `Git` shells out to the
  `git` every developer already has.
