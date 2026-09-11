# Upgrades

One file per upgrade, named `Upgrade_<yyyymmdd>_<WhatItDoes>.ts`, default-exporting an `UpgradeBase`
subclass. The file NAME is the key: it is what sorts them, what `AlteaUpgrade.txt` records, and what the
commit is called — so renaming a file that has already shipped makes it run again everywhere.

```ts
import { UpgradeBase } from "../UpgradeRunner.js";
import type { UpgradeContext } from "../UpgradeContext.js";

export default class Upgrade_20260915_RenameStackScripts extends UpgradeBase {
    get description(): string { return "stack:postgres → stack <environment>"; }

    execute(uctx: UpgradeContext): void {
        uctx.changeCodeFile("eastwind/package.json", file => {
            file.replace(`"stack:postgres"`, `"stack"`);
        });
    }
}
```

`eastwind` in any path is substituted for the application's real name, so an upgrade is written against
the demo application and replayed against whatever it was renamed to.

## Writing one

Upgrades are replayed against source that has DRIFTED from the demo application, so every helper reports
when what it meant to change is not there. Choose the level deliberately:

- `WarningLevel.Error` (the default) — this should have been here; a miss is a broken upgrade.
- `WarningLevel.Warning` — it may legitimately be absent (an optional module this app removed).
- `WarningLevel.None` — a best-effort sweep over many files.

The runner prints whichever level was reached, so an upgrade that half-applied says so rather than
finishing green.

## The tools

| On `UpgradeContext` | |
| --- | --- |
| `changeCodeFile(path, file => …)` | open one file, edit, save only if changed |
| `forEachCodeFile("*.ts,*.tsx", file => …)` | the same over a whole tree |
| `createCodeFile` / `deleteFile` / `moveFile` / `deleteDirectory` | |
| `changeWorkspace(file => …)` | `pnpm-workspace.yaml` — altea's counterpart of Signum's `.sln` helpers |

| On `CodeFile` | |
| --- | --- |
| `replace` / `replaceWith` / `contains` | whole-content |
| `replaceLine` / `removeAllLines` / `insertBefore\|AfterFirst\|LastLine` | one line |
| `replaceBetweenIncluded\|Excluded` / `removeBetweenIncluded` / `getLinesBetween…` | a span |
| `getMethodBody` / `replaceMethod` | a method, found by its declaration line |
| `addNpmPackage` / `updateNpmPackage` / `removeNpmPackage` | `package.json` |
| `replacePartsInImport` / `moveImport` | TypeScript imports |
| `moveTo` | rename the file when it is saved |

A span bound can be a bare predicate or a `SpanOption` — `{ condition, delta, lastIndex, sameIndentation }`.
`sameIndentation` is what makes "the closing brace of THIS block" work without a parser.
