# Signum.Files → @altea/altea-files

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Files/`

The remote backends have their own page: [FileStores.md](FileStores.md)
(`@altea/altea-files-azure`, `@altea/altea-files-s3`).

## Four ways to hold a file; altea ports three

Signum offers four, along two axes — where the BYTES live, and whether the file is its own ROW:

|                | bytes in the row | bytes in a store |
| --- | --- | --- |
| **embedded**   | `FileEmbedded`   | `FilePathEmbedded` |
| **its own row**| `FileEntity`     | `FilePathEntity` (NOT ported) |

`FilePathEntity` is the one missing combination — a SHARED file whose bytes are in a store — and nothing
needs it: it would want FilePathEmbeddedLogic's whole save/delete cascade a second time, addressed by row
rather than by owner. `FileEntity` exists for exactly one reason, which is why it is worth its own table:
several owners may reference one file, and the file can outlive any one of them.

Signum keeps `BinaryFile` / `EntityId` / `MListRowId` / `PropertyRoute` / `RootType` as `[Ignore]`
in-memory fields; altea marks them `@column(false)` — not mapped, but still SERIALIZED, which is the point.
`binaryFile` carries an upload client → server, and the routing trio carries the file's ADDRESS server →
client. `MListRowId` is the one that does not survive: altea has no MList, so a file inside a collection
sits on a `@part` ROW ENTITY with an id of its own — that row IS the route root, and `entityId` is its id.

The C# property SETTERS (FileName forcing an extension; BinaryFile computing Hash + FileLength) run in
`prepareForSave`, because altea entities are plain field bags. `byte[]` is a `Uint8Array` field, which is
altea's `"Blob"` → `bytea` / `varbinary(MAX)`.

## Saving is SPLIT, and that is what the remote backends need

Signum has a sync path (`SyncFileSave`) and an async one. altea always does both halves: assign the suffix
and the hash SYNCHRONOUSLY in `preSaving`, so the row can be INSERTed carrying its suffix, and write the
BYTES on `Transaction.preRealCommit` — so a rolled-back transaction leaves no orphan file. That split is
what makes a network-backed store expressible at all; see [FileStores.md](FileStores.md).

Deletion is the mirror image, and altea has no per-entity `deleting` event: the delete SIGNAL is the
set-based `preUnsafeDelete` (which `entity.delete()` also goes through). The rows about to be deleted are
read first and their files removed on `postRealCommit` — never before the delete actually commits.

The fields are found at `schema.initializing` — once every module has included its tables — by walking each
table's fields for embeddeds of type FilePathEmbedded, recursing into nested embeddeds, and registering the
hooks on that table's type. Signum's `FilePathEmbedded.OnPreSaving` is a static hook on the EMBEDDED type;
altea's events are per entity TYPE, hence the scan. No MList handling is needed: a `@part` collection row is
its own TABLE with its own events.

### Routing

Each file is told its `rootType` / `entityId` / `propertyRoute` so the client can address the download
through its owner. As in Signum this happens in the PROJECTION, not in a `retrieved` hook — a
FilePathEmbedded can be projected WITHOUT its owner ever being materialised (a SearchControl column over
the file field selects that embedded and nothing else), and the client still has to build the URL. altea's
seam is `schema.embeddedRoutePositions`: ONE registration keyed by the embedded TYPE, with the binder
supplying the position, where Signum registers four `RegisterBinding`s per route. The `saved` half is
Signum's OnSaved updaters — a just-saved entity is not re-read, so its files are stamped in memory.

## Downloads are addressed by OWNER, never by path

A file is downloaded by naming its root entity type + id + the property route to the embedded. The server
re-reads the embedded from the database, so the entity's own read rules (type auth, row-level conditions)
gate the download and a stored suffix is never guessable from the URL. Signum parses a full PropertyRoute
with MList rowId support; altea walks the dotted path on the retrieved entity, and a `@part` COLLECTION
step is addressed by the row's id via `?rowId=` — one collection level, which is what a file field needs.

`FileEntity` is the exception, and it has to be: it IS a row, and it may have several owners, so
`/api/files/downloadFile/:fileId` is addressed by the file's own id and gated by FileEntity's own type
authorization, which `retrieve` applies like any other read. Its stored hash is the ETag, so revalidation
costs nothing.

Signum's per-file max-age knob lives in FilePathLogic (the FilePathEntity module, not ported); it is
`FilesServer.maxAge` here, next to the only code that reads it.

## A file type IS its algorithm

The symbol table is SEEDED FROM THE REGISTERED file types, as Signum does
(`SymbolLogic<FileTypeSymbol>.Start(sb, () => FileTypes.Keys.ToHashSet())`) — not from the declared ones.
SymbolLogic's own default is wrong here in a way that shows: merely IMPORTING a module's data layer
declares its file types, so an app that never STARTS that module still got rows for them. Southwind starts
neither Printing nor WhatsNew and has a row for neither, where eastwind had six its database does not. The
thunk is evaluated LATE, so registration order does not matter.

`FileTypeAlgorithm.ts` is the LOCAL FOLDER backend plus the halves every backend shares: the
`IFileTypeAlgorithm` seam, `FileTypeAlgorithmBase` (onlyImages / maxSizeInBytes / onValidateFile) and the
suffix generators. `WeakFileReference` and `RenameAlgorithm` are kept — they are pure policy.

Signum's chunked-upload API (StartUpload / UploadChunk / FinishUpload / AbortUpload) is NOT ported: a file
reaches the server inside the entity graph, so there is no chunk protocol. The hash is computed in
`saveFile` rather than in a setter, because the isomorphic layer has no crypto.

## BigStringMixin

A `BigStringEmbedded` is a wrapper around one unbounded text column; declaring this mixin on it hangs a
FilePathEmbedded alongside, and `BigStringLogic` writes the text out on save and reads it back on retrieve,
so nothing that reads `.text` changes. Which routes do that, and in which direction they are migrating, is
per PROPERTY ROUTE — see the CLAUDE.md bullet for what eastwind configures.

- **A route must be registered BEFORE its root type is included**, because registration is what removes
  the column the chosen mode does not use (`SchemaSettings.ignoreFieldRoute`).
- **The mixin must be DECLARED on BOTH TIERS** — it is what tells the serializer the field exists — so
  `BigStringMixin.declare()` goes in a module the client and the server both load. Signum declares it in
  the app's Starter and BigStringLogic merely asserts it; the split is the same.
- Signum keys its configuration by PropertyRoute and reaches the owning embedded through
  `bs.GetParentEntity()` (hence its `[BindParent]` requirement). altea keys by the MEMBER PATH from the
  root entity and walks DOWN from the entity the hook fires on, so no parent tracking is needed.
- The created FilePathEmbedded is handed to `FilePathEmbeddedLogic.prepareAndWriteOnCommit`, so the bytes
  land through the ONE code path that also serves an ordinary file field.
- `RegisterPreUnsafeDelete` has no counterpart: FilePathEmbeddedLogic's own delete hook already finds the
  mixin's file, because altea flattens an embedded's mixin fields into the embedded.
- **Two leaks are FIXED rather than mirrored.** Signum leaves the previous file in place when a route's
  text is rewritten, and leaves `mixin.File` set after migrating a file back into the database; this port
  deletes the superseded file on commit and clears the field.
- `BigStringMode` is a plain string union, not an entity enum: engine configuration, never persisted.

## The client

- **The per-type `FileDownloaderConfiguration` registry collapses to one helper**, `FilesClient.fileUrl`.
  Signum registers one per file TYPE because it has four; here a saved FilePathEmbedded carries its own
  ADDRESS (the server stamps rootType / entityId / propertyRoute on it), which `fileUrl` prefers, with the
  owner + property route props as a fallback.
- **The lines are plain `LineBase`s, not `EntityBase`s.** Signum's FileLine is generic over its four file
  types and creates the entity through EntityBase machinery, with a `FetchAndRemember` branch for a Lite;
  here the bound member type decides (`kind`) and the uploader builds the value directly.
- **The bytes ride the entity's own save.** Signum uploads through `/api/files/upload…` as a separate step
  and shows per-file progress; altea carries them INSIDE the entity graph (base64, through the
  serializer's BlobSerializer), so the uploader only reads the files locally — no progress bar, no
  temporary-file state, and Signum's `asyncOptions` has nothing to configure.
- **A MultiFileLine element WRAPS the file.** In Signum an MList element could BE the file
  (`MList<FileEmbedded>`) and `getFileFromElement` was the exception; here a collection is `@part` ROW
  entities and a file holder is an EMBEDDED, so the only question is WHICH member holds it. That is
  `fileField`, a member NAME (dots allowed for a nested embedded) rather than Signum's lambda — the
  quote-transformer does not rewrite lambdas in JSX attributes, and a name is all the route needs.
- **`defaultFileTypeInfo` has no counterpart.** Signum ships each property's file type / onlyImages /
  maxSize in its reflection metadata so a line can default them; pass `fileType` explicitly.
- Signum's in-memory image case is `"data:image/jpeg;base64," + file.binaryFile` with the mime hardcoded
  (its binaryFile IS base64); altea holds real bytes, so it makes a properly-typed blob URL.
- `defaultProps` is gone in React 19 for function components, so the lines default through
  `getDefaultProps`.
- `FilesClient.start` registers only the entity views — the file lines are used explicitly, never as
  AutoLine defaults.
- NOT ported: `MultiFileImageLine` (the mechanical combination of MultiFileLine and FileImageLine, which
  nothing needs), and `fullWebPath` — a file served directly by the web server.
