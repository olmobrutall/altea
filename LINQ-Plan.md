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
  is a near-port of Signum's MList* nodes.
- **Ask before diverging** beyond the ones already recorded here.

## Status

Runs against both dialects. **Current stable baseline: Postgres 458 / SQL Server
~440 pass of 553** (deterministic since the `noCommit` isolation below; one SQL
Server `select` test flakes under parallel load — `SelectCount`/`SelectEmbedded`/
`SelectGroupLast` — all pass in isolation). For done work the **code is the source
of truth**; this is a map, not a spec.

**Done** (green on both dialects unless noted):

- **Core pipeline** — DbExpression hierarchy (`expressions.sql.ts`),
  `DbExpressionVisitor`, `AliasGenerator`, `QueryBinder`, `DbExpressionNominator`,
  `ColumnProjector`/`ColumnGenerator`, `QueryFormatter`, `TranslatorBuilder` +
  `Retriever` (materialisation).
- **Materialisation** — full entities, embeddeds, mixins; the clean change-tracking
  snapshot is taken on load (closes the Phase-C retrieve gap).
- **Query operators** — `filter`, `map`, `flatMap` (→ CROSS APPLY), `orderBy`/
  `thenBy`(+`Descending`), `top`, `skip` (OFFSET/FETCH · LIMIT/OFFSET), `distinct`,
  `first`/`single`/`last`(+`OrNull`), `reverse`, `count`/`min`/`max`/`sum`/`avg`,
  `some`/`every`/`contains`, the join family (`innerJoin`/`leftJoin`/`rightJoin`/
  `fullJoin`/`groupJoin`), `groupBy` (+ element aggregates, Any/All/Contains),
  eager nested projections (`ChildProjectionFlattener`).
- **Navigation → JOIN** — single-reference navigation of any depth (`EntityCompleter`
  inline in the binder + `QueryJoinExpander` splicing SingleRow LEFT OUTER JOINs).
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

**Pending / out of scope** (each flagged `TODO(api)` in its suite):

- `@quoted` `AutoExpressionField` members (`isMale`, `fullName`, `albumCount`) —
  now expandable via the MethodExpander hook, not yet wired. (Combine reaches these
  as residual calls — `combineCase().fullName()` binds the IB but the member body
  isn't expanded yet, so `SelectPolyExpression*` stay red on both dialects.)
- `EntityContext.entityId`; `Lite.entityType` / `Type.is` on a lite.
- `Temporal.Now` / `Clock.now` (server-now constant); `since(x).total(unit)` diff.
- `minBy`/`maxBy`, `ofType`/`cast`, `view()`/temp tables, `OrderAlsoByKeys`
  (stable pagination over a non-unique key).
- Deferred subsystems: FullText, Vector (pgvector), SystemTime/temporal.
- `TypeLogic` "Sync" (load ids from the DB instead of computing them) and
  `TypeEntity` unique indexes; the documented out-of-scope `unsafe*` cases
  (`Clock.now`, identity-insert, MList row-index, typed-NULL-in-CASE).

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
- **`queryBinder.ts` / `columnProjector.ts`** at the `linq/` root are shims over the
  `visitors/` implementations — keep imports/casing consistent (stale build output
  can otherwise load a different module identity).

## File mapping (Signum → Altea)

| Signum C# | Altea | Status |
| --- | --- | --- |
| `AliasGenerator.cs` | `logic/linq/AliasGenerator.ts` | Ported/simplified |
| `DbExpressions.{Sql,Signum}.cs` | `logic/linq/expressions.sql.ts` | Partial port |
| `DbQueryProvider.cs` | `logic/table.ts`, `logic/query.ts`, `logic/linq/translatorBuilder.ts` | Runtime split |
| `TranslateResult.cs` · `ProjectionReader.cs` | `logic/linq/translatorBuilder.ts` (+ `Retriever.ts`) | Partial port |
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
| `ExpressionVisitor/EntityCompleter.cs` | `logic/linq/visitors/{QueryBinder(completed),EntityCompleter}.ts` | Partial |
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
