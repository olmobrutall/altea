# Signum.Isolation → @altea/altea-isolation

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Isolation/`

Multi-tenancy BY ROW. Every table declares a STRATEGY (`Isolated` / `Optional` / `None`), an isolated table
gains an isolation column, and a request that has picked one sees only its rows — the filter is a WHERE the
LINQ binder splices onto every query of that type, so retrieve, dynamic query and navigation are covered by
one registration.

**Startup FAILS if any table declared nothing**, which is why an app either goes multi-tenant or does not
install the module. Southwind only REFERENCES Signum.Isolation and never starts it, so eastwind wires
nothing either and the module's own `test/` suite is the verification (21 DB-free cases + 18 gated on
`ALTEA_ISOLATION_TEST_DB`).

## The one structural divergence that shapes everything else

**altea inlines a mixin's fields onto its owner**, so the CLIENT has to know a type carries the mixin in
order to deserialize the `isolation` field at all — where Signum's client reads a separately-serialized
mixin bag.

So `Isolation.register(T, strategy)` is an ISOMORPHIC call in the DATA layer, made from the app's shared
entity-overrides module (the same place @altea/altea-diff-log's `MixinDeclarations.register(OperationLogEntity, DiffLogMixin)` goes), and the
server's `IsolationLogic.start` reads the map back. Signum's `IsolationLogic.Register<T>` is server-only and
declares the mixin itself.

## Divergences

- **the ambient current-isolation is SCOPE-shaped, and lives in `server/`.** Signum's
  `IsolationEntity.Current` is an AsyncThreadVariable that `UnsafeOverride` sets and an IDisposable
  restores; an AsyncLocalStorage cannot be entered without a callback, so `override` / `disable` /
  `unsafeOverride` take the work as a function — the shape every other altea ambient has
  (`ExecutionMode.global`, `UserHolder.withUser`, `CultureInfo.withCultures`). Signum's call sites are
  already `using` blocks, so this is the same scope written differently. It lives in `server/` because the
  data layer is isomorphic and ships no node types; `IsolationMixin`'s `IsRetrieving ? null : Current`
  initializer goes with it, losing nothing — Signum also stamps in its global PreSaving, which is what the
  port does for every new row.
- **`[AttachToUniqueIndexes]` / `[ForceNotNullable]` are applied from `start`**, not as decorators: two
  general Signum field attributes with exactly one user between them. The unique indexes of every isolated
  table are rewritten on `schemaCompleted` — where Signum applies the first too (`GenerateAllIndexes`) —
  and the required rule is a `NotNullValidator` pushed onto the route's FieldInfo. That route needs the
  MIXIN STEP even though the column is flat, the accommodation altea-diff-log documents.
- **the operation scope is `OperationLogic.aroundOperation`**, the SCOPING half of Signum's one
  `SurroundOperation`: altea's observing half must not break what it observes, which is the wrong contract
  for a security scope, and its "after" runs at a precise point.
- `EntityEventsGlobal.PreSaving` → a per-type handler on the isolated types only; `IsolationStrategy` → a
  plain string union (never a column, never translated); the picked isolation is stored as the lite KEY,
  since `JSON.stringify` drops a Lite's constructor-valued `entityType`.
- **`Schema.AttachToUniqueFilter` is NOT ported.** Its only Signum consumer is
  `Table.DeclarePrimaryKeyVariable`, which resolves an entity's id BY ITS UNIQUE KEY inside a generated
  migration script; altea's sync writes no such lookup, so there is nothing to scope.
- **`IsolationFilter` (a `SignumDisposableResourceFilter`) becomes EXPRESS MIDDLEWARE**, the translation
  @altea/altea-rest's RestLogFilter made. Mounted on the whole app rather than per controller, because
  every request must resolve an isolation — Signum registers it globally too
  (`options.AddIsolationFilter()`), so its positional `atIndex` argument has no counterpart: the ordering
  requirement it expresses ("after the authentication filter") is expressed by WHERE the host calls
  `start`.
- `HttpContext.Items[Signum_Isolation]` → a property on the Express request, read back by the exception
  hook for the same reason Signum stashes it: by then the ambient scope is gone.
- **the header name is Signum's `Signum_Isolation` verbatim**: it is a wire contract, and a database moved
  from a Signum app keeps working against the same client. The picked isolation still lives in
  `sessionStorage` under Signum's own key, so a second tab can work in a different tenant — deliberate in
  Signum and kept.
- `IsolationEntity.tryTypeInfo()` (the guard that hides the widget when the module is not installed
  server-side) becomes a check for registered metadata — altea's client learns which types exist from the
  reflection blob.
- the colour provider is verbatim, palette included (pink Isolated, indigo Optional, cyan None, the page
  background for a table with no strategy — which can only happen for the exempt enum / symbol tables); the
  factory takes no SchemaMapInfo, since it reads only the per-table `extra` bag the SERVER filled.

## Four core seams it needed, all Signum's own

- **`ExecutionMode.onSetIsolation` / `withIsolationOf`** — whose four callers (the process runner, the
  scheduled-task runner and the two model renderers) now adopt the row's scope exactly as Signum's do.
- **`OperationLogic.aroundOperation`** — see above.
- **`EntityEvents.preUnsafeInsert` taking the CONSTRUCTOR and able to return a replacement**, which is
  Signum's actual signature and was documented as unported until this consumer appeared.
- **`exceptionFilter.applyMixins`.**

## Two Signum bugs fixed rather than mirrored

- **`IsolationDropdown`'s `data-isolation={name}`** is the JS global `window.name` — an empty string — so
  the attribute could not address a specific row. Each item carries its own lite key here, which is what an
  e2e test would select on.
- **the isolations endpoint's error text** interpolates an `IsolationMixin` where the isolation is what is
  worth naming.

## The test fixture

One type per strategy, because each is a different query filter and a different save rule:

| type | strategy | what it proves |
| --- | --- | --- |
| `ProjectEntity` | Isolated | required field, and a UNIQUE index on `name` that must become unique PER TENANT (two tenants may both have "Website") |
| `TagEntity` | Optional | a row may be GLOBAL (no tenant) and is then visible from every tenant, so the filter is `mine OR null` and the field must NOT be required |
| `CatalogEntity` | None | no column, no filter, every row visible — and that the strategy assertion accepts a type that opts out |

A fourth type is deliberately absent: `assertIsolationStrategies` is exercised by REGISTERING nothing for
one of these, which needs no extra entity. The strategy table is process-global (as Signum's is), so the
cases that must see an UNDECLARED type use a locally declared entity class rather than un-registering a
fixture one.
