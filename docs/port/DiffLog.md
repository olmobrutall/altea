# Signum.DiffLog → @altea/altea-diff-log

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.DiffLog/`

The module registers ONE surround-operation handler, and that handler is the whole thing: dump the entity
before the operation, dump the target after it, store both on the operation log.

## What it needed from core

- **`ObjectDumper`** (`data/objectDumper`). It keeps Signum's C#-flavoured output VERBATIM —
  `new OrderEntity(10248) { … }`, `new LiteImp<CustomerEntity>(5, "Acme")`, 3-space indent — because that
  shape is the contract `simplifyDump`'s regex reads, and it is what makes a dump comparable across the two
  frameworks. `[AvoidDump]` / `[AvoidDumpEntity]` become `ObjectDumper.avoidDump` / `avoidDumpEntity` Sets
  keyed `"TypeName.fieldName"`. `Schema.ForceCultureInfo` is unnecessary: the dumper formats invariantly by
  construction (Temporal → ISO, Decimal → `toString`). Mixins are not a separate branch, since altea
  inlines them.
- **`OperationLogic.surroundOperation`** — Signum's `SurroundOperation` event returns an `IDisposable`;
  altea's is a before-handler returning an AFTER callback, which still runs when the operation threw.

## Divergences

- **the mixin's fields are FLATTENED onto `operation_log`** (`initial_state_text`, …), because altea inlines
  a mixin's fields onto its owner (`entity.mixin(X)` is a typed cast returning `this`). Reading them through
  `log.mixin(DiffLogMixin)` still works, so the call sites read like Signum's.
- **a client PropertyRoute still needs the mixin STEP** even though the columns don't:
  `subCtx(a => a.mixin(DiffLogMixin))`. A route models the mixin, so one built straight off the owner
  (`"initialState"` on OperationLogEntity) does not resolve — which is where the tab labels come from.
  altea dropped `subCtx`'s mixin overload (it defeated contextual typing for lambdas), so the step is
  written INSIDE the lambda — the same shape altea-email's reception tab uses.
- **the mixin declaration must run on BOTH TIERS** before anything is (de)serialized or the schema is
  built, so the call lives in the app's shared entity-overrides module. Signum's `MixinDeclarations
  .Register<OperationLogEntity, DiffLogMixin>()` is likewise Southwind's to make, with DiffLogLogic merely
  asserting it.
- `[BindParent]` is implicit — an embedded belongs to its owner in altea.
- **`Polymorphic<Func<IEntity, IOperation, bool>> ShouldLog`** becomes a ctor-keyed Map walked up the
  prototype chain: altea has no `Polymorphic`, and "the nearest registration for this type or a base of it"
  is what its `minimumType` lookup means.
- **`GraphExplorer.IsGraphModifiedVirtual(entity)` → `entity.isDirty()`.** altea tracks modification
  against a SNAPSHOT, so "the caller handed us a modified graph, re-read the stored one so the INITIAL
  state is really the initial state" is one call instead of a graph walk.
- **`RetrieveFresh`**: `new EntityCache(ForceNew)` becomes `ExecutionMode.global` plus a direct retrieve —
  altea's Retriever builds a fresh instance per read anyway.
- `Lite.ParsePrimaryKey<OperationLogEntity>(id)` + `InDB(a => new { a.Target, a.Start })` become a
  projection query, with the `Target` comparison through `is(lite)`.
- `ReflectionServer.RegisterLike(typeof(DiffLogMessage), …)` has no counterpart: altea ships ONE metadata
  blob and a message container is included by being registered.
- **the current-entity dump runs under `ExecutionMode.global`** — reading the target to dump it is an audit
  read, and the user is looking at a log they were already allowed to open.
- Signum guards with `!log.Target.Exists()`; a failed retrieve says the same thing in one query.
- `Navigator.addSettings(new EntitySettings(…))` → `cb.configure(…).withView(…)`; `LinkButton` → a plain
  bootstrap link button; `LinkContainer` (react-router-bootstrap) → a react-router `<Link>` inside the tab
  title, which is what LinkContainer produces.
- **three hardcoded English strings become `DiffLogMessage` keys**, so the control is translatable like the
  rest of the module. Signum writes the margin label as two literals AROUND the NumberBox ("Show only" …
  "lines arround each change"); the message has a `{0}` placeholder instead and the box is rendered AT it,
  so a translation can put the number where its own grammar wants it.
- Signum's `simplify` checkbox and its `simplifyDump` regex are kept VERBATIM — the regex matches the dump
  format, which ObjectDumper preserves on purpose.

## The type condition IS ported

`TypeConditionLogic.registerWhenAlreadyFilteringBy(OperationLogEntity,
OperationLogTypeCondition.FilteringByTarget, …)` is registered in `DiffLogLogic.start`.

What the condition says: you may see an operation log BECAUSE you asked for the logs of ONE entity that you
are allowed to read. It answers a real problem — the operation log is a single table across every type in
the application, so a role that may read it at all could otherwise read the audit trail of rows it cannot
see — and it cannot be expressed as a predicate over the log row, only over the QUERY that asked for it.
Hence the auditor.

One thing about it is necessarily different: **altea's auditor is ASYNC and runs in the row-security
provider phase** rather than inside the binder, because deciding it reads the database and altea has no
synchronous DB access (see `TypeConditionLogic`'s header and `QueryAuditorVisitor`). Same registration,
same semantics. `useInDBForInMemoryCondition: false` — the per-instance path reads `target` off the log in
hand rather than going back to the database for it.

## Not ported

- **`AuthAdminClient.registerQueryAuditorToken`** — altea's auth-rules admin has no auditor-token registry.
  (The condition it pairs with IS registered; only the admin-UI half is missing.)
- **`ChangeLogClient.registerChangeLogModule`** — altea's change log takes its entries from a per-module
  `Changelog.ts`.
