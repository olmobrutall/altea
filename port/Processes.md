# Signum.Processes → @altea/altea-processes

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Processes/`

A PROCESS is one run of a registered ALGORITHM over some DATA, tracked through a state machine (Created →
Queued → Executing → Finished / Error / Suspended / Canceled) with a progress fraction and a status line, so
a long job is observable and interruptible. A PACKAGE turns a set of entities into work a process walks.

## The runner is IN-PROCESS and coalescing

`wakeUp()` schedules at most ONE pump at a time — there is no lock, because node runs the callback on the
single event loop. At boot the runner's first act is to reset anything this host claims to be running: the
process just started, so it cannot be. Work is picked oldest-first, preferring rows already pinned to this
host, and `takeForThisMachine` claims the row and refuses if another host already runs it.

## The registries key by symbol KEY, not by the symbol OBJECT

**A symbol read back from the database is a fresh instance, not the declared singleton**, so an
identity-keyed Map misses on every run that came from a row. The same gotcha altea-scheduler hit, and the
one the operation registry hit later — an operation named by DATA (which is exactly what a
`PackageOperationEntity` names) was "not registered".

## PackageLogic: a reversed non-port

This was recorded as NOT ported, and CLAUDE.md said so — altea-workflow's timeout process walks its own
package lines, which is true and made the module look avoidable. It is not: **Southwind's Orders domain is
built on it** (`OrderTask.CancelOldOrdersWithProcess` → `OrderProcess.CancelOrders` →
`PackageExecuteAlgorithm<OrderEntity>(OrderOperation.Cancel)`, plus the `CancelWithProcess` contextual
operation), and without it eastwind had to invent different tasks — which a Southwind database then read as
four symbols removed and four added.

The gap was smaller than the note implied: `ProcessLogic.start` already included all three tables and
registered the three `*LastProcess` queries, so what was missing is the four ALGORITHMS and the helpers that
BUILD a package. Hence no `packages` / `packageOperations` flags — Signum's two gate the table half, and
there is nothing left for them to gate.

**Registration order does not matter**, unlike what `ProcessLogic.register`'s own doc-comment says.
`SymbolLogic.start` stores `getSymbols` as a THUNK and calls it from `schema.generating` /
`schema.synchronizing`, so every algorithm registered before the schema is built is seeded, whichever side
of `ProcessLogic.start` it landed on. Signum's `ProcessLogic.AssertStarted(sb)` guard therefore needs no
counterpart.

`CreateLinesQuery` keeps its own name (`createLinesFromQuery`), because `createLines` cannot be overloaded
on a Query vs an array in a way TypeScript resolves well.

## Entities

- `DateTime` → `Temporal.PlainDateTime` (server-local wall clock, as in the scheduler port);
  `decimal? Progress` → `Decimal | null` (altea's decimal.js class).
- **`Status` is a sized column, not a BigString.** The runner rewrites it on every progress tick with a
  SET-BASED update — it must not go through the save pipeline — and a set-based update of a field inside an
  embedded is not something altea expresses. A one-line progress message is what the column holds.
- **`IProcessDataEntity` is a TS marker interface over the `Entity` class** (there is no `IEntity`), and
  `ProcessEntity.data` is `@implementedBy(() => [])` widened by the app: what a process runs OVER is
  app-defined, and core cannot enumerate it.
- **`PackageEntity` is `@part` in Signum**, owned by the process that runs it. altea Parts have exactly ONE
  owner and are reached through it, while a package is REFERENCED by `ProcessEntity.data` — so it is a
  "System" entity here, like its lines. `PackageOperationEntity` still subclasses it, since that is what
  names the operation a PackageOperation process applies.
- Signum's table-driven `StateValidator` (which fields must be null in which state) is NOT ported — it needs
  its own little framework. The two explicit PropertyValidations ARE, and the runner is the only writer of
  those fields, so the states stay consistent in practice.
- `Duration` / `DurationSpan` are in-memory helpers, not queryable columns: the quote-transformer emits a
  runtime type reference for a quoted member's return type, and there is no value to reference for a plain
  number (the same reason `ScheduledTaskLog.duration` is a plain method).
- `TicksColumn(false)` has no counterpart yet, so ProcessEntity keeps its ticks column.

## The scheduler bridge

"A scheduled task can BE a process" — Signum makes `ProcessAlgorithmSymbol` an `ITaskEntity`; here it is an
`@implementedBy` widening of `ScheduledTaskEntity.task`.

That widening lives in the DATA layer, not the server bridge, because **an implementedBy override changes
what the SERIALIZER and the SCHEMA see** — so both tiers must apply it, before anything is (de)serialized or
the schema is built. An app calls it from its shared entity-overrides module; the server half (what happens
when the scheduler fires one) is `ProcessSchedulerBridge.start`.

## Three core defects it found

Each older than the module and each silent — together they are why a package process could run to Finished
having done nothing, since `ExecutingProcess.forEach` files a per-line failure as a row rather than failing
the run:

- **`QueryBinder.assign` unwrapped a Lite column and then called ITSELF** instead of `adaptAssign`, so the
  pair was never re-run through the adapter — the one place the shapes can be lined up, since they only
  match once the lite is off. Every set-based write into a polymorphic lite column died on "Cannot assign".
- **`Retriever.liteImplementedByAll` kept the id AS READ.** An `@implementedByAll` has one id column per
  configured pk type and the value is coalesced over them, which is only typeable as TEXT once an app
  configures more than one — so an int id came back as the STRING `"11128"` and `retrieve(OrderEntity,
  "11128")` answered "not found" for a row that is right there.
- **the OPERATION registry was keyed by the symbol OBJECT** (see above).

## Not ported

- **the PackageOperation CONTEXTUAL MENU** — "pick rows in a search, run an operation over them as a
  process". It needs its own contextual-item and operation-settings machinery; an app builds its packages in
  code for now, though they can carry arguments.
- **no `ProgressProxy` argument.** Signum appends one to every per-line operation so it can report
  sub-progress; altea's operation signatures take plain args. Cancellation is still honoured at the LINE
  boundary, because `ExecutingProcess.forEach` checks the signal — which is where Signum's `ForEachLine`
  checks it too.
- **the two `PreDeleteSqlSync` cascades**: sweeping a package line whose TARGET or RESULT type is being
  removed, and everything belonging to a removed OPERATION symbol. Both need
  `Administrator.unsafeDeletePreCommand` over an `@implementedByAll` discriminator, which altea's sync has
  no counterpart for (altea-view-log records the same gap).
- **`RegisterUserTypeCondition`**: its middle rule — a `PackageOperationEntity` is visible when a process the
  user owns points at it — is a subquery over another type's condition, which TypeConditionLogic cannot
  express. An app that needs it registers the three conditions itself.
- `ExceptionLogic_DeletePackages` — the Process handler IS registered (`deleteProcessLogs`, per finished
  STATE so one state's backlog cannot use up the run's whole chunk budget), but orphaned packages are not
  swept with it. The
  `QueryLogic.Expressions.Register` calls for Processes / LastProcess / ExceptionLines (they would make the
  isomorphic layer import the server query API), the ChangeLog module, `CopyHealthCheckButton`, and the
  ProcessDates bar-chart column formatter.
