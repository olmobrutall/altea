# User-asset code sync (altea-only, no Signum original)

A user asset (UserQuery, UserChart, Dashboard, Toolbar, Tour, Workflow, EmailTemplate, OfficeTemplate, …)
can be **controlled by code**: a copy of it lives as an XML file in the application's repository, and every
deployment brings the database in line with those files. It replaces the error-prone habit of remembering
that an asset changed and writing a TypeScript migration that re-imports it.

It is an ADDITION. The one-file `UserAssets.xml` export / import / preview is unchanged and shares the same
per-type `toXml` / `fromXml` (de)serializers.

## The model

| Piece | What it is |
| --- | --- |
| `SyncFolderEntity` | A shared string (`name`, unique). Created by the sync, one per directory under the asset root. |
| `CodeSyncMixin.syncFolder` | Set ⇒ the asset is controlled by code and lives in that folder. Null ⇒ a plain database asset. |
| `CodeSyncMixin.codeSyncState` | `InSync` / `ModifiedInDb`; null when there is no sync folder. |

There is **no stored copy of the code version**. The file in the folder IS the code version, and
`codeSyncState = InSync` means "the row equals the file as of the last sync". That is why no column is
duplicated.

Each asset carries the mixin through `@mixin(() => [CodeSyncMixin])` on its class, so the field exists on
both tiers in every application that uses the asset module. The app turns the feature on with
`AssetSyncLogic.start(sb, { root, writeFiles })` and `AssetSyncClient.start(cb)`. The save hooks are
installed on `schemaCompleted` for every table that declares the mixin AND has a registered XML
serializer, so the call may come before the asset modules. The client shows the folder, the state and the
personal-asset warning as a "Top" embedded widget on every such type.

## The files

```
<root>/                                   the app's asset root (one directory, passed to start())
  customer/                               a sync folder = a SyncFolderEntity
    Orders by customer.UserQuery.xml      one asset per file: <Entities><UserQuery Guid="…">…</UserQuery></Entities>
    Sales.Dashboard.xml
    Invoice.OfficeTemplate.xml            <Template FileName="invoice.docx" Path="Invoice.OfficeTemplate/invoice.docx"/>
    Invoice.OfficeTemplate/invoice.docx   the sidecar: binaries are files, never base64, in this mode
```

- There is no per-type directory. The sync folder groups by business area, and the type is in the filename.
- The filename (`<name>.<Type>.xml`) is cosmetic. The `Guid` inside is the identity, so renaming a file
  changes nothing. On a name collision the writer appends the first 8 characters of the uuid.
- Every file is a valid `UserAssets.xml` with one element, so it can also go through the classic import page.
- **Binaries**: the (de)serializers write and read bytes through `ctx.binary` (`BinaryStore`), never base64
  themselves. The classic export inlines base64, as before and as Signum does. Folder mode writes a sidecar
  under `<name>.<Type>/` and puts a `Path` attribute on the element. When reading, either form is accepted.
- **References between assets** (a dashboard's user queries, a chart's drilldowns, a toolbar's elements)
  are written as Guids. Unlike the classic export, they are not inlined: each asset is its own file. An asset
  with a sync folder may only reference assets that also have one (any folder). The export enforces that
  rule, so a save that breaks it fails.

## Saving

- **`writeFiles: true`** (development): saving an asset with a sync folder exports it, and the file and
  sidecars are written in `preRealCommit`, so a file that cannot be written (locked, read-only, a path
  too long) rolls the save back. The opposite failure — the files written, then the COMMIT failing — leaves
  the repository ahead of the database, which is the safe side: the file is the code version, and the next
  sync applies it. Renaming the asset renames the file. Changing the folder moves it.
  Clearing the folder or deleting the asset deletes the file. The state stays `InSync`.
- **`writeFiles: false`** (production): a save that actually changes the asset marks it `ModifiedInDb`.
- Saves made BY the sync never mark anything and never write files.
- An asset owned by a USER with a sync folder gets a warning in the UI, not an error. Users differ between
  environments, so such an asset rarely makes sense in code.

## Syncing code → database

`AssetSyncLogic.syncFromCode()`, reached from the terminal and from the `SyncFromCode` operation on a
`SyncFolderEntity`, runs in one transaction. All folders are parsed, so a cross-folder reference resolves.
Only the requested folders are applied.

| File | Row | Result |
| --- | --- | --- |
| present | absent | created, `InSync` |
| present | `InSync`, a DB-only row with the same Guid, or a different folder | overwritten from the file, `InSync` |
| present | `ModifiedInDb`, identical to the file | state reset to `InSync` |
| present | `ModifiedInDb`, different | **kept** and reported |
| absent | `InSync` | deleted |
| absent | `ModifiedInDb` | sync folder cleared (it becomes a DB-only asset) and reported |
| folder directory gone | rows in that folder | a FULL sync treats it as empty (git keeps no empty directory); a per-folder sync leaves them |
| no folder at all | — | the sync aborts: a missing checkout must not delete every synced asset |

"Identical" means **writing the row now would reproduce the file**: the row is exported exactly as the
development writer would (same `<name>.<Type>` for the sidecar paths), parsed, and compared with the parsed
file, ignoring attribute order. The sidecar bytes are compared too. An identical row is never rewritten.
Applying the file and asking `isGraphModified` does not work here, because a serializer that rebuilds a
collection's rows (the email messages, the template document `FileEntity`) would report a change every time.

Deletes go in reverse registration order, so containers (a toolbar) go before what they show (a dashboard).

`DiscardDbChanges` is one operation symbol on every asset type: it is registered on the first type, and the
others join through `OperationLogic.registerForType`. It is `canBeModified: false`, because it replaces
the STORED row with its file, so whatever the client is holding is irrelevant. A row with no sync folder
cannot run it.

`SyncFolderEntity` has a Save operation only where saves write files (development), and saving one creates
its directory. Everywhere else a folder exists because its directory does.

Entry points: `pnpm --filter eastwind terminal <env> sync-assets [folder…]` and the `SyncFromCode` operation.
The operation has no result page yet; to find what was kept, query the assets whose `codeSyncState` is
`ModifiedInDb`.

## Production → repository

`GET /api/assetSync/zip/:folderId` (the "Download zip" quick-link on the folder) returns a zip of every
asset in the folder, exported exactly as the development writer does, sidecars included. A file keeps the
name it has in the deployed folder, so unzipping replaces it rather than adding a second file with the
same Guid (the scan refuses that). Unzip it over `<root>/<folder>`, and `git diff` shows what
changed in production. After the next deployment the sync finds the files identical, and the flags reset.
