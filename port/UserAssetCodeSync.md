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
| `CodeSyncMixin.keepOnSync` | An INTENT: the sync must not overwrite or delete this asset. |

There is **no stored copy of the code version**: the file in the folder IS the code version. And nothing
stored claims that a row equals its file. That is always COMPUTED (see "The comparison"), because files
change behind the application's back: a git rollback, a pull, a branch switch, a new XML format.

`keepOnSync` only answers "should the next sync overwrite this blindly?". It is set by a hand edit where
files are not written, cleared by a sync that finds the row identical, by applying the file, and by a zip
import (unless asked to keep), and it can be toggled in the panel.

Each asset carries the mixin through `@mixin(() => [CodeSyncMixin])` on its class, so the field exists on
both tiers in every application that uses the asset module. The app turns the feature on with
`AssetSyncLogic.start(sb, { root })` and `AssetSyncClient.start(cb)`. The save hooks are installed on
`schemaCompleted` for every table that declares the mixin AND has a registered XML serializer, so the call
may come before the asset modules.

## Writing files: `AUTO_SAVE_ASSET_FILES`

A save also writes the asset's file only with `AUTO_SAVE_ASSET_FILES=true` in the process environment,
an opt-in for a developer's checkout working against its OWN database (`.env.local`, next to
`EASTWIND_DISPOSABLE_DB` and `VITE_PASSWORD_IS_USERNAME`). Everywhere else it is off. That includes every
server, and a developer machine pointed at a shared database.

The default matters more than it looks. Writing files where they are not the code version is not harmless:

- **On a server**, the asset folder is the deployed commit. A save that wrote it would make the row equal
  its (temporary) file. A sync then clears `keepOnSync`, and the next deployment replaces the folder and
  overwrites the edit.
- **From a developer machine on a shared database**, the file lands in the developer's checkout, not in the
  folder the database is synced from. Same loss, one deployment later.

Off, a save just marks the asset `keepOnSync`, which is true from any machine. `NODE_ENV` is the wrong
signal: it is a Node build/runtime switch, and a test or staging server need not set it.

## The files

```
<root>/                                   the app's asset root (one directory, passed to start())
  customer/                               a sync folder = a SyncFolderEntity
    Orders by customer.UserQuery.xml      one asset per file, as its ROOT element: <UserQuery Guid="…">…</UserQuery>
    Sales.Dashboard.xml
    Invoice.OfficeTemplate.xml            <Template FileName="invoice.docx" Path="Invoice.OfficeTemplate/invoice.docx"/>
    Invoice.OfficeTemplate/invoice.docx   the sidecar: binaries are files, never base64, in this mode
```

- There is no per-type directory. The sync folder groups by business area, and the type is in the filename.
- The filename (`<name>.<Type>.xml`) is cosmetic. The `Guid` inside is the identity, so renaming a file
  changes nothing. On a name collision the writer appends the first 8 characters of the uuid.
- There is no `<Entities>` wrapper: a file is always exactly one asset. The parser accepts both shapes, so a
  folder file can still go through the classic import page, and files written with the wrapper still read.
- **Binaries**: the (de)serializers write and read bytes through `ctx.binary` (`BinaryStore`), never base64
  themselves. The classic export inlines base64, as before and as Signum does. Folder mode writes a sidecar
  under `<name>.<Type>/` and puts a `Path` attribute on the element. When reading, either form is accepted.
- **References between assets** (a dashboard's user queries, a chart's drilldowns, a toolbar's elements)
  are written as the referenced asset's LONG lite key (Signum's `KeyLong`), `UserQuery;<guid>;Next Orders`:
  `ctx.include` returns it and `ctx.getEntity` resolves it, in this mode and in the one-file export alike.
  The type and name are redundant but make a file and a diff readable. Only the Guid is the identity, so
  `Type;<guid>` and a bare Guid (what older files hold) are read too. Renaming an asset leaves its old name in
  the files that reference it until they are written again ("Rewrite files"), which changes nothing they mean.
  files are written, an asset with a sync folder may only reference assets that also have one (any
  folder), and a save that breaks the rule fails.

## The comparison

"Identical" means **applying the file would not change the row**. The file is applied, with the current
importer, onto a fresh COPY of the row, and `isGraphModified` is asked. That compares meaning, not text:

- A change of XML FORMAT (attribute order, indentation, a renamed attribute the importer still reads) is
  not a difference.
- A field the XML does not carry keeps the row's value, so it is not a difference either.
- A referenced asset resolves to an identity-only stub (clean, not new), so the comparison stops at the
  asset itself and is not affected by what else is pending.

It relies on every serializer REUSING what it reads, never rebuilding it: a rebuilt row is new, and new is
modified. Rows with their own id in the XML go through `syncRows`; rows without one through
`positionalRows`; a dashboard part keeps its content entity when the type is unchanged; a symbol is resolved
from the symbol cache, and kept when its key is unchanged.

A boolean attribute is written `IsQueryCached="true"`. fast-xml-parser's builder defaults to writing a bare
`IsQueryCached`, which is not XML and read back as absent; files written that way are still read as true.

What the user sees is that comparison plus the flag: "Differs from code — will be overwritten on the next
sync", "Not in code — kept on the next sync", and so on. That's on the asset's form (a "Top" embedded
widget) and in the panel.

## Saving

| Where | Database | Files | `keepOnSync` |
| --- | --- | --- | --- |
| `AUTO_SAVE_ASSET_FILES=true` | saved | written in `preRealCommit` | false |
| anywhere else | saved | — | true |

The file is written in `preRealCommit`, so a file that cannot be written (locked, read-only, a path too long)
rolls the save back. The opposite failure — the files written, then the COMMIT failing — leaves the
repository ahead of the database, which is the safe side. Renaming the asset renames the file, changing its
folder moves it, and clearing the folder or deleting the asset deletes the file.

Saves made BY the sync, the zip import or the panel never apply these rules: they set the flag
themselves.

**A container's folder moves its children.** When a save changes an asset's folder, every asset it references
follows: the same references its export writes as Guids, so a toolbar's menus and contents, a dashboard's
queries and charts, a query's drilldowns. A child follows if it had NO folder or the PREVIOUS one; a child in
a third folder keeps it. Clearing the folder clears the children that had the previous one. Each child is
saved normally, so its own children follow in turn, and with files written each one's file moves with it.
The previous folder is read in `saving`, while the row still holds it; the children are saved in `saved`,
before the container's own file is exported (which requires them to have a folder).

An asset owned by a USER with a sync folder gets a warning in the UI, not an error: users differ between
environments.

## Syncing code → database

`AssetSyncLogic.syncFromCode()` runs in one transaction. It is reached from
`pnpm --filter eastwind terminal <env> sync-assets [folder…]`, from the panel, and from the `SyncFromCode`
operation on a `SyncFolderEntity`. All folders are parsed, so a cross-folder reference resolves; only the
requested folders are applied. Every asset is CLASSIFIED before anything is applied.

| File | Row | Result |
| --- | --- | --- |
| present | absent | created |
| present | identical | unchanged; a moved folder is updated, and `keepOnSync` is cleared (the code caught up) |
| present | different, not kept | overwritten from the file |
| present | different, kept | **kept**, reported |
| absent | not kept | deleted |
| absent | kept | left as it is, reported as "not in code" |
| folder directory gone | rows in that folder | a FULL sync treats it as empty (git keeps no empty directory); a per-folder sync leaves them |
| no folder at all | — | the sync aborts: a missing checkout must not delete every synced asset |

Deletes go in reverse registration order, so containers (a toolbar) go before what they show (a dashboard).

`DiscardDbChanges` ("apply file" in the panel) re-applies one asset's file and clears its flag. It is one
operation symbol on every asset type: registered on the first type, with the others joining through
`OperationLogic.registerForType`. It is `canBeModified: false`, because it replaces the STORED row, so
whatever the client holds is irrelevant.

`SyncFolderEntity` can always be created by hand. Where files are written, saving one also creates its
directory; elsewhere it is only a row until assets in it are committed and deployed. Its name is read-only
once saved (`@isReadOnly`, which also gates the serializer): the files of the assets it holds live under
it, so a rename would have to move them.

## Zip: database ↔ repository

- **Download** (the "Download zip" quick-link on a folder, `GET /api/assetSync/zip/:folderId`) exports the
  folder's assets as the DATABASE has them, written as the development writer would, sidecars included. A file
  keeps the name it has in the deployed folder, so unzipping replaces it rather than adding a second file
  with the same Guid (the scan refuses that).
- **Upload** (the import page accepts a `.zip`) previews New / Different / Identical against the database,
  then applies the zip to the DATABASE, like a sync from it. The assets take the zip's folders and are NOT
  kept on sync, unless "Keep through the next sync" is ticked. So an upload on a server is TEMPORARY: the
  next deployment puts back whatever the code has, and deletes what only the upload brought, unless the
  same files were committed by then. The same contract as a translation edited in a container. Files are
  written only where a save would write them, so on a developer machine an upload is "unzip into my
  checkout".

The round trip: edit or upload on a server → download the zip → unzip into the repo → commit → deploy → the
sync finds the rows identical to their new files and clears the flags.

## The panel

`/assetSync` (also the "Asset sync" quick-link on a folder) lists every file and every synced row with its
computed comparison and its flag. Actions:

- show differences: a line/word diff (altea-diff-log's `DiffDocument`) from the file to the database export;
- apply file;
- toggle keep on sync;
- write file (where files are written);
- sync from code;
- rewrite files (where files are written): re-exports every IDENTICAL asset, so the files take the
  current XML format in one commit after an upgrade.

Everything is gated by `UserAssetPermission.UserAssetsToXML`.
