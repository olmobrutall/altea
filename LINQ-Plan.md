# LINQ Provider Port Plan

## General idea

The LINQ provider in `altea/logic/linq` should stay as close as possible to the
Signum C# implementation in
`D:\Signum\southwind\Framework\Signum\Engine\Linq`.

When adding behavior, prefer porting the same class, method shape, visitor
pipeline, and naming used by Signum. Divergence should be explicit and local:
only do it when TypeScript, the `quote-transformer` expression model, or the
current Altea runtime makes the C# shape impractical.

The desired long-term flow is still the Signum one:

1. Convert the user query expression into a SQL expression tree.
2. Normalize/rewrite that SQL tree with small visitor passes.
3. Project server-side expressions into columns.
4. Format SQL using a visitor.
5. Compile/read projection results back into entities, embedded values, and
   scalars.

The current priority is to keep moving small, tested pieces from C# to Altea
without inventing a different LINQ provider architecture.

> This is the canonical home for the LINQ provider (Phase **D**) work. The
> root `../PLAN.md` keeps only a one-line status row and a pointer here.

## Strategy & decisions

**Port Signum `Engine/Linq/` pass-for-pass.** Everything downstream of binding
(DbExpression tree, visitor base, optimisers, QueryFormatter, TranslatorBuilder,
ProjectionReader) ports faithfully. Only **QueryBinder** is adapted, because the
input is altea's JS-operator AST (`expressions.ts`: `CallExpression` on a named
`PropertyExpression`, `BinaryExpression "=="`) not C# `MethodCallExpression`.
The pipeline replaces the `throw` in `MyQueryTranslator.translate()`
(`logic/table.ts`):

`simplify (have it) → QueryBinder → optimiser passes → ChildProjectionFlattener (DELAYED) → TranslatorBuilder{ProjectionBuilder(eval-codegen) + QueryFormatter} → TranslateResult.execute() [async]`

Decisions taken (Olmo):

- **Async terminals**: `toArray`/`first`/`count`/… return Promises (the Node
  connectors are async-only). `IQuery` + `Query` were updated together.
- **TDD-first**: translate *all* Signum `LinqProvider/*.cs` tests into
  `altea-test` to lock a stable `Query<T>` API **before** implementing the
  translator. Compile-clean under `tspc` is the API-stability gate; suites SKIP
  without `ALTEA_TEST_DB`.
- **`TranslatorBuilder` compiles the projector via eval/codegen**
  (`new Function`), mirroring C#'s `Expression.Compile()` — not a tree
  interpreter.
- **Collections ≈ MList**: altea has no MList tables, but
  `FieldEntityArray`/`@backReference` part-entities (modelled in `music.ts`)
  play the same role; the collection projection machinery is a near-port of
  Signum's MList* nodes, not a fundamental divergence. Entity collections inside
  quoted lambdas borrow `@lambdaTypeForParam`/`@resultType` from `Query<T>`
  (routed via `OrderedQuery.prototype` in `expressions.ts`).
- **Ask before any divergence** beyond the agreed delays.

## Build order & phases

New module layout mirrors `old/Framework/Signum/Engine/Linq/`: expand
`expressions.sql.ts` (full DbExpression hierarchy) + `logic/linq/`
{ `aliasGenerator`, `dbExpressionVisitor`, `queryBinder`, `columnProjector`,
`dbExpressionNominator` (minimal first), `smartEqualizer`, `visitors/*`,
`queryFormatter`, `translatorBuilder`, `projectionReader` }.

Pass order — **build now**: EntityCompleter(+QueryJoinExpander) →
AliasProjectionReplacer → OrderByRewriter → QueryRebinder →
ConditionsRewriter(+Postgres) → UnusedColumnRemover + RedundantSubqueryRemover.

**Delayed (Olmo's order)**: (1) ChildProjectionFlattener/collections →
(2) Unsafe DML → (3) AggregateRewriter + DuplicateHistory (so `groupBy` +
temporal `AsOf` come last). ScalarSubqueryRewriter skipped (both dialects
support scalar subqueries).

Implementation order (each ends green):

0. ✅ **port all LinqProvider tests** (TDD)
1. ✅ DbExpression scaffolding + visitor + AliasGenerator
2. ✅ binder skeleton (`filter`+`map`) + minimal Nominator/ColumnProjector
3. ✅ formatter + reader for **scalars/tuples** end-to-end (first proof)
4. ✅ full-entity materialisation via `Retriever` (closes C retrieve)
5. 🟡 navigations + JOINs — single-reference navigation done (any depth); collection SelectMany (`flatMap` → CROSS APPLY) done; projecting a raw collection (ChildProjectionFlattener) and `ImplementedBy*` joins still deferred
6. 🟡 order/page/distinct/unique/scalar-aggregates
7. 🟡 Lite done (projection / `.entity` navigation / `.is` / `toLite`; toStr + `.model` + polymorphic lites deferred); `ImplementedBy*` polymorphism + most SQL functions still pending
8. ❌ delayed tiers

## Implementation progress log

**Step 0 done** — `altea-test/test/` has 26 ported LinqProvider suites (~600
test methods) that compile under `tspc` (the quote-transformer captures them)
and run via `node --test` (the [loader.mjs](altea-test/loader.mjs) resolver
hook); they SKIP without `ALTEA_TEST_DB`, so compile-clean is the API-stability
gate. The C#→altea idiom is [PORTING.md](altea-test/test/PORTING.md); the
surfaced API/feature backlog (the translator's red→green targets) is
[API-GAPS.md](altea-test/test/API-GAPS.md). Enabling API added this phase:
`Entity`/`Lite.is()`, `Array<T>` query operators (in globals.ts),
quote-transformer **cast** (`x as T`) + `x!` support (+ `CastExpression`).
Deferred (not ported): FullTextSearch×2, VectorSearch×2, SystemTime — they need
pgvector/hierarchyid/temporal features altea doesn't model yet.

**Step 1 done** — `logic/linq/aliasGenerator.ts` (`Alias` + `AliasGenerator`,
port of AliasGenerator.cs), `logic/expressions.sql.ts` expanded to the core
`DbExpression` hierarchy (sources: Table/Select/Join + Column/ColumnDeclaration/
OrderExpression; scalars: Aggregate/SqlFunction/SqlConstant/Case+When/Like/
Scalar/Exists/In/IsNull/IsNotNull; Projection/ChildProjection+LookupToken;
entity-semantic: Entity/Embedded/Mixin/FieldBinding/PrimaryKey), and
`logic/linq/dbExpressionVisitor.ts` (identity-preserving `DbExpressionVisitor`,
double-dispatch via `accept`, generic fallback to source-level `visitChildren`
for Binary/Constant/… inside WHERE/projector). Builds clean (`tspc -b --force`).
Deferred to their tiers: command nodes (Update/Delete/Insert), MList*,
ImplementedBy*, Lite*, Type*, Interval/temporal, TVF, RowNumber, SqlCast,
hierarchy.

**Step 2 done** — `logic/linq/queryBinder.ts` (adapted port: recognises the
marked `table(T)` source → `getTableProjection` building an `EntityExpression`+
`SelectExpression`; binds `filter`→Where, `map`→Select; `mapVisitExpand` binds
lambda bodies; `bindMemberAccess` resolves `.id`→externalId and value/embedded
fields → columns; value/enum/embedded/single-reference fields mapped — IB*/
collections deferred), `logic/linq/dbExpressionNominator.ts` (minimal: collects
server-evaluable candidates bottom-up), `logic/linq/columnProjector.ts`
(`ColumnProjector`+`ColumnGenerator`, splits projector into SELECT columns +
rebuilt projector). `table.ts` marks `table` as a query source and
`MyQueryTranslator.bind()` runs simplify→bind (execution still throws — step 3).
Verified by `altea-test/test/binder.test.ts` (no DB): bare table, filter→WHERE,
map-scalar→1 column, map-object→2 columns.

**Step 3 done** — `logic/linq/queryFormatter.ts` (DbExpression tree → SQL text +
positional params; dialect-aware: pg `$n`/`"id"` vs SQL Server `@pN`/`[id]`;
SELECT/FROM/WHERE/ORDER BY/TOP-LIMIT/JOIN keywords, scalar ops incl. null-aware
`= NULL`→`IS NULL`), `logic/linq/translatorBuilder.ts` (`TranslateResult` +
eval-codegen projector: `compileProjector` emits a `(row,consts)=>value` body
via `new Function`, reading `row["<colAlias>"]`; `async execute()` runs the
query and maps rows; `applyUnique` for First/Single). `MyQueryTranslator.execute`
binds→formats→executes (returns a Promise); `getQueryTextForDebug` returns real
SQL. **Query terminals are now async** (`toArray`/`count`/`first`/… →
`Promise<…>`). Verified by `binder.test.ts` (no DB): bound-tree shape, SQL text +
params both dialects, and full format→execute→project via a `FakeConnector`.

**Step 4 done** — entity materialisation via a `Retriever` in
`logic/linq/translatorBuilder.ts`. The projector codegen now emits, for an
`EntityExpression`, `retriever.entity(ctor, idCol, e => { e.field = …; })`
(mixin fields assigned onto the same instance), for a lazy reference
`retriever.stub(ctor, fkCol)`, and for an `EmbeddedEntityExpression`
`(hasValue ? retriever.embedded(ctor, …) : null)`. `Retriever` caches by
`type:id` (identity within a result), and **takes the clean change-tracking
snapshot on load** (`cleanModified`) — so a freshly-retrieved entity has
`isNew=false`/`isDirty()=false`. **This closes the Phase-C "retrieve"/
snapshot-on-load gap.** Binder now resolves the embedded ctor from the field's
`typeName` (so embeddeds construct). Nominator fix: `PrimaryKeyExpression` is no
longer collapsed into a column — the wrapper is kept so the reader treats the id
specially. **Pending:** deferred batch-completion of reference stubs (their
non-id fields aren't loaded yet), Lite materialisation/model, collections.

**Steps 5–6 in progress** — `orderBy`, `thenBy`, `top`, `distinct`, `first`,
`single`, and scalar aggregates have started moving toward the Signum binder
shape (see "Most important differences" + the file mapping below for what is
ported vs. shimmed vs. missing). `skip` is deliberately deferred (needs
row-number rewriting `SelectExpression` doesn't yet support). Array `contains`
over a captured constant array now binds to `IN` and formats to
`IN (@p0, @p1, …)` (`binder.test.ts`) — the enabling fix was making
`ExpressionSimplifier.visitProperty` skip folding when the property value is a
function, so the constant array receiver survives to the binder.

**Step 5 (navigation → JOIN) landed for single references.** New
`logic/linq/visitors/QueryJoinExpander.ts` + `QueryBinder.completed`/`addRequest`
/`sourceStack`: navigating a `FieldReference` field (e.g. `a.label.name`,
multi-hop too) completes the lazy `EntityExpression` at a new table alias and
emits a `SingleRowLeftOuterJoin` (`ON fkColumn = joinedTable.id`). Verified live
on Postgres — `SelectExpansion`, `SelectLetExpansion`, `SelectWhereExpansion`,
`SelectAnonymous` now pass (Postgres went 70→74 pass), and offline by three new
`binder.test.ts` cases (join shape, filter-on-navigated-field, dedup). Two-hop
`a.label.country.name` also resolves (its suite still fails only on an unrelated
`COUNT(*)`-returns-string coercion, a step-6 item). Pending in step 5:
collections (`FieldEntityArray`) and `ImplementedBy*`/`Lite` navigation.

**Step 6 (last/lastOrNull + value-column typing + string.length).** Three
changes, verified live on Postgres (**316 pass / 222 fail**, up from 306/232):

- `last` / `lastOrNull` (with and without predicate) bind via Signum's
  OverloadingSimplifier rewrite — `reverseOrders()` inverts every ORDER BY
  direction and then reuses `bindUnique` with `First`/`FirstOrDefault`, giving the
  exact SQL shape `first()` produces over the inverted order. Closes `OrderByLast`,
  `OrderByLastPredicate`, `OrderByLastOrDefault`, `OrderByLastOrDefaultPredicate`
  on Postgres.
- **Latent typing bug fixed**: `QueryBinder.valueType` switched on lowercase
  `"string"`/`"number"`/`"boolean"`, but the `@field` metadata emits *capitalized*
  JS type names (`"String"`/`"Number"`/`"Boolean"`). Every value column was
  therefore typed `LiteralType.null`. It surfaced only now because nothing
  consumed a value column's `Type` until the `.length` check; the projection
  codegen reads `.type` only for entity/embedded ctors, so the fix is safe.
- `string.length` → `SqlFunctionExpression` (`length` on Postgres, `LEN` on SQL
  Server), in `bindMemberAccess`, mirroring Signum's `string.Length`.

**Step 6 (OrderByRewriter + QueryRebinder + RedundantSubqueryRemover).** The
order+TOP optimiser tier, ported faithfully and wired into `MyQueryTranslator.bind`
after binding (Signum's `DbQueryProvider.Optimize` slice:
binder → OrderByRewriter → QueryRebinder → RedundantSubqueryRemover). This fixes
the SQL Server *"ORDER BY invalid in derived tables unless TOP/OFFSET"* error:
both dialects now go **306→316 pass** and sit at **exact parity (316 / 222)** with
identical failing sets (the remaining per-dialect splits are aggregate-coercion
and boolean-condition tests — the unported ConditionsRewriter tier — not order).

- **`reverse` now uses the `SelectOptions.Reverse` flag** (Signum's `BindReverse`),
  *not* an eager order-direction inversion in the binder. `last`/`lastOrNull`
  rewrite to Reverse → (optional Where) → First/FirstOrDefault; OrderByRewriter
  inverts the gathered orderings when it sees the flag, then clears it.
- **OrderByRewriter** gathers each select's ORDER BY bottom-up, strips it from
  inner selects, and re-emits it only at the outermost select or a select with
  TOP — so order and TOP coexist on one level (valid on SQL Server).
- **QueryRebinder** rebinds the floated column references through each select's
  exposed columns (value-keyed column scopes — JS `Map` is reference-keyed, so a
  `ColScope` keyed by `alias|name` is required). Without it the floated
  `ORDER BY s0.col` dangles ("missing FROM-clause entry for s0").
- **RedundantSubqueryRemover** (RedundantSubqueryGatherer + SubqueryRemover +
  SubqueryMerger + JoinSimplifier) collapses/merges the now-trivial pass-through
  selects, landing the final single-level SQL.

Scoped to altea's current node set — Skip/SetOperator/RowNumber and the
OrderAlsoByKeys/HasIndex key machinery are still deferred with their tiers.

**Step 6 (ConditionsRewriter).** Ported the boolean condition/value normaliser
(`logic/linq/visitors/ConditionsRewriter.ts`). SQL has no first-class boolean: a
boolean must be a CONDITION (predicate — WHERE/JOIN ON/CASE WHEN/AND/OR/NOT) or a
VALUE (bit — SELECT column/ORDER BY/`=`/COALESCE operand). The pass walks the SQL
part of the tree (`inSql`) and inserts `value→condition` (`bit ⇒ bit = 1`) and
`condition→value` (`a < b ⇒ CASE WHEN a < b THEN 1 ELSE 0 END`). **Run for SQL
Server only** — Postgres has a native boolean type, so Signum's Postgres variant
is a near no-op (only a bool→int SqlCast tweak altea doesn't need yet). Wired last
in `MyQueryTranslator.bind` (after RedundantSubqueryRemover), matching Signum's
Optimize order. Result: **SQL Server 316→323 pass** (boolean cluster `WhereBool`,
`WhereCase`, `SortEqualsTrue/False`, `SelectConditionToBool`, … now green);
Postgres unchanged at 316 (pass not run there — no regression). Simplifications vs
Signum: no three-valued (nullable-bool) `Nullify()` handling (altea has no
distinct nullable-bool Type), and `?:` stays a `ConditionalExpression` (altea
doesn't lower it to `CaseExpression`), so `visitConditional` does the
condition/value split directly.

**Step 5 (collections — FieldEntityArray → SelectMany).** Collection navigation
and `flatMap` landed, verified live: **Postgres 316→327, SQL Server 323→334**
(+11 each; offline gate still 27/27).

- **`PropertyExpression` now resolves field types** from the entity `TypeInfo`
  metadata (was a stub returning `LiteralType.null` for every field access). A
  collection field → `ArrayType`, a reference → `ClassType`, a value →
  `LiteralType`. This was the real root of the "colSelector should return an
  Array" cluster (the `flatMap` array-guard saw `null`) **and** the "Unexpected
  object type when calling filter/some/…" cluster (method dispatch in `fromQuoted`
  keys off `ArrayType`/`ClassType`). Unknown owners/fields (temporal, enums,
  unreflected) stay null.
- **Collection navigation** (`a.friends`): a lazy `FieldEntityArrayExpression`
  (the altea analogue of Signum's MListExpression — "MList" is not an altea
  concept) built on demand in `bindMemberAccess` — kept *off* the entity's
  bindings so it never reaches the column projector. `FieldEntityArray` is a child
  table with a back-reference FK, not a separate link table.
- **`fieldEntityArrayProjection`** realises it into a correlated sub-projection
  `SELECT child.* FROM <childTable> WHERE child.<fk> = <ownerId>`; consumed
  immediately so the operators (`filter`/`map`/`orderBy`) apply to it directly.
- **`bindSelectMany`** (`flatMap`) `CROSS APPLY`s the collection sub-projection
  onto the source (Signum's BindSelectMany, single-selector form). Greens
  `SelectMany`, `SelectManyLazy`, etc. The remaining selectMany failures need
  `Lite` (`toLite`/`.entity`/`.is`) or `defaultIfEmpty` — now the dominant
  cluster, and the natural next step (`toLite` ~44 mentions). Fixed the `flatMap`
  surface guard (`instanceof Array` → `instanceof ArrayType`).

Deferred within collections: projecting a raw collection (`map(a => a.friends)` —
needs ChildProjectionFlattener), the `flatMap` result-selector / index /
`defaultIfEmpty` overloads, and collection aggregates in predicates
(`a.friends.some(...)`/`.count()` as scalar/EXISTS subqueries).

**Step 7 (Lite).** `Lite<T>` projection, navigation, and identity comparison
landed: **Postgres 327→335, SQL Server 334→340** (offline gate 27/27; retriever
suite stays fully green — lite reference fields now materialise as lites, not
stubs). The `toLite`/`is` "Missing @resultType" clusters (~54) collapsed.

- **`LiteReferenceExpression`** (Signum's node) wraps the reference
  EntityExpression (id column + entity type) plus an optional `toStr`. The column
  projector projects only the wrapped id; the reader (`Retriever.lite`)
  materialises a `LiteImp(id, type, toStr)`. Registered in the nominator's
  `instanceof` dispatch (it nominates the children, never itself).
- **Binder**: a `Lite<T>` FieldReference (`column.isLite`) binds to a
  LiteReference (not a bare entity); `entity.toLite()` → LiteReference;
  `entity.is(x)`/`lite.is(x)` lower to an id comparison (`idOf` extracts the id
  from an entity / lite / captured constant); `lite.entity`/`.entityOrNull` unwrap
  to the reference (so navigating through a lite joins as usual), `lite.id` →
  the FK column. The collection back-reference FK is itself a lite, so
  `fieldEntityArrayProjection` unwraps it.
- **Expression layer**: a dedicated `LiteType` (in `entities/types.ts`) wraps the
  entity type, distinct from `ClassType`. `Entity.prototype.is`/`toLite` and
  `Lite.prototype.is` carry `__resultType` metadata (`is` → boolean,
  `toLite` → `LiteType(owner)`); `fromQuoted` routes method dispatch on a `LiteType`
  to `Lite.prototype`, and `resolveMemberType` types lite fields as `LiteType` and
  resolves `lite.entity`/`.entityOrNull` back to the wrapped entity (so
  `lite.entity.field` types correctly). `idOf` lowers `.is(...)` to a single-column
  id comparison — a stopgap to be replaced by SmartEqualizer for polymorphic
  (ImplementedBy/ImplementedByAll) equality.

**Deferred (Lite-adjacent):** the display string `toStr` is empty for now (needs a
per-type server-side `toString` expression — the ToString tier); `.model`
(LiteModel) projection; polymorphic lites over `ImplementedBy` (`a.award`,
`b.lastAward` → still "Field not found"); and nested-query / scalar-in-projection
shapes (`map(a => …toArray())`, `map(a => a.friends.count())`) which surface as
`toArray` "Missing @resultType" or "ProjectionBuilder left extra expressions" and
need ChildProjectionFlattener / ScalarSubqueryRewriter.

**Step 8 foundation (PromiseType — async terminals / nested queries).** Query
terminals are async at the top level, so their expression-layer result type is now
`PromiseType<T>` (`entities/types.ts`): `toArray → Promise<T[]>`, `first/single/…
→ Promise<T>`, `count/sum/some/… → Promise<number|boolean>`. A query expression
has no async, so:

- **Borrowing a Query terminal's resolver for an `Array<T>`/sub-query strips the
  Promise** — `fromQuoted` unwraps `PromiseType` to its inner type when the
  receiver is an `ArrayType` (so `a.friends.first()` is a value, `…toArray()` a
  list). This is what gave `toArray` a type at last; its 15 "Missing @resultType"
  failures became 12 "operator 'toArray' is not implemented" — i.e. moved from the
  expression layer into the binder, where nested-query (ChildProjectionFlattener)
  support is the next step.
- **`promise.$v`** is the explicit await marker (`resolveMemberType` types it as
  the inner `T`); the binder unwraps a single-result sub-projection into a
  `ScalarExpression` (a scalar subquery). Wired but not yet exercised by tests.

Regression-free (PG 336 / SS 341 unchanged, offline 27/27) — this is plumbing for
the nested-query / scalar-subquery tier, not yet a behavioural change.

**Step 8 (ChildProjectionFlattener — eager nested queries).** Nested projections
(`map(l => …toArray())`) are now eager-loaded: **Postgres 336→350, SQL Server
341→357** (offline 27/27, no regression). The whole tier:

- **Binder**: `toArray` on a projection returns it (a nested list marker);
  `ColumnProjector` keeps a nested `ProjectionExpression` opaque (its columns are
  its own scope) for the flattener to extract.
- **`ChildProjectionFlattener`** (`visitors/ChildProjectionFlattener.ts`): replaces
  each nested projection with a `ChildProjectionExpression` carrying a correlation
  key (the parent columns it references) and a standalone child query that yields
  `{k, v}` rows. Correlated children become a `CROSS APPLY` of the parent key
  source with the inner select; uncorrelated ones get a constant key. Ports the
  Distinct (non-key correlation) path, `KeyFinder` (Table/Select/Join), order
  extraction, and `ColumnReplacer`/`ExternalColumnGatherer`. Runs last in
  `bind()` (Signum's order), followed by a RedundantSubqueryRemover re-clean.
- **Reader** (`translatorBuilder.ts`): gathers child projections deepest-first,
  runs each as its own query, groups rows by the serialised key into a
  `Map<token, Map<keyStr, value[]>>` lookup, then projects the main query reading
  its slice per row (`visitChildProjection` codegen). The no-child path is
  unchanged, so non-nested queries are unaffected.

Greens `SelecteNested`/`NonKey`/`SemiIndePendent` and the inner/outer ordering
variants. Still failing (deferred to their tiers): polymorphic nested projections
(`ImplementedBy`), `groupBy`, `contains`, and two-level (`DoubleNested`) nesting.
Scoped vs Signum: eager only (no lazy MList), `{k,v}` carried as an
`ObjectExpression` with string-serialised keys (no tuple/ArrayBox), no
`UnusedColumnRemover` (altea materialises all columns).

## Most important differences so far

- TypeScript uses `quote-transformer` expressions instead of
  `System.Linq.Expressions`. This means the binder has to recover some type and
  method information from Altea metadata and from expression annotations.
- `DbExpressionNominator` inherits from `DbExpressionVisitor` (like Signum's), so
  node routing is the usual `accept` double-dispatch — no hand-written `instanceof`
  table. It overrides only the nodes that nominate (leaf SQL values, the
  composite operators, whole-subquery Scalar/Exists/In) and the non-server nodes
  that must not recurse (Projection / Parameter / Property / Call / Lambda); the
  client-materialised nodes (Entity / Embedded / Mixin / LiteReference / object &
  `new` literals) just use the base traversal, which recurses without nominating.
  (An earlier revision made it an `ExpressionVisitor` with a manual dispatch
  table; that was reverted — it was more code and threw `asDbVisitor` on any
  DbExpression node it hadn't enumerated.)
- `QueryFormatter` is now visitor-based and inherits from
  `DbExpressionVisitor`, like Signum's C# formatter. It returns `{ sql,
  parameters }` instead of `SqlPreCommandSimple`/database parameter objects.
- The projection compiler in `translatorBuilder.ts` uses a generated JavaScript
  function over row objects. Signum builds expression lambdas over
  `IProjectionRow`.
- `ProjectionBuilder` in `translatorBuilder.ts` now inherits from
  `DbExpressionVisitor`, matching the C# visitor style more closely.
- `QueryBinder` is still much smaller than Signum's binder and optimizer
  pipeline. `orderBy`, `thenBy`, `top`, `distinct`, `first`, `single`, and
  scalar aggregates have started moving toward the Signum shape.
- **Entity navigation (step 5)** is ported: navigating a single-reference field
  (`a.label.name`, any depth) completes the lazy `EntityExpression` at a fresh
  table alias (`QueryBinder.completed`, Signum's `EntityCompleter`) and records a
  `TableRequest`; a second pass, `QueryJoinExpander`, splices the implicit
  `SingleRowLeftOuterJoin`s in around the right source after binding. Completion
  is deduped (navigating `a.label` twice → one join) and `.id` short-circuits to
  the FK column (no join). The binder tracks the lambda's source on a
  `sourceStack` so each join attaches to the SELECT being built. Collection
  (`FieldEntityArray`) and `ImplementedBy*` joins are still deferred.
- `thenBy` currently uses a queued/revisit pattern to stay close to Signum's
  `QueryBinder` behavior.
- Aggregate terminals currently use `UniqueFunction.Single` at the root, matching
  Signum.
- `skip` is deliberately deferred. Signum rewrites this through row-number /
  overload simplification paths; Altea's `SelectExpression` does not yet have
  the required shape.
- String `contains`, `startsWith`, and `endsWith` bind to `LIKE` for constant
  patterns. Array `contains` over a captured constant array binds to `IN`
  (`InExpression.fromValues`). For that to work, `ExpressionSimplifier` must
  **not** constant-fold a property access whose value is a *function*
  (`ids.contains` would otherwise collapse to the bare `Array.prototype.contains`
  and lose the `ids` receiver) — the binder needs the constant receiver to
  recover the array. General `IN` over subqueries and richer method dispatch
  still need more quote/type normalization.
- The full rewrite pipeline is not ported yet: order-by rewriting, redundant
  subquery removal, unused column removal, aggregate rewriting, smart equality,
  condition rewriting, alias replacement, and child projection flattening are
  still incomplete or missing.
- Schema/runtime services are simpler in Altea. There is no direct equivalent
  yet for all of Signum's `Schema.Current`, post-formatters, Lite handling,
  ImplementedBy/ImplementedByAll, MList, temporal/system-time, full-text, vector,
  and unsafe update/delete/insert paths.
- `queryBinder.ts` and `columnProjector.ts` at the root of `linq` are shims over
  the visitor implementations. Keep imports/casing consistent because stale or
  flattened build output can otherwise load a different module identity.

## Implementation file mapping

| Signum C# file | Altea file | Status |
| --- | --- | --- |
| `AliasGenerator.cs` | `altea/logic/linq/AliasGenerator.ts` | Ported/simplified |
| `DbExpressions.Sql.cs` | `altea/logic/linq/expressions.sql.ts` | Partial port |
| `DbExpressions.Signum.cs` | `altea/logic/linq/expressions.sql.ts` | Partial port |
| `DbQueryProvider.cs` | `altea/logic/table.ts`, `altea/logic/query.ts`, `altea/logic/linq/translatorBuilder.ts` | Partial/runtime split |
| `TranslateResult.cs` | `altea/logic/linq/translatorBuilder.ts` | Partial port |
| `ProjectionReader.cs` | `altea/logic/linq/translatorBuilder.ts`, `altea/logic/linq/Retriever.ts` | Partial port |
| `ExpressionVisitor/DbExpressionVisitor.cs` | `altea/logic/linq/visitors/DbExpressionVisitor.ts` | Partial port |
| `ExpressionVisitor/QueryBinder.cs` | `altea/logic/linq/visitors/QueryBinder.ts`, `altea/logic/linq/queryBinder.ts` | Partial port |
| `ExpressionVisitor/QueryFormatter.cs` | `altea/logic/linq/queryFormatter.ts` | Partial port |
| `ExpressionVisitor/DbExpressionNominator.cs` | `altea/logic/linq/dbExpressionNominator.ts` | Partial port; DbExpressionVisitor (like Signum) |
| `ExpressionVisitor/ColumnProjector.cs` | `altea/logic/linq/visitors/ColumnProjector.ts`, `altea/logic/linq/columnProjector.ts`, `altea/logic/linq/ColumnGenerator.ts` | Partial port |
| `ExpressionVisitor/TranslatorBuilder.cs` | `altea/logic/linq/translatorBuilder.ts` | Partial port |
| `ExpressionVisitor/OverloadingSimplifier.cs` | `altea/logic/linq/visitors/ExpressionSimplifier.ts` | Very partial analogue |
| `ExpressionVisitor/AliasGatherer.cs` | none | Not ported |
| `ExpressionVisitor/AliasProjectionReplacer.cs` | none | Not ported |
| `ExpressionVisitor/AliasReplacer.cs` | none | Not ported |
| `ExpressionVisitor/AggregateFinder.cs` | none | Not ported |
| `ExpressionVisitor/AggregateRewriter.cs` | none | Not ported |
| `ExpressionVisitor/ChildProjectionFlattener.cs` | `altea/logic/linq/visitors/ChildProjectionFlattener.ts` | Ported (scoped) — eager only; `{k,v}` ObjectExpression keys; correlated + Distinct + uncorrelated paths |
| `ExpressionVisitor/ConditionsRewriter.cs` | `altea/logic/linq/visitors/ConditionsRewriter.ts` | Ported (scoped) — SQL-Server-only; no nullable-bool/SqlCast/TVF/command nodes |
| `ExpressionVisitor/ConditionsRewriterPostgres.cs` | none (no-op for altea) | Not needed yet — only does a bool→int SqlCast tweak altea lacks |
| `ExpressionVisitor/DbExpressionComparer.cs` | none | Not ported |
| `ExpressionVisitor/DbQueryUtils.cs` | none | Not ported |
| `ExpressionVisitor/DuplicateHistory.cs` | none | Not ported |
| `ExpressionVisitor/EntityCompleter.cs` | `altea/logic/linq/visitors/QueryBinder.ts` (`completed`) | Partial — single-reference completion inline in the binder (lazy `EntityExpression` → bound entity + join request) |
| `ExpressionVisitor/GroupEntityCleaner.cs` | none | Not ported |
| `ExpressionVisitor/OrderByRewriter.cs` | `altea/logic/linq/visitors/OrderByRewriter.ts` | Ported (scoped) — Reverse flag + float-ORDER-BY-to-outermost/TOP; key machinery dormant |
| `ExpressionVisitor/QueryFilterer.cs` | none | Not ported |
| `ExpressionVisitor/QueryRebinder.cs` | `altea/logic/linq/visitors/QueryRebinder.ts` | Ported (scoped) — value-keyed column scopes; no SetOperator/RowNumber/command nodes |
| `ExpressionVisitor/QueryJoinExpander.cs` | `altea/logic/linq/visitors/QueryJoinExpander.ts` | Partial — `TableRequest` (single-row LEFT OUTER JOIN) only; `UniqueRequest`/`UnionAllRequest` deferred |
| `ExpressionVisitor/RedundantSubqueryRemover.cs` | `altea/logic/linq/visitors/RedundantSubqueryRemover.ts` | Ported (scoped) — Gatherer + SubqueryRemover + SubqueryMerger + JoinSimplifier; no Skip/SetOperator |
| `ExpressionVisitor/Replacer.cs` | none | Not ported |
| `ExpressionVisitor/ScalarSubqueryRewriter.cs` | none | Not ported |
| `ExpressionVisitor/SmartEqualizer.cs` | none | Not ported |
| `ExpressionVisitor/SubqueryRemover.cs` | `altea/logic/linq/visitors/RedundantSubqueryRemover.ts` (inner `SubqueryRemover`) | Ported |
| `ExpressionVisitor/TableFinder.cs` | none | Not ported |
| `ExpressionVisitor/UnusedColumnRemover.cs` | none | Not ported |
| `ExpressionVisitor/UpdateDeleteSimplifier.cs` | none | Not ported |
| `AsOfExpressionVisitor.cs` | none | Not ported |
| `ExpressionMetadataStore.cs` | Type metadata in `altea/entities` and query annotations | Different runtime model |
| `Meta/*` | none | Not ported |
| LINQ docs `Linq.*.md` | none | Reference only |

`altea/logic/linq/expressions.ts` has no direct Signum file mapping. It is the
Altea source-expression model used to bridge `quote-transformer` into the SQL
expression pipeline.

## Unit test mapping

Counts are source-level test declarations as of this file's creation. The number
in parentheses is individually commented-out/skipped tests detected in that
file. Altea also has DB-gated suites that are skipped when `ALTEA_TEST_DB` is
not set; those are not counted as commented-out tests here.

| Signum test file | Signum tests | Altea test file | Altea tests |
| --- | ---: | --- | ---: |
| `WhereTest.cs` | 55 (0) | `where.test.ts` | 7 (0) |
| `SelectTest.cs` | 84 (0) | `select.test.ts` | 84 (64) |
| `SelectManyTest.cs` | 14 (0) | `selectMany.test.ts` | 14 (10) |
| `JoinGroupTest.cs` | 14 (0) | `joinGroup.test.ts` | 14 (10) |
| `GroupByTest.cs` | 82 (1) | `groupBy.test.ts` | 82 (15) |
| `OrderByTest.cs` | 19 (0) | `orderBy.test.ts` | 19 (8) |
| `SelectSortCirtuitTest.cs` | 10 (0) | `selectSortCircuit.test.ts` | 10 (7) |
| `TakeSkipTest.cs` | 19 (0) | `takeSkip.test.ts` | 19 (11) |
| `SingleFirstTest.cs` | 10 (0) | `singleFirst.test.ts` | 10 (9) |
| `DistinctTest.cs` | 9 (0) | `distinct.test.ts` | 9 (2) |
| `AllAnyContainsTest.cs` | 20 (0) | `allAnyContains.test.ts` | 20 (6) |
| `SqlFunctionsTest.cs` | 37 (0) | `sqlFunctions.test.ts` | 37 (37) |
| `ExpandTest.cs` | 5 (0) | `expand.test.ts` | 5 (5) |
| `SelectNestedTest.cs` | 19 (2) | `selectNested.test.ts` | 19 (18) |
| `SelectImplementations.cs` | 48 (0) | `selectImplementations.test.ts` | 48 (36) |
| `SelectLiteModel.cs` | 1 (0) | `selectLiteModel.test.ts` | 1 (1) |
| `GetTypeAndNewTest.cs` | 17 (1) | `getTypeAndNew.test.ts` | 17 (17) |
| `ToStringTest.cs` | 8 (0) | `toString.test.ts` | 8 (8) |
| `NewDateTimeTest.cs` | 6 (0) | `newDateTime.test.ts` | 6 (6) |
| `InDBTest.cs` | 9 (0) | `inDB.test.ts` | 9 (9) |
| `EntityContextTest.cs` | 6 (0) | `entityContext.test.ts` | 6 (6) |
| `RetriverTest.cs` | 7 (0) | `retriver.test.ts` | 7 (1) |
| `AsyncTest.cs` | 0 (0) | `async.test.ts` | 4 (2) |
| `UnsafeUpdateTest.cs` | 38 (0) | `unsafeUpdate.test.ts` | 38 (38) |
| `UnsafeDeleteTest.cs` | 9 (0) | `unsafeDelete.test.ts` | 9 (9) |
| `UnsafeInsertTest.cs` | 9 (0) | `unsafeInsert.test.ts` | 9 (9) |
| `FullTextSearchTest.Postgres.cs` | 6 (0) | none | 0 (0) |
| `FullTextSearchTest.SqlServer.cs` | 10 (0) | none | 0 (0) |
| `SystemTimeTest.cs` | 7 (0) | none | 0 (0) |
| `VectorSearchTest.Postgres.cs` | 3 (0) | none | 0 (0) |
| `VectorSearchTest.SqlServer.cs` | 4 (0) | none | 0 (0) |
| none | 0 (0) | `binder.test.ts` | 27 (0) |

## Verification

**Run the tests against a real database.** The bulk of the ported suites only
*execute* when `ALTEA_TEST_DB` is set — without it they compile and then SKIP,
so an offline run proves nothing about translation correctness. The two
connection strings live in (gitignored) env files in `altea-test/`:
`.env.postgres` and `.env.sqlserver`. There are dedicated scripts that load
them:

```powershell
# Postgres (loads .env.postgres → ALTEA_TEST_DB)
corepack pnpm --filter @altea/altea-test test:postgres

# SQL Server (loads .env.sqlserver → ALTEA_TEST_DB)
corepack pnpm --filter @altea/altea-test test:sqlserver
```

Both dialects must pass — the formatter and connectors diverge per dialect, so a
change is not "verified" until it is green on **both** Postgres and SQL Server.

**Generate the data once, then run.** `node --test` runs each test file in its
own process, so the schema-gen + sample-load must NOT happen per file. It is
split out of the suites' `before` (which now only `start()` — connect + build the
in-memory schema) into `generateEnvironment()`. Load the database once, then run
the suites against it as many times as you like:

```powershell
corepack pnpm --filter @altea/altea-test gen:sqlserver   # once: clean + DDL + load
corepack pnpm --filter @altea/altea-test test:sqlserver  # fast: each file only connects, files run in parallel
```

(`gen:postgres` / `test:postgres` for the other dialect; the `gen:*` one-shot is
`test/generateEnvironment.ts`.) Skipping `gen:*` against an empty/stale DB makes
the suites fail on missing data — run a `gen:*` first when the data is stale.
NOTE: the suites now share one loaded database and run **in parallel** (no
`--test-concurrency=1`), which is fine while the mutating `unsafe*` suites are
skipped; when those are enabled they will need per-test isolation (transaction
rollback or a re-gen, and likely serialised execution) so they don't contaminate
the shared data.

The plain script is the offline gate only — it runs `tspc -b` (the API-stability
/ quote-transformer compile check) plus the handful of DB-free unit tests
(`binder.test.ts` and friends); every other suite SKIPs:

```powershell
# Offline: compile + DB-free unit tests only. NOT sufficient to verify a change.
corepack pnpm --filter @altea/altea-test test
```

At the last offline run, 27 DB-free tests passed (including array `contains` →
`IN`, and the step-5 navigation→JOIN shape). But that is the *floor*, not the
bar: live runs are now at **Postgres 350 / SQL Server 357 pass** (up from PG 306 /
SS 306) — the order+TOP tier brought both to 316, ConditionsRewriter took SQL
Server to 323, collections/SelectMany added +11 each (PG 327 / SS 334), Lite
added +8/+6 (PG 335 / SS 340), and ChildProjectionFlattener (eager nested queries)
added +15/+17 (PG 350 / SS 357). The remaining failures are still-unimplemented
features (`groupBy`, `ImplementedBy*` polymorphism / polymorphic lites, `contains`,
two-level nesting, scalar-in-projection, `skip`, `join`, `instanceof`/`===`, and a
few Postgres-side aggregate-coercion cases), so the live numbers, not the offline ones,
measure real progress. The order+TOP family (`OrderByFirst`, `OrderByLast`,
`OrderByTop`, `OrderByTakeOrderBy`, …) and the navigation→JOIN tests pass on
**both** dialects. Treat a feature as done only when its DB-gated suite is green
on both Postgres and SQL Server.
