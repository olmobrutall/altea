# Signum.TimeMachine → @altea/altea-time-machine

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.TimeMachine/`

The module has NO entities of its own: everything it shows already exists in the database as the HISTORY of
system-versioned tables (`sb.include(X).withSystemVersioned()`), which core already queries through
`SystemTime` and already exposes in the SearchControl's "Time Machine" dropdown. This module is the READER
— a page listing a row's versions, a diff between two of them, and the restore helpers — so it is one
route, one page, the quick link, and two restore functions an application calls from its own operation
(the module ships no button of its own, exactly as Signum does).

## Restore

- **`Administrator.SaveDisableIdentity` has no counterpart, and needs none.** altea's insert path already
  writes an explicit id into an identity PK with `OVERRIDING SYSTEM VALUE` / `SET IDENTITY_INSERT` whenever
  an entity is `isNew` but already carries an `id` (`server/save.ts`, `identityOverride`). So "re-insert
  this deleted row under its original id" is just `isNew = true` with the id left alone.
- **the MList re-insertion block is GONE.** Signum has to reach past the entity model to put the MList
  element ROWS back (`BulkInserter.BulkInsertMListTable(disableMListIdentity: true)`, with its own "not
  tested" comment attached), because an MList row is not an entity there. altea has no MList: a collection
  is `@part` child ENTITIES with their own ids, so they are ordinary members of the graph and the same
  isNew/id restore covers them. The VirtualMList branch goes with it for the same reason — altea's `@part`
  collections ARE Signum's virtual MLists.
- **the restore graph is built explicitly, not through `saveDependencyGraph`.** That one only edges targets
  which are `isNew`, and every entity read back from history is a CLEAN, id-carrying instance — so the
  graph would have no edges at all and a referenced row could be inserted after the row pointing at it.
  Edging every forward reference and taking `compilationOrder` is the shape Signum's
  `GraphExplorer.FromRoot(entity).CompilationOrder()` has.
- **`Entity.SetSelfModified()` → dropping the snapshot.** altea tracks changes against a snapshot taken at
  retrieval, so that is what forces the row to be written when nothing on it differs.
- Signum writes `.Max(a => a.SystemPeriod().Max)`; altea's `max` selector is typed for scalar values only
  (a Temporal is not one), so the same thing is an ORDER BY + first.

## The route

- `/api/timeMachine/retrieveVersion/…` where Signum's is the unprefixed `api/retrieveVersion/…`: every
  altea module namespaces its routes under its own segment.
- **the read runs under `ExecutionMode.global`.** Retrieving a HISTORY row goes through the ordinary
  retrieve path, whose type-READ gate would otherwise re-check rules the quick link already checked; and a
  history row may reference rows the current user cannot read today. The page itself is gated by
  `TimeMachinePermission.ShowTimeMachine`.
- `Schema.ForceCultureInfo` is not needed — altea's ObjectDumper formats invariantly by construction
  (Temporal → ISO, Decimal → `toString`), the same reason altea-diff-log gives.
- `ReflectionServer.RegisterLike(typeof(TimeMachineMessage), …)` has no counterpart: altea ships ONE
  metadata blob and a message container is included by being registered, with no per-container visibility
  predicate to attach.

## The client

- **`AppContext.isPermissionAuthorized` lives in altea-auth**, not core, so the gate is
  `AuthClient.isPermissionAuthorized`. Signum reads the permission ONCE at start; here the check is inside
  the callbacks, because a permission flag follows `onCurrentUserChanged` (the lesson from the
  auth-directory ports) and a start-time snapshot would be wrong after a re-login.
- **the quick link drops Signum's `getTypeInfo(entityType).operations` condition.** altea's TypeInfo has no
  `operations` (they live on the per-request metadata blob), and the condition was redundant anyway: what
  it really gated on was `Finder.isFindable(OperationLogEntity)`, which is kept.
- **no `Finder.getQueryDescription` gate** — altea has no QueryDescription; the SearchControl resolves its
  own query root, so the page simply renders.
- **the header's lite is fetched, not model-filled.** Signum calls `Navigator.API.fillLiteModels` and
  catches the failure as "[Entity deleted]"; altea has no lite MODEL and no such endpoint, so the display
  text comes from retrieving the row — which is the same existence probe, one call either way.
- **`previousOperationLog` is ROOTLESS and camelCase**, where Signum writes `Entity.PreviousOperationLog`:
  an altea extension token's key is derived from its quoted lambda's tail member, and altea's query tokens
  are rootless. Same for the id filter, where Signum filters by its `Entity` root token — under
  `systemTime: All` the row's id is exactly "every version of this row".
- `ti.isSystemVersioned` → `ti.systemVersioned != null` (altea keeps the descriptor, not a flag);
  `newLite(type, id)` → `Entity.resolveType(type).newLite(id)`; luxon `DateTime.fromISO` →
  `Temporal.PlainDateTime.from` (altea's period bounds are tz-naive).
- the "LiteNoFill_TM" rule is not ported, matching core's FinderRules, which likewise skips Signum's
  "LiteNoFill" (an `avoidFillSearchColumnWidth` width tweak).
- Signum's stray `console.log(pair)` in `RenderEntityVersion` is dropped.

## What it needed from core

- **`getTimeMachineIcon` was a STUB and is now real** (`altea/client/Lines/TimeMachineIcon`): the per-line
  coloured dot that marks added / removed / changed / moved values IS the "UI differences" tab, and every
  Line already called it. Its vocabulary went into `EntityControlMessage` (`PreviousValueWas0`, `Moved`,
  `Removed0`, `Added`, `RemovedAndSelectedAgain`, `Selected`). No `translateX` (no altea Line passes one),
  and the checkbox variant reads `oldCtx.value` DIRECTLY off the ENUM OBJECT rather than a TypeInfo.
- **`PreviousOperationLog` is registered in CORE**, exactly where Signum registers it
  (`OperationLogic.registerPreviousLog`, on `schemaCompleted`, for every @systemVersioned table).
  `e.SystemPeriod().Contains(ol.End)` is spelled out against `.min` / `.max` — altea's
  `NullableInterval.contains` is an in-memory method, only the BOUNDS lower — which is also why
  `NullableInterval`'s bounds narrowed to `PlainDateTime` (a cast to a QUALIFIED type name is not quotable).
- **a `@part` row INHERITS its owner's versioning**, the way it already inherits the owner's EntityData —
  Signum's `SchemaBuilder.cs` `Settings.TypeAttribute<SystemVersionedAttribute>(...)`. Without it a sync
  against a Signum database did not merely show less, it SCRIPTED THE EXISTING LINE HISTORY AWAY
  (`DROP TABLE order_details_history`, `DROP COLUMN sys_period`, `DROP TRIGGER versioning_trigger`).
  Pinned by `eastwind/terminal/probePartVersioning.ts`.

eastwind marks `OrderEntity` `@systemVersioned`, as Southwind does — so an existing database needs a
`terminal sync` before the Time Machine has anything to read.
