# Signum.Printing → @altea/altea-printing

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Printing/`

A print QUEUE. Something that produces a document (a report, a label, an invoice) drops a LINE here instead
of printing it itself; a line carries the file and moves through states; a PACKAGE is a batch a process
walks, printing each line through the app-supplied `PrintingLogic.print` hook — whose default THROWS, as
Signum's does, because what "print" means is not something a framework can know.

eastwind wires the module and leaves that hook unset (the same call the SMS `provider` gets), but DOES
supply the test file type, which Southwind omits and thereby leaves `CreateTest` with nowhere to upload.

## Divergences

- **Signum's table-driven `StateValidator` becomes per-field `@validate`**, the same translation
  @altea/altea-email made for EmailMessage: the same rules, one field at a time, since altea has no such
  table helper. Signum's table reads:

  | state | printedOn | package |
  | --- | --- | --- |
  | NewTest | null | null |
  | ReadyToPrint | null | null |
  | Enqueued | null | SET |
  | Printed | SET | (either) |
  | Error | null | (either) |
  | Cancelled | null | (either) |
  | PrintedAndDeleted | SET | (either) |

- `[Ignore] TestFileType` → `@column(false)`: the file type the "create a test line" operation hands the
  FileLine so it knows where to upload, never a stored value.
- `Referred` keeps Signum's EMPTY `@implementedBy`: what a printed document refers to is app-defined, so an
  app widens it in its shared entity-overrides module.
- **NO custom `toString()`, as in Signum**: the default `"<NiceName> <id>"` applies. A first attempt built
  one from the state — `PrintLineState[this.state]` — which is a **reverse ENUM LOOKUP, i.e. a subscript no
  SQL dialect can evaluate**; PostgreSQL answered "cannot subscript type unknown" on every query of the
  table.
- **`PrintPackageEntity.Lines()` is a `withQuoted` PROTOTYPE member** assigned at the bottom of
  `PrintingLogic`, where Signum declares an `[AutoExpressionField]` extension method — a registered
  expression needs a quoted member to point at. The process algorithm does not go through it (it queries
  the lines directly), so no in-memory twin is needed.
- `IProcessAlgorithm` → a `registerAction` closure (altea's counterpart of Signum's
  `Register(symbol, Action<ExecutingProcess>)` overload) — the algorithm has no state.
  `ExecutingProcess.ForEachLine` → `ep.forEach(items, label, action, lineOf)`.
- `ProcessLogic.AssertStarted` and `PermissionLogic.RegisterPermissions` have no counterparts: an app calls
  this start after the process module's, and SymbolLogic seeds every `init()`ed symbol, so DECLARING the
  permission IS the registration.
- `OperationLogic.AllowSave<T>()` has no counterpart — altea's save is not gated on an operation, so the
  scopes around `line.Save()` simply disappear. (Signum's `AllowSave<PackageLineEntity>` in the cleanup task
  is a copy-paste slip for `PrintLineEntity` anyway.)
- `Transaction.InTestTransaction` has no counterpart, so the print failure path always records the Error
  state and rethrows.
- **BOTH endpoints are gated by `ViewPrintPanel`**, where Signum gates only the omnibox entry and leaves
  them open to any authenticated user.
- `isCreable: "IsSearch"` cannot be expressed — altea's `EntityClientBuilder` has no such option.
- `isPermissionAuthorized` lives on @altea/altea-auth's client (the framework has no permission gate of its
  own — the flag rides on the permission container's metadata entry), the divergence altea-workflow
  documents.
- **Signum's `PrintPanelPage` uses `LinkButton` without importing it** — its page does not compile as
  written; the import is added.
- Signum hides `SaveTest` once it cannot execute: a test line is saved once and then it is an ordinary
  queued line.

## Two core bugs it found, both older than this module

- **an `@implementedByAll` reference had NO sub-tokens on the client.**
  `QueryLogic.getImplementedByAllTypes` reads `Schema.Tables.Keys`, so it exists only on the server, and
  only the server installed it as the token tree's provider — Signum needs no client half, its token tree
  being a server-built QueryDescription. So `ProcessEntity.data`, `OperationLogEntity.target`,
  `ViewLogEntity.target` and `AlertEntity.target` offered nothing in the column chooser, and a `.cast(X)`
  token could not resolve at all. The client's source is now the reflection registry narrowed by the
  metadata blob's `kind`.
- **`ExceptionLogic.logException` wrote in the AMBIENT transaction.** It is nearly always called from a
  catch block whose transaction is about to roll back, so the row went with it while the entity — stashed
  on the Error for reuse — kept the id that insert handed out; the next caller then saved it as an existing
  row and `exception.toLite()` pointed at an id that was never committed. That is why every process whose
  per-item action threw died with "insert or update on process_exception_line violates foreign key
  constraint" and ended in Error instead of Finished, losing the exception line too. Now in its own
  transaction, which is what Signum's `ex.LogException()` does.

## A note on PermissionLogic

`PrintPermission.ViewPrintPanel` is why PermissionLogic is a REGISTRY rather than "every declared
permission": Southwind never starts the printing module, so its database has no such row, while the SYMBOL
is declared the moment anything imports this module's data layer.
