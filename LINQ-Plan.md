# LINQ Provider Port Plan

Canonical home for the LINQ provider (Phase **D**). The root `../PLAN.md` keeps
only a one-line status row and a pointer here.

## Goal & approach

Port Signum's `D:\Signum\southwind\Framework\Signum\Engine\Linq` **pass-for-pass**.
Prefer the same class/method shape, visitor pipeline, and naming; diverge only
where TypeScript, the `quote-transformer` expression model, or the current Altea
runtime makes the C# shape impractical (divergences are listed below).

Pipeline (replaces the `throw` in `MyQueryTranslator.translate()`, `logic/table.ts`):

```
simplify → QueryBinder → optimiser passes → ChildProjectionFlattener
  → TranslatorBuilder{ ProjectionBuilder (eval-codegen) + QueryFormatter }
  → TranslateResult.execute()  [async]
```

Everything downstream of binding ports faithfully; only **QueryBinder** is adapted,
because the input is altea's JS-operator AST (`expressions.ts`: `CallExpression` on
a named `PropertyExpression`, `BinaryExpression "=="`) not C# `MethodCallExpression`.

## Key decisions

- **Follow Signum as closely as possible** — it is battle-tested over many years and
  well understood. Port class/method shape, visitor pipeline, naming and control flow
  pass-for-pass; keep the same expression model and pass ordering. Diverge only where
  TypeScript / `quote-transformer` / the async runtime genuinely forces it, and record
  each divergence below. Staying faithful is also what keeps the generated SQL close to
  Signum's — when in doubt, read the C# and mirror it rather than inventing an altea path.
- **Async terminals** — `toArray`/`first`/`count`/… return Promises (the Node
  connectors are async-only). `IQuery` + `Query` updated together.
- **TDD-first** — all Signum `LinqProvider/*.cs` tests are ported into `altea-test`
  to lock a stable `Query<T>` API. Compile-clean under `tspc` is the API-stability
  gate; DB-gated suites SKIP without `ALTEA_TEST_DB`. A feature is "done" only when
  its suite is green on **both** Postgres and SQL Server.
- **Projector via eval/codegen** — `TranslatorBuilder` compiles the projector with
  `new Function` (mirrors C#'s `Expression.Compile()`), not a tree interpreter.
- **Collections ≈ MList** — altea has no MList tables; `FieldEntityArray` /
  `@backReference` part-entities play that role. The collection projection machinery
  is a near-port of Signum's MList* nodes. **Collections are always eager** on retrieval
  (like Signum): an entity array is a UI model for an editable table, so it must load with
  its owner. (The music test model leans on this heavily — deep collection graphs — which
  is about exercising the feature, not modelling for production performance.)
- **Ask before diverging** beyond the ones already recorded here.

## Status

Runs against both dialects. **Current stable baseline: Postgres 484 / SQL Server
~473 pass of 556** (last run 2026-07-02). Postgres is deterministic since the
`noCommit` isolation below; SQL Server floats a bit because a handful of
aggregate/group-by/select tests flake under parallel load — the specific tests
vary run-to-run (e.g. `All`/`None`/`GroupByCount`/`GroupByAllAny`), all pass in
isolation. For done work the **code is the source of truth**; this is a map, not
a spec.

**Done** (green on both dialects unless noted):

- **Core pipeline** — DbExpression hierarchy (`expressions.sql.ts`),
  `DbExpressionVisitor`, `AliasGenerator`, `QueryBinder`, `DbExpressionNominator`,
  `ColumnProjector`/`ColumnGenerator`, `QueryFormatter`, `TranslatorBuilder` +
  `Retriever` (materialisation).
- **Materialisation** — full entities, embeddeds, mixins; the clean change-tracking
  snapshot is taken on load (closes the Phase-C retrieve gap). Temporal columns are
  read back into their declared `Temporal` type (`PlainDateTime`/`PlainDate`/`Duration`),
  not a raw JS `Date` — the projector runs `denormalizeTemporal` on any `TemporalType`
  column (the pg pool keeps temporal OIDs as raw text so the exact wall-clock is parsed;
  the mssql driver's UTC `Date`s are read via their UTC components). This is the read-side
  inverse of `normalizeScalar`, so `entity.creationTime.dayOfWeek` etc. work in memory.
- **Query operators** — `filter`, `map`, `flatMap` (→ CROSS APPLY; `defaultIfEmpty()` on the
  collection → OUTER APPLY, keeping the outer row with a null inner), `orderBy`/
  `thenBy`(+`Descending`), `top`, `skip` (OFFSET/FETCH · LIMIT/OFFSET), `distinct`,
  `first`/`single`/`last`(+`OrNull`), `reverse`, `count`/`min`/`max`/`sum`/`avg`,
  `some`/`every`/`contains`, the join family (`innerJoin`/`leftJoin`/`rightJoin`/
  `fullJoin`/`groupJoin`), `groupBy` (+ element aggregates, Any/All/Contains),
  eager nested projections (`ChildProjectionFlattener`).
- **Navigation → JOIN** — single-reference navigation of any depth (`EntityCompleter`
  inline in the binder + `QueryJoinExpander` splicing SingleRow LEFT OUTER JOINs).
- **Eager collections (MList)** — a retrieved entity's `FieldEntityArray` collections
  (`.friends`, `.colaborators`, `.songs`, …) load eagerly, matching Signum's `VisitMList`:
  `createEntityExpression` binds each collection as a marker, `EntityCompleter.visitFieldEntityArray`
  realises it into a correlated child projection and recurses (so element entities' own
  references/collections expand), and `ChildProjectionFlattener` turns each into one extra
  query per level (flagged `isLazyMList`, since it is an entity's collection binding, not an
  explicitly projected collection). An entity array implies an editable UI table, so
  eagerness is the rule (see Key decisions); the `previousTables` cycle guard bounds the
  cascade. **Per-level lazy skip** (Signum's `EagerProjections`/`LazyChildProjections`):
  `TranslateResult` fills eager children (explicit projected collections) before the main
  query (deepest-first), then lazy children (entity MLists) after it (shallowest-first).
  Each lazy child is skipped when no parent row registered a request — the main projector
  drops an empty array into the entity and registers it (`lazyRequestArray`), the fill
  pushes into that same array and `retriever.reclean()` refreshes snapshots. So
  `table(Order).filter(() => false)` fires no line queries, and a band with no members
  fires no member-friends query either — the skip is independent at every level.
- **Polymorphism** — `@implementedBy` / `@implementedByAll` projection, navigation,
  cast, `instanceof`, equality (`SmartEqualizer`); `Lite<T>` projection, `.entity`,
  `.is`, `toLite`, eager `toStr` model. `GetType`/`typeof` (`.constructor`) over
  typed/IB/IBA references, backed by a real **`TypeEntity` int-id discriminator
  table** (`TypeLogic`).
- **Polymorphic combine** — `.combineCase()` / `.combineUnion()` over an
  `@implementedBy` reference (Signum's `CombineCase`/`CombineUnion`): navigating a
  member combines the implementations with a `CASE` or a `UNION ALL` sub-select.
  `combineImplementations` recurses the reference structure (scalar / Entity / Lite /
  IB / mixed-IBA); the UNION strategy adds a `SetOperatorExpression` source
  (`UnionAllRequest` + `ColumnUnionProjector`, spliced by `QueryJoinExpander`).
- **Member/method navigation through `?:` / `??`** — `bindMember`/`bindMethodCall`
  distribute an access over a conditional or coalesce receiver (Signum's
  `BindMemberAccess` Conditional/Coalesce cases): `(t ? a : b).m` → `t ? a.m : b.m`,
  `(a ?? b).m()` → `(a != null) ? a.m() : b.m()`; a null-literal branch propagates to
  null. Covers `.name`/field, `.constructor` (GetType) and `.toLite()` over either
  branch, including a nullable-Lite `.entity` dereference.
- **Indexed selectors** (`map`/`flatMap` `(x, i) => …`) — the binder's `withIndex`
  (Signum's `WithIndex`/`MapVisitExpandWithIndex`) wraps the source select with a
  0-based `ROW_NUMBER() OVER(…) - 1` column and binds the second lambda parameter to
  it. New `RowNumberExpression` SQL node + `visitRowNumber` (base visitor / formatter);
  its ORDER BY inherits the enclosing select's, falling back to a constant `(SELECT 1)`
  when the query imposes no order (rather than porting Signum's gathered-orderings
  fill). String `+` with the numeric index also casts to text on SQL Server (which uses
  `+` for concat, unlike Postgres's `||`).
- **Optimiser passes** — `OrderByRewriter`, `QueryRebinder`, `RedundantSubqueryRemover`,
  `ConditionsRewriter` (SQL-Server), `AggregateRewriter`, `ScalarSubqueryRewriter`,
  `GroupEntityCleaner`, `CommandSimplifier`, `AssignAdapterExpander`.
- **Unsafe DML** — set-based `executeUpdate`/`executeDelete`/`executeInsert`
  (+ owned-child cascade), on the part-entity tables.
- **SQL functions** — string (`LIKE`/`indexOf`/case/`trim*`/`substring`/`start`/`end`/
  `reverse`/…), `Math.*`, date/time (parts, construction, truncation, convert, whole-
  unit diffs), enum `.toString()` (→ value→name CASE), entity/value `ToString`.
- **`inDB`** (entity→query bridge) via the new **MethodExpander** infrastructure
  (`@methodExpander` / `sf.__methodExpander`, expanded in `ExpressionSimplifier`).
- **`@quoted` `AutoExpressionField` members** (`isMale`, `fullName`, `lonely`,
  `albumCount`) — direct/cast calls are inlined by the quote transform; a member
  navigated through a polymorphic `combineUnion()`/`combineCase()` is dispatched
  per-implementation and its `@quoted` body expanded in the binder (Signum's
  `HasExpansions` + `DispatchIb`). The quote transform defers an unresolvable
  entity-method call to a residual the binder resolves.
- **`EntityContext.entityId`** — the primary key of the row a value belongs to
  (Signum's `EntityContext.EntityId`). A reference yields its id; a value/embedded
  unwraps to its owning entity's id; a part-entity (`MList`) row yields its own id
  via a correlated scalar subquery. A captured static-helper receiver is dispatched
  by the quote transform (on the object) and recognised in the binder by a brand.
- **`Lite.entityType`** (Signum's `Lite.EntityType`) — the runtime type of a lite's
  referenced entity, as a Type expression (same `getEntityType` path as `.constructor`):
  projected, compared (`=== Ctor`, altea's `Type.Is` — via `SmartEqualizer.typeEqual`),
  or used as a group key.
- **`Clock.now`** (Signum's `Clock.Now`) — a server-clock abstraction reading UTC or
  machine-local time (`Clock.mode`), overridable for tests (`Clock.overrideNow`). In a
  query the getter is folded to a constant by the ExpressionSimplifier (Signum
  partial-evaluates `Clock.Now`). A bound Temporal parameter is normalised to a portable
  string (shared `normalizeScalar`) — the mssql driver throws on a raw Temporal object.
- **`minBy`/`maxBy`, `cast`/`ofType`** — the `ExpressionSimplifier` (pre-binding, Signum's
  OverloadingSimplifier) lowers these to core operators before the QueryBinder sees them:
  `minBy`/`maxBy` → `orderBy[Descending](key).firstOrNull()`, `cast(T)` → `map(x => x as T)`,
  `ofType(T)` → `filter(x => x instanceof T).map(x => x as T)`. Work both as root terminals
  and inside a query group (`g.elements.maxBy(…)`). The binder is untouched.

**Pending / out of scope** (each flagged `TODO(api)` in its suite):

- `Temporal.Now.*()` folded as a server-now constant in a query (e.g. `plainDateISO()`);
  `since(x).total(unit)` diff.
- `view()`/temp tables, `OrderAlsoByKeys`
  (stable pagination over a non-unique key).
- Deferred subsystems: FullText, Vector (pgvector), SystemTime/temporal.
- `TypeLogic` "Sync" (load ids from the DB instead of computing them) and
  `TypeEntity` unique indexes; the documented out-of-scope `unsafe*` cases
  (`Clock.now`, identity-insert, MList row-index, typed-NULL-in-CASE).
- **`TODO(remove-eager)` — collapse child projections to lazy-only.** Signum keeps an
  `EagerProjections` list because C# `new { Friends = p.Friends().ToArray() }` /
  `.ToReadOnlyList()` produce concrete collections it can't fill after the fact — only
  `MList` can be deferred. In TypeScript every projected collection is a plain array we can
  fill in place, so *all* child projections could be lazy (empty array + register + fill +
  `reclean`), giving the skip-when-empty guarantee uniformly and deleting the eager path in
  `translatorBuilder.ts` (`eagerChildren`, `gatherChildProjections(false)`, the eager branch
  of `visitChildProjection`) plus the `isLazyMList` split in `ChildProjectionFlattener`.
  **Kept for now only** so the generated SQL still matches Signum's Eager/Lazy execution
  order for the `sqlcmp` comparison; do this once that comparison is no longer needed.

## Key divergences from Signum

- **Source model** — altea uses `quote-transformer` expressions, not
  `System.Linq.Expressions`; the binder recovers type/method info from altea
  metadata + expression annotations (`@lambdaTypeForParam`, `@resultType`,
  `@quoted`, `@methodExpander`).
- **Nominator translates method calls** — `DbExpressionNominator` (a
  `DbExpressionVisitor`, like Signum's) both nominates server subtrees **and**
  lowers residual method calls in `visitCall` → `hardCodedMethod`, keyed
  `"<receiverType>.<method>"` (Signum's `DeclaringType.TypeName()+"."+MethodName`).
  The binder leaves recognised SQL functions as residual `CallExpression`s (string/
  Math/date); entity-semantic calls (`toLite`/`is`/`some`/`contains`) stay in the
  binder. (`string.length` and date-part *members* are still lowered in the binder's
  `bindMember` — member translation hasn't fully moved to the nominator.)
- **MethodExpander runs in `ExpressionSimplifier`** (not a separate binder pre-pass):
  a `@methodExpander`-marked call is rewritten to another source expression before
  binding. `inDB` uses it; `partialEval` resolves a constant receiver (incl.
  `entity.toLite()`) so `animal.inDB(a => …)` targets `table(Cat)`/`table(Dog)` by
  the receiver's runtime type.
- **`skip` = `offset` on `SelectExpression`** (OFFSET/FETCH · LIMIT/OFFSET), not
  Signum's RowNumber rewrite; threaded through every optimiser pass alongside `top`.
- **`TypeEntity` ids computed deterministically in memory** (sorted by ctor name),
  not read back from the DB — there is no Synchronizer yet, so gen and runtime
  compute the same assignment.
- **Codegen projector** — `ProjectionBuilder` emits a JS `(row, …) => value` via
  `new Function`; Signum builds expression lambdas over `IProjectionRow`.
- **Combine API without interfaces** — Signum's `CombineUnion`/`CombineCase` return
  the interface type (`IAuthorEntity`) that declares the shared member. altea has no
  interface, so `Entity.combineUnion()`/`combineCase()` return `any` (the binder
  resolves the navigated member against the concrete implementations). Two supporting
  quote-transformer tweaks: the inherited default `Entity.toString()` is no longer
  inlined (left as a call the binder expands — needed for a polymorphic receiver), and
  entity instance methods (`toLite`/`is`/combine*) on a lost-type receiver dispatch on
  `Entity.prototype`. IBA type-discriminator constants emit as inline SQL literals
  (not bound params) so an all-branch `CASE` types unambiguously.
- **`DayOfWeek` is Temporal-ISO, not .NET** — Signum's `DateTime.DayOfWeek` is .NET
  (Sun=0..Sat=6); altea aligns to the **in-memory `Temporal.PlainDateTime.dayOfWeek`** value
  (ISO Mon=1..Sun=7). The `DayOfWeek` enum is ISO (only Sunday differs from .NET, 0→7).
  Postgres uses `EXTRACT(isodow …)`, already ISO. **SQL Server delays the conversion to the
  projector** (Signum's `ToDayOfWeekExpression`): `dayOfWeekIso` emits a raw
  `DATEPART(weekday, x)` wrapped in a `ToDayOfWeekExpression`, so the SELECT / GROUP BY /
  ORDER BY stay clean (raw weekday), and `TranslatorBuilder` compiles the DATEFIRST→ISO
  conversion client-side (`toDayOfWeekIsoFromSqlServer`, using `@@DATEFIRST` cached on the
  connector). Where a day-of-week is *compared* in a predicate, the nominator folds the
  conversion back into server SQL (`coerceDayOfWeek` in `visitBinary`/`visitIn`, the analogue
  of Signum's `ExtractDayOfWeek`); in a projector the comparison stays client-side. The one
  divergence from Signum's SQL is that comparisons carry the inline
  `((DATEPART(weekday) + @@DATEFIRST + 5) % 7) + 1` (Signum converts the *constant* instead).
- **`defaultIfEmpty` drives only the SelectMany outer-apply** — Signum's `DefaultIfEmpty`
  is overloaded: it turns a `SelectMany` into an outer apply *and* is how a query expresses
  left/right/full joins. altea has explicit `leftJoin`/`rightJoin`/`fullJoin` operators (and
  `join` is reserved for string concatenation), so `defaultIfEmpty()` is used **only** for the
  flatMap outer-apply. Following Signum's `OverloadingSimplifier.ExtractDefaultIfEmpty`,
  `bindSelectMany` peels a `.defaultIfEmpty()` off the collection selector *before* binding
  (`extractDefaultIfEmpty`) and emits `OuterApply` when present, else `CrossApply` — no marker
  on `ProjectionExpression`. **`defaultIfEmpty()` must be the last (outermost) operator of the
  collection selector**; it wraps whatever collection precedes it (`filter`, the folded
  result-selector `map`, or both — `a.songs.filter(…).map(s => ({ s, a })).defaultIfEmpty()`),
  and the OUTER APPLY is over that collection (so an empty inner yields one all-null row — the
  captured outer entity is null too, matching `collection.DefaultIfEmpty()` semantics). On
  Postgres an `OuterApply` renders as `LEFT JOIN LATERAL … ON true` (the formatter supplies the
  `ON`, which `CROSS JOIN LATERAL` doesn't need). **Position is enforced**: a `defaultIfEmpty()`
  anywhere but the outermost position is never extracted, so the binder reaches it and throws
  (its `defaultIfEmpty` dispatch case is unconditionally an error) — a following `map`/other
  operator, the query root, or inside a projection all fail.
- **`queryBinder.ts` / `columnProjector.ts`** at the `linq/` root are shims over the
  `visitors/` implementations — keep imports/casing consistent (stale build output
  can otherwise load a different module identity).

## File mapping (Signum → Altea)

| Signum C# | Altea | Status |
| --- | --- | --- |
| `AliasGenerator.cs` | `logic/linq/AliasGenerator.ts` | Ported/simplified |
| `DbExpressions.{Sql,Signum}.cs` | `logic/linq/expressions.sql.ts` | Partial port |
| `DbQueryProvider.cs` | `logic/table.ts`, `logic/query.ts`, `logic/linq/translatorBuilder.ts` | Runtime split |
| `TranslateResult.cs` · `ProjectionReader.cs` | `logic/linq/translatorBuilder.ts` (+ `Retriever.ts`) | Ported (Eager before / Lazy after the main query; per-token lazy skip + fill-in-place; `TODO(remove-eager)` — collapse to lazy-only, see below) |
| `ExpressionVisitor/DbExpressionVisitor.cs` | `logic/linq/visitors/DbExpressionVisitor.ts` | Partial port |
| `ExpressionVisitor/QueryBinder.cs` | `logic/linq/visitors/QueryBinder.ts` (+ `queryBinder.ts` shim) | Partial port |
| `ExpressionVisitor/QueryFormatter.cs` | `logic/linq/queryFormatter.ts` | Partial port |
| `ExpressionVisitor/DbExpressionNominator.cs` | `logic/linq/dbExpressionNominator.ts` | Ported; also lowers residual method calls (`hardCodedMethod`) |
| `ExpressionVisitor/ColumnProjector.cs` | `logic/linq/{visitors/ColumnProjector,columnProjector,ColumnGenerator}.ts` | Partial port |
| `ExpressionVisitor/TranslatorBuilder.cs` | `logic/linq/translatorBuilder.ts` | Partial port |
| `ExpressionVisitor/OverloadingSimplifier.cs` | `logic/linq/visitors/ExpressionSimplifier.ts` | Partial analogue (+ MethodExpander hook) |
| `ExpressionVisitor/AggregateFinder+Rewriter.cs` | `logic/linq/visitors/AggregateRewriter.ts` | Ported (folded together) |
| `ExpressionVisitor/ChildProjectionFlattener.cs` | `logic/linq/visitors/ChildProjectionFlattener.ts` | Ported (scoped, eager-only) |
| `ExpressionVisitor/ConditionsRewriter.cs` (+Postgres) | `logic/linq/visitors/ConditionsRewriter.ts` | Ported (SQL-Server-only; PG variant not needed) |
| `ExpressionVisitor/EntityCompleter.cs` | `logic/linq/visitors/{QueryBinder(completed),EntityCompleter}.ts` | Ported (VisitEntity + VisitMList; eager references and collections) |
| `ExpressionVisitor/GroupEntityCleaner.cs` | `logic/linq/visitors/GroupEntityCleaner.ts` | Ported (scoped; Type key → discriminator) |
| `ExpressionVisitor/OrderByRewriter.cs` | `logic/linq/visitors/OrderByRewriter.ts` | Ported (Reverse + float-to-outermost/TOP/OFFSET; key machinery dormant) |
| `ExpressionVisitor/QueryRebinder.cs` | `logic/linq/visitors/QueryRebinder.ts` | Ported (scoped) |
| `ExpressionVisitor/QueryJoinExpander.cs` | `logic/linq/visitors/QueryJoinExpander.ts` | Partial (`TableRequest` + `UnionRequest`) |
| `UnionAllRequest` · `UnionEntity` · `ColumnUnionProjector` (in QueryBinder.cs) | `logic/linq/visitors/QueryBinder.ts` + `SetOperatorExpression` (`expressions.sql.ts`) | Ported (scoped; the UNION combine strategy) |
| `SwitchStrategy` · `CombineImplementations` (in QueryBinder.cs) | `logic/linq/visitors/QueryBinder.ts` | Ported (the CASE combine strategy + structural recursion) |
| `ExpressionVisitor/RedundantSubqueryRemover.cs` (+`SubqueryRemover`) | `logic/linq/visitors/RedundantSubqueryRemover.ts` | Ported (scoped) |
| `ExpressionVisitor/ScalarSubqueryRewriter.cs` | `logic/linq/visitors/ScalarSubqueryRewriter.ts` | Ported (SQL-Server-only) |
| `ExpressionVisitor/SmartEqualizer.cs` | `logic/linq/smartEqualizer.ts` | Ported (scoped; incl. `typeEqual`) |
| `ExpressionVisitor/UpdateDeleteSimplifier.cs` | `logic/linq/visitors/CommandSimplifier.ts` | Ported (scoped) |
| `AssignAdapterExpander` (nested in QueryBinder.cs) | `logic/linq/visitors/AssignAdapterExpander.ts` | Ported (scoped) |
| `Engine/Basics/TypeLogic.cs` + `Basics/Type.cs` | `logic/typeLogic.ts` + `entities/typeEntity.ts` | Ported (no Sync; ids computed) |
| `IMethodExpander` / `ExpressionCleaner` | `@methodExpander` (`query.ts`) + `ExpressionSimplifier` hook | Ported (scoped) |
| `AliasProjectionReplacer`, `UnusedColumnRemover`, `AliasGatherer`, `DbExpressionComparer`, `DuplicateHistory`, `QueryFilterer`, `AsOfExpressionVisitor`, `Meta/*` | none | Not ported |

`logic/linq/expressions.ts` has no direct Signum mapping — it is the altea
source-expression model bridging `quote-transformer` into the SQL pipeline.

## Test mapping

Ported LinqProvider suites live in `altea-test/test/*.test.ts` (one per Signum
`LinqProvider/*.cs`), plus the DB-free `binder.test.ts` (27). All bodies are
uncommented (the compile-clean API-stability gate). Suites not ported:
`FullTextSearch`, `SystemTime`, `VectorSearch` (need features altea doesn't model).
Per-suite pass counts move with each tier; use a live run for the current numbers.

**Prefer the `globals.ts` in-memory operators in ported tests** so the TypeScript
reads like the C# LINQ it mirrors and the mem-vs-db arms stay symmetric: use
`orderBy`/`orderByDescending` (not native `Array.prototype.sort`), `groupBy` (not a
hand-rolled `Map`/loop), and `min`/`max`/`sum`/`avg`/`count` (not a bare `reduce`).
This keeps the in-memory arm shaped like the DB arm — ideally the same
`.groupBy(k).map(gr => …)` chain over either a query or a `toArray()`ed list — which
both aids review and keeps the SQL dump comparable to Signum's.

## Verification

**Both dialects, against a real DB.** DB-gated suites only *execute* with
`ALTEA_TEST_DB` set (else they compile + SKIP). Connection strings live in
(gitignored) `altea-test/.env.postgres` and `.env.sqlserver`.

**Generate once, then run** (`node --test` runs each file in its own process, so
schema-gen + sample-load is split out of the suites into `generateEnvironment()`):

```powershell
corepack pnpm --filter @altea/altea-test gen:postgres   # once: clean + DDL + load
corepack pnpm --filter @altea/altea-test test:postgres  # fast: connect + run (parallel)
# gen:sqlserver / test:sqlserver for the other dialect
```

Run a `gen:*` first when the data is stale (an empty/stale DB fails suites on
missing data).

**After a feature is complete, compare the generated SQL to Signum's.** Staying close
to Signum's SQL shape is a goal (see Key decisions), so every finished feature ends with
a shape diff against the C# reference dumps in `sqlcmp/cs/` (produced by Signum.Test's
`SqlDumpTextWriter` with `SQL_DUMP=1` per dialect):

```powershell
# 1. dump altea's SQL for BOTH dialects (one file per test: <Class>.<Test>.<pg|ss>.sql)
$env:SQL_DUMP=1; $env:SQL_DUMP_DIR="D:/Altea/eastwind/sqlcmp/altea"
corepack pnpm --filter @altea/altea-test test:postgres
corepack pnpm --filter @altea/altea-test test:sqlserver
# 2. normalise + score altea vs Signum, per dialect (writes sqlcmp/report/*)
node sqlcmp/compare.mjs pg
node sqlcmp/compare.mjs ss
```

`compare.mjs` normalises away cosmetics (quoting, params, aliases, whitespace) and
buckets each pair identical / minor / moderate / major; it is size-skewed, so treat it as
a triage ranking and read the actual `sqlcmp/report/diffs.*.txt` for anything that
diverges in shape. Regenerate the C# dumps only when Signum itself changes.

**Mutating suites are transaction-isolated.** The suites share one loaded database
and run in parallel. The `executeXXX` suites (`unsafeUpdate`/`unsafeDelete`/
`unsafeInsert`) run each test inside **`Transaction.noCommit`** — a real transaction
rolled back at the end (not committed) without throwing, so the write path is
exercised and the test sees its own uncommitted rows, but the shared sample graph is
never contaminated. Wrapper: the `txTest(...)` helper in `test/setup.ts`. This makes
full-suite counts deterministic across runs.

**Offline gate** (compile + DB-free unit tests only — NOT sufficient to verify a
change; every DB-gated suite SKIPs):

```powershell
corepack pnpm --filter @altea/altea-test test
```
