# altea CLIs

Three command-line tools that work on an altea APPLICATION's source. Separate commands because a developer
reaches for them at different moments; separate packages so each stands alone.

| | |
| --- | --- |
| [`altea-upgrade`](altea-upgrade) | Apply the pending SOURCE upgrades to this application, one at a time — Signum.Upgrade's counterpart. Also holds the toolkit an upgrade is written with. |
| [`altea-clone`](altea-clone) | Copy this application into a NEW project, renamed, with its own git repository and the altea submodule pinned to the same commit. |
| [`altea-simplify`](altea-simplify) | Remove the optional modules an application does not need, following its `Modules.xml`. Also validates that file (`--check`). |

The usual first-run sequence for a new application:

```bash
altea-clone --name northbreeze     # from inside an existing altea workspace
cd ../northbreeze
altea-simplify                     # untick what you do not need; one commit per module
pnpm install
pnpm --filter quote-transformer build
pnpm --filter northbreeze build:types
```

`altea-simplify` comes BEFORE `pnpm install` on purpose: it needs no dependencies (see below), and
installing first leaves an untracked `pnpm-lock.yaml` that it would then refuse to work over — every
command here insists on a clean git tree, because the diff is the only review there is.

## No dependencies

All three declare an empty `dependencies`. Their imports are **node builtins and relative paths, nothing
else** — no framework, no npm packages.

That is not tidiness, it is what makes them work:

- **`altea-clone` creates the project a dependency would have to be installed into.** It has to run before
  that project exists.
- **`altea-simplify` runs before `pnpm install`**, for the reason above.
- **`altea-upgrade` edits source that does not compile.** That is frequently the situation an upgrade
  exists to fix, so the tool must not be built on the thing it is repairing.

What it cost, and what replaced it:

| was | now |
| --- | --- |
| `@altea/altea`'s `SafeConsole` + chalk | [`altea-upgrade/Console.ts`](altea-upgrade/Console.ts) — the same prompts, raw SGR escapes, suppressed when stdout is not a TTY or `NO_COLOR` is set |
| `fast-xml-parser` | [`altea-simplify/Xml.ts`](altea-simplify/Xml.ts) — ~180 lines for the subset `Modules.xml` uses. Anything outside it (CDATA, DTDs, mixed content, namespaces) THROWS with a line number rather than guessing |
| `quote-transformer` (pulled in by altea's tsconfig preset) | a standalone tsconfig. These tools never touch an entity or a query, so they need no transformer — and they build with plain `tsc` |
| a package dependency between them | relative imports. `altea-clone` and `altea-simplify` set `rootDir` to the `cli/` folder and compile `altea-upgrade`'s shared sources into their own `dist`, so the source has ONE home and the emitted `../altea-upgrade/Git.js` resolves the same before and after emit |

`tsc` itself is still needed to BUILD them; nothing is needed to RUN them.

```bash
pnpm --filter @altea/altea-clone build      # or: cd cli/altea-clone && npx tsc
node cli/altea-clone/dist/altea-clone/main.js --help
```

## Not ported from Signum.Upgrade

- `UpdateNugetReference*` / `AddNugetReference` / `RemoveNugetReference` — no NuGet. The npm equivalents
  are ported, and gain the `workspace:*` case Signum has no counterpart for.
- `Solution_AddProject` / `Solution_RemoveProject` / `Solution_AddFolder` / `Solution_AddSolutionItem` —
  no `.sln`. The counterpart is a `pnpm-workspace.yaml` entry, which `UpgradeContext.changeWorkspace` edits.
- `LibGit2Sharp` — no maintained JS equivalent, and it would be a dependency. `Git` shells out to the
  `git` every developer already has.
