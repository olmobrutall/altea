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
5. 🟡 navigations + JOINs — single-reference navigation done (any depth); collection SelectMany (`flatMap` → CROSS APPLY) done; `ImplementedBy*` cast→JOIN done (step 7); projecting a raw collection (ChildProjectionFlattener) still deferred
6. 🟡 order/page/distinct/unique/scalar-aggregates
7. 🟡 Lite done (projection / `.entity` navigation / `.is` / `toLite`; toStr + `.model` deferred); **`ImplementedBy*` polymorphism done** (projection / navigation / cast / `instanceof` / equality via SmartEqualizer, incl. polymorphic lites); **string SQL functions done** (indexOf/toLowerCase/toUpperCase/trim*/substring/like + length/contains/startsWith/endsWith); `GetType`/`typeof`, combine-strategy, and the date/math/ToString SQL-function tiers still pending
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
ported vs. shimmed vs. missing). `skip` now lands as an `offset` on
`SelectExpression` (OFFSET/FETCH · LIMIT/OFFSET — see the skip note under "Most
important differences"). Array `contains`
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

**Step 7 (ImplementedBy / ImplementedByAll + SmartEqualizer).** Polymorphic
references now bind, project, materialise, and compare. Verified live: **Postgres
350→383, SQL Server 357→390** (+33 each; offline gate 27→31 with four new IB/IBA
shape tests in `binder.test.ts`). The slice:

- **Expression nodes** (`expressions.sql.ts`): `ImplementedByExpression`
  (implementations keyed by ctor, each a lazy `EntityExpression` on that
  implementation's nullable FK column), `ImplementedByAllExpression` (one id
  column + a `TypeImplementedByAllExpression` wrapping the string type
  discriminator). `LiteReferenceExpression.reference` widened to
  `EntityExpression | ImplementedBy | ImplementedByAll` (Signum's `Reference`).
  Visitor methods added to `DbExpressionVisitor`; the nominator/column-projector
  need no overrides — the base traversal recurses into the implementations so
  their id/type columns get projected, and never nominates the IB/IBA wrapper
  (client-materialised, like `EntityExpression`).
- **Binder** (`QueryBinder.bindField`): `FieldImplementedBy` →
  `ImplementedByExpression`, `FieldImplementedByAll` → `ImplementedByAllExpression`
  (both wrapped in a `LiteReferenceExpression` when the field is a `Lite<T>`).
  `bindImplementedByMember` ports Signum's **DispatchIb** (CASE over which
  implementation column is non-null); IBA exposes only `.id` (concrete fields are
  reachable only through a cast). `visitCast` narrows IB→implementation /
  IBA→typed reference. `toLite` works over IB/IBA. `.entity` on a Lite-over-IB/IBA
  unwraps to the polymorphic reference.
- **`smartEqualizer.ts`** (new — port of `SmartEqualizer.cs`): `polymorphicEqual`
  lowers `==`/`!=`/`.is(…)` between any mix of typed reference, IB, IBA, Lite,
  captured constant entity/lite, and null to id (+ type) column comparisons —
  `entityEntityEquals`/`entityIbEquals`/`entityIbaEquals`/`ibIbEquals`/`ibIbaEquals`/
  `ibaIbaEquals` with `SmartAnd`/`SmartOr`/`SmartNot` folding. `entityIsInstance`
  lowers `x instanceof Ctor` (typed → static-type match; IB → that column
  `IS NOT NULL`; IBA → discriminator = clean name). Wired into the binder's
  `visitBinary` (`instanceof`, reference `==`/`!=`) and `bindMethodCall` (`.is`),
  replacing the old single-column `idOf` stopgap. Enabling fix: the source
  expression layer (`expressions.ts`) now types `instanceof`/`===`/`!==` (they
  previously threw in `BinaryExpression.calculateType`, before the binder ran).
- **Reader** (`translatorBuilder.ts` + `Retriever.ts`): `visitImplementedBy`
  folds a `(id != null ? stub(ctorN, id) : …)` chain over the implementation
  columns; `visitImplementedByAll` calls `retriever.implementedByAll(id, type)`,
  which resolves the discriminator via `resolveCleanType` (new in
  `registration.ts`, reverse of the now-shared `cleanTypeName`). Lites over IB/IBA
  materialise the same way (`retriever.lite*`).

The remaining `selectImplementations` failures are all `GetType`/`typeof` in query
(`a.constructor`, `x.constructor === Ctor`) — the unported ToString/Type tier,
flagged `TODO(api)` in the suite — plus the combine-strategy
(`CombineUnion`/`CombineCase`) and interface (`IAuthorEntity`) cases altea doesn't
model. Deferred within IB/IBA: `EntityIn` (`.contains` over a constant collection
of entities), polymorphic nested projections, and the `TypeEntity`/
`TypeImplementedBy` type expressions (only IBA's string discriminator is modelled).

**Tier 3 (GroupBy + AggregateRewriter).** `groupBy(key[, element])` now binds,
rewrites, formats, and reads end-to-end. Verified live: **groupBy.test.ts PG 65/82,
SQL Server 62/82** (from a baseline where the operator was unimplemented), and a
full-suite diff confirms **zero regressions** on either dialect (PG 387→439,
SS 394→437; +52 / +43). Offline gate 31→34 (three new `binder.test.ts` shape
cases). The slice:

- **`AggregateRequestsExpression`** (`expressions.sql.ts`) — a deferred aggregate
  naming the GROUP BY select it belongs to. **`AggregateRewriter`**
  (`visitors/AggregateRewriter.ts`, + inner `AggregateGatherer`) hoists each into
  that select as an `aggN` column and replaces the request with a column ref; wired
  first in `table.ts` `bind()` (Signum's Optimize order). The nominator nominates an
  AggregateRequest as a whole so the column projector emits a column for it.
- **`bindGroupBy`** (`visitors/QueryBinder.ts`) — faithful port of Signum's
  `BindGroupBy`: visits the source twice (main + element subquery), cleans the key
  via **`GroupEntityCleaner`**, builds the null-safe element-subquery correlation via
  **`SmartEqualizer.equalNullableGroupBy`**, and produces a `{ key, elements }`
  **ObjectExpression** projector (altea's analogue of Signum's `Grouping`). The
  element subquery's alias → `groupByMap` is the handle that lets an aggregate over
  the group defer into the GROUP BY select. `g.key`/`g.elements` read the object
  members; `g.elements.<agg>()`/`.length` route into `bindAggregate`.
- **`bindAggregate`** gained the GroupByInfo path (→ AggregateRequest, reducing a
  reference argument to its id column via `aggregateArgument`) and an `isRoot`
  distinction: a non-root standalone aggregate now returns a `ScalarExpression`
  (correlated scalar subquery) instead of a one-row projection, which also enables
  collection aggregates in a selector (`b.members.max(…)`) on Postgres.
- **`resolveMemberType`** (`expressions.ts`) now resolves `ObjectType` members, so
  `g.elements` types as an array and its aggregate operators dispatch.
- **Parameter de-duplication** (`queryFormatter.ts`): the same constant value is
  emitted as one placeholder, so a key expression repeated in SELECT and GROUP BY
  (incl. the bit constants ConditionsRewriter mints for a key CASE on SQL Server)
  renders identically — without this both dialects reject the GROUP BY.

Scoped / deferred (flagged, not regressions): the distinct-fast disassembly
(`DisassembleAggregate` Select.Distinct→`COUNT(DISTINCT)`; the complicated-subquery
fallback is correct), the "key contains an aggregate" intermediate-select branch,
and SQL Server's *aggregate-over-subquery* restriction (`min(b => b.members.max(…))`
— needs the skipped ScalarSubqueryRewriter). Out of scope (no altea API):
`minBy`/`maxBy`, `substring`, empty-key `groupBy(a => ({}))`, StdDev. Pre-existing/
orthogonal: the Postgres `COUNT`→bigint-string coercion and empty-set max/min/sum
semantics (`Root*`).

**Tier 3 follow-up (Any/All/Contains + single-result-subquery member).** Extended the
same tier: **groupBy.test.ts PG 71/82, SQL Server 68/82**; full suite PG 439→460,
SS 437→459 (still **zero regressions** vs the clean baseline). The Any/All/Contains
work also lifted the broader `allAnyContains` suite (query-level forms). Added:

- **`bindAnyAll`** / **`bindContains`** / **`getUniqueProjection`** (`QueryBinder.ts`,
  ports of Signum's `BindAnyAll`/`BindContains`/`GetUniqueProjection`) + `some`/`every`/
  `contains` dispatch. `some` → `EXISTS(…)`, `every` → `NOT EXISTS(… !pred)`
  (All(p) ≡ !Any(!p)); `contains` → `item IN (…)` for a value collection or
  `EXISTS(… element == item)` (via SmartEqualizer) for a reference collection. At the
  root the boolean is wrapped in a one-row projection; nested it stays an
  `ExistsExpression`. `contains` was also added to `Query` (`query.ts`) so the
  expression layer types `g.elements.contains(x)`.
- **Member of a single-result sub-query** (`coll.orderBy(…).firstOrNull()!.name` —
  `FirstLast*`): `bindMemberAccess` was split into a reusable `bindMember`, and a
  `ProjectionExpression` with a `uniqueFunction` now navigates the member on its
  projector and re-wraps as a scalar subquery. The whole-entity single sub-query
  (`…firstOrNull()` used directly) already materialised via the existing child-projection
  path — no new reader code.

**Tier 3 follow-up 2 (in-memory constant collections).** `allAnyContains.test.ts`
now **20/20 on both dialects** (was 12/20); full suite PG 460→468, SS 459→467 (still
zero regressions). Two pieces:

- **`EntityIn`** — `capturedList.contains(reference)` over a constant array of
  entities/lites lowers to an OR of id (+ type) comparisons (`SmartEqualizer.entityIn`,
  wired into `bindMethodCall`'s constant-array `contains` path); value arrays keep the
  `IN (…)` form.
- **Constant-collection `some`/`every`** — a captured array is now typed `ArrayType`
  (`ConstantExpression.calculateType`), so `list.some(p)` / `.every(p)` dispatch via the
  OrderedQuery prototype instead of bare `Array.prototype`; the binder expands them over
  the captured source (`bindMethodCall` → `pred(v0) OR/AND pred(v1) …`, Signum's
  BindAnyAll constant-source branch).

**Tier 3 follow-up 3 (aggregate-over-subquery + Postgres count coercion).** Full suite
PG 468→475, SS 467→474 (still zero regressions). groupBy now **PG 75/82, SS 73/82**.

- **`ScalarSubqueryRewriter`** (`visitors/ScalarSubqueryRewriter.ts`, wired into `bind()`
  after ConditionsRewriter) — SQL Server rejects an aggregate over a scalar subquery
  (`MIN((SELECT MAX(…)))`); the pass lifts the subquery to an `OUTER APPLY` on the
  enclosing FROM and references its column. No-op on Postgres. Greens the SS
  `MinMax`/`SumSum`/`MinGroupByMax`/`SumGroupbySum`/`GroupByExpandGroupBy` cluster.
- **Postgres int8 → number** (`postgresConnector.ts`): a per-pool type parser coerces
  OID 20 (the type of `COUNT(*)`, `SUM(int)`, Ticks) to a JS number — node-postgres
  returns it as a string otherwise. int4 ids and numeric/decimal (OID 1700) are
  untouched. Fixes the `Root*` count cases (and count assertions across suites).

**Tier 3 follow-up 4 (Join + outer joins via `.optional()`).** `join.test.ts` 14/14 on
both dialects (was 4 inner-join failures + outer stubs); full suite PG 475→483,
SS 474→480, zero regressions; offline gate 34→38 (four join shape cases). Pieces:

- **`bindJoin`** (`QueryBinder.ts`, port of Signum's `BindJoin`) — `a.join(b, ak, bk,
  res)` → an `InnerJoin` whose ON is `SmartEqualizer.polymorphicEqual(ak, bk)` (so
  entity/lite keys compare by id), with the two-parameter result selector bound against
  the join (navigations in it splice on via QueryJoinExpander). **Fixed a latent bug**:
  `Query.join` (`query.ts`) was dropping the other source from the call args (and used
  the wrong result type) — it now passes `otherSource.expression` as args[0].
- **Outer joins via `.optional()`** (altea's `DefaultIfEmpty` — marks the *nullable*
  side, so the join type is named for the *other*, preserved side): `extractOptional`
  unwraps the marker on either source — outer-source marked → `RightOuterJoin`,
  inner-source marked → `LeftOuterJoin`, both → `FullOuterJoin` (Signum's mapping).
- **Postgres string concat** (`queryFormatter.ts`): `+` on string operands emits `||`
  on Postgres (SQL Server keeps `+`) — needed by `JoinerExpansions` and other
  string-building projections.

**Tier 3 follow-up 5 (GroupJoin).** `groupJoin(inner, ok, ik, (o, g) => r)` — Signum
lowers it to `join(outer, inner.groupBy(ik), ok, gr => gr.key, (o, gr) => r)`, so
`bindGroupJoin` reuses `bindGroupBy` (→ a `{ key, elements }` grouping) and joins the
outer to it on `outerKey == group.key`, binding the result selector's group parameter
to the grouping's `elements` (so `g.length` / `g.toArray()` / aggregates work via the
existing group machinery). `inner.optional()` makes it a LEFT OUTER join (the outer
row survives with an empty group). Added `groupJoin` to `Query`/`IQuery`; `JoinGroup`
and `LeftOuterJoinGroup` pass on both dialects. The remaining `LeftOuterMyView` stub
needs `Database.View` / temporary tables (a separate unported feature), not groupJoin.

The join family (inner / left / right / full outer / group join) is now complete.

**Join API split (replaces `.optional()`).** The single `join(other, …)` + `.optional()`
DefaultIfEmpty marker was replaced by four explicit relational operators on
`Query<T>`/`IQuery<T>` — **`innerJoin` / `leftJoin` / `rightJoin` / `fullJoin`** — each
naming its SQL join type directly (leftJoin preserves the outer/receiver, rightJoin the
inner, fullJoin both). `.optional()` is removed; the binder dispatches on the operator
name (`JOIN_TYPES` map) into `bindJoin(joinType, …)`, so `extractOptional` is gone.
`groupJoin` no longer takes a marker — it is always a LEFT OUTER join to the grouping
(every outer row survives with an empty group, C#'s GroupJoin semantics). **`join` is
now *only* the string aggregate** (`join(separator)` → Signum's `IEnumerable.ToString`,
SQL `STRING_AGG`; still a stub). The four relational joins were also added to `Array<T>`
in `logic/index.ts` (they borrow Query's lambda/result-type metadata by name in the
expression layer) as query-only methods that **throw when called on an in-memory array**
for now. `joinGroup.test.ts` stays 13/14 on both dialects (only the `view()`-dependent
`LeftOuterMyView` red), zero regressions.

**Enumerable.ToString → STRING_AGG (the string *aggregate*).** `join(separator)` now
binds to a string aggregate — a faithful port of Signum's `BindToString`. The binder's
`bindToString` takes the source projector as the already-mapped scalar (altea's
`join(sep)` has no selector; a prior `.map` projects), nominates it, and emits
`AggregateExpression(string_agg, [scalar, SqlConstant(sep)], orderBy: undefined)` wrapped
in a one-row select — a root one-row `ProjectionExpression` (`Single`) at the top level, a
`ScalarExpression` (correlated subquery) when nested in a projection. No ORDER BY is
placed inside the aggregate (matching Signum's StringAggr path; the suite's
self-comparing assertions don't depend on it). The `string_agg` `AggregateSqlFunction`
and the formatter's generic `visitAggregate` (`STRING_AGG(expr, sep)`, dialect-insensitive
name) already existed, so no formatter change was needed. Verified live: `toString.test.ts`
**4/8 on both dialects** (`ToStringMainQuery`, `ToStringSubCollection`, `ToStringSubQuery`,
`ToStringGroupByOrdering` — the cases aggregating an already-string projection), full
suite **PG 332→336 / SS 321→325**, zero regressions. A non-scalar (entity) projector is
explicitly rejected: aggregating an entity's display string (`ToStringEntity`) and the
value-`.toString()` cases (`ToStringSubQueryIdIB`/`Numbers`, `(a.id).toString()`) need the
separate **entity/value-ToString tier** (the scalar display-string topic), still pending.

Still failing in groupBy (all genuinely out of scope): `DistinctGroupByForce`
(`substring`), `GroupMaxBy`/`GroupMinBy` (`minBy`/`maxBy`), `JoinGroupPair` (`join`),
`GroupByCount` (SS — GROUP BY a subquery, which SQL Server forbids),
`GroupMultiAggregateNoKeys` (empty key), and `RootMaxException`/`RootMinException`
(empty-set max/min should throw — altea has no non-nullable-NULL field reader) plus
`RootSumZero` (the `(int?)` cast the port dropped makes it indistinguishable from
`RootSumNull`, which it would otherwise break).

**SQL string functions (SqlFunctionsTest.StringFunctions).** The native JS string
methods now lower to SQL, a port of `DbExpressionNominator.HardCodedMethods`'
`string.*` cases. **Translation lives in the nominator, like C#** (not the binder):
`QueryBinder` leaves a non-operator method call as a *residual* `CallExpression`
(receiver + args already bound), and `DbExpressionNominator.visitCall` lowers it to
a `SqlFunctionExpression`/`LikeExpression`/arithmetic during nomination — mirroring
how Signum's binder leaves `MethodCallExpression`s for the nominator. The nominator
is now a rewriting visitor: `nominate(e)` returns `{ candidates, expression }` (the
rewritten tree), `projectColumns` splits the rewritten projector, and WHERE / ORDER
BY / aggregate-argument expressions are run through `fullNominate` (Signum's
FullNominate) to translate their residual calls. Verified live:
**sqlFunctions.test.ts StringFunctions green on both dialects**, full suite
**Postgres 483→493, SS 480→484** (offline gate 38→42; zero regressions — the boolean
cluster `WhereBool`/`WhereCase`/`SelectConditionToBool`/`SortEquals*` stays green).
The slice:

- **`indexOf`** → `CHARINDEX(needle, haystack[, start+1])` (SQL Server) /
  `strpos(haystack, needle)` (Postgres), minus 1 (SQL search is 1-based, JS is
  0-based). A `startIndex` overload is SQL-Server-only (Signum throws on Postgres).
- **`toLowerCase`/`toUpperCase`** → `LOWER`/`UPPER`; **`trimStart`/`trimEnd`** →
  `LTRIM`/`RTRIM`; **`trim`** → `TRIM` (Postgres) / `LTRIM(RTRIM(...))` (SQL Server).
- **`substring(start[, end])`** → `SUBSTRING(str, start+1, end-start)` /
  `substr(...)`. The JS↔C# impedance: JS takes an **end index**, C# a **length**, so
  altea computes `length = end - start` (Signum passes the length directly). Without
  an end, SQL Server pads with a large literal length; Postgres' `substr` omits it.
- **`like(pattern)`** → `LikeExpression` with the pattern verbatim (Signum's
  `StringExtensions.Like`); added to `entities/globals.ts` (`String.prototype.like`,
  with a regex in-memory fallback) so the entity API types it. Distinct from
  `contains`/`startsWith`/`endsWith`, which keep wrapping their argument in `%`.
- **`SqlConstantExpression` now renders as an INLINE literal** in `queryFormatter.ts`
  (`visitSqlConstant`), matching Signum — booleans dialect-aware (bit `1`/`0` on SQL
  Server, `true`/`false` on Postgres), strings quoted, numbers verbatim. This was
  required: the synthetic `+1`/`-1` offsets were emitted as bound parameters, and
  Postgres rejects `$1 + $2` ("operator is not unique: unknown + unknown") when both
  operands are untyped. The nominator also coerces captured numeric substring/indexOf
  offset args to `SqlConstant` (`asSqlLiteral`) so `end - start` has inlined operands.
- **Expression layer**: a data-driven `wellKnownResultTypes` registry (in
  `expressions.ts`) types built-ins that carry no `@resultType` decorator. It is keyed
  `"<namespace>.<method>"` (e.g. `"string.indexOf"`, `"Math.sin"`, `"Array.contains"`),
  mirroring Signum's `DbExpressionNominator`, which switches on
  `DeclaringType.TypeName() + "." + MethodName`. The namespace is derived from the
  receiver (a value's type, or a captured static like `Math`); `staticReceiverObject`
  lets `Math.<fn>` dispatch on the `Math` object itself. This replaced an earlier
  hard-coded string-method switch and is the seed for the Math/Date SQL-function tiers
  — adding an entry types a new built-in inside quoted lambdas (SQL lowering still lives
  in the nominator's `hardCodedMethod`, so `Math.sin` types but a query using it throws
  "cannot be translated to SQL" until the Math tier is added there).

Still skipped in the suite (genuinely unimplemented tiers, flagged `TODO(api)`):
`Start`/`End`/`Reverse`/`Replicate` and `InSql()` (string), `Combine*` polymorphism,
Date/Time parts·truncation·diffs, `DayOfWeek`, `Math.*`, enum/entity `ToString` in
query, table-valued functions, `SqlHierarchyId`, and `Etc`.

**SqlFunctionsTest uncommented (Math, string extensions, date parts, dayOfWeek).** The
suite's commented bodies were uncommented and the tractable ones made to pass; the rest
stay **red, not commented** (per request). `sqlFunctions.test.ts` is now **PG 17/37,
SS 16/37** genuinely passing (was 37 *trivially* green as empty bodies) — no other suite
regressed (the full-suite drop to PG 473 / SS 463 is exactly the now-visible reds in this
one file; non-sqlFunctions suites hold at 456 PG / 447 SS). Landed:

- **Math.\*** (`MathFunctions`) — `Math.sign/abs/sin/…/round/trunc/atan2/pow/log/log10` →
  SQL math functions in the nominator (`translateMath`, dialect-aware: ATN2 vs atan2,
  LOG/LOG10 vs ln/log, ROUND(x,0,1) vs trunc). The receiver is the captured `Math`
  constant (namespace `"Math"`).
- **String extensions** — `start`/`end`/`reverse`/`replicate` → `LEFT`/`RIGHT`/`REVERSE`/
  `REPLICATE` (Postgres `left`/`right`/`reverse`/`repeat`); added to `globals.ts`.
- **Date/time part extraction + dayOfWeek + quarter** (`DateTimeFunctions`, all
  `DayOfWeek*`, `DayOfWeekFunction`) — a new `TemporalType` (`entities/types.ts`) types
  date columns/expressions; **the `DbExpressionNominator` lowers** date-part *properties*
  (`.year`/`.month`/`.day`/`.hour`/`.minute`/`.second`/`.millisecond`/`.dayOfYear`/
  `.dayOfWeek`, via `visitProperty`) and the `.quarter()` *method* (via `visitCall`) to
  `DATEPART(<kw>, x)` (Postgres `date_part('<kw>', x)`) — matching Signum, which handles
  date `MemberExpression`s in the nominator. The binder just leaves date member access as
  a residual `PropertyExpression`. A new `SqlLiteralExpression` renders the bare datepart
  keyword. Non-native date helpers are declared in `entities/dateTimeExtensions.ts` (+ a
  `DayOfWeek` enum); the expression layer routes temporal method dispatch via the Temporal
  prototypes and types date members through `resolveMemberType`/the well-known registry.
- **Non-integer numeric literals stay parameterized but get an explicit type**
  (`queryFormatter.visitConstant`): a float renders as `CAST($n AS float)` rather than a
  bare `$n`. Postgres otherwise infers an untyped parameter from its context — `intCol +
  $1` coerces a `0.5` parameter to integer and rejects it. The value stays a bound
  parameter (so the plan still caches and there's no injection surface); only its type is
  pinned. (Integers are unaffected.) Postgres `Math.round` uses the 1-arg
  `round(double precision)` overload, since `round(double, int)` doesn't exist there.

Still red (deferred tiers): entity `ToString` in query (enum `.toString()` now lowers to a
value→name CASE — an `EnumType` on the bound column carries the enum object to the nominator);
`CombineUnion`/`CombineCase`; table-valued functions; `Etc`; concatenation-with-null;
and the correlated-table-subquery-in-projection (`DayOfWeekSelectNullable`, blocked by
the async-terminal typing gap — the only body still commented, with a note). dayOfWeek
SQL is the raw `DATEPART(weekday)`/`date_part('dow')` (no Signum-style normalisation to
the .NET `DayOfWeek` ordering yet), so a couple of constant-comparison cases are
data-dependent (`DayOfWeekSelectConstant` is red on SQL Server).

**Date/Time tier (construction · truncation · convert · diff · parts).** A faithful port of
`DbExpressionNominator`'s date handling, dialect-aware. Verified live: **newDateTime 6/6** on both
dialects, **sqlFunctions PG 17→23 / SS 16→22**; full suite **PG 422→434 / SS 406→417**, no
regressions. The slice:

- **Construction** (`newDateTime`): `Temporal.PlainDateTime/PlainDate/PlainTime/Duration.from({…})`
  is a constant build, so ExpressionSimplifier folds it to a `ConstantExpression` (a constant date
  in an `orderBy` is then dropped by OrderByRewriter). Required making the Temporal constructors
  *static namespace receivers* in `expressions.ts` (so the two-level `Temporal.PlainDateTime.from`
  receiver dispatches and types) — `staticReceiverValue` resolves a namespace-property receiver, and
  `wellKnownNamespace` checks static receivers *before* the null→string fallback.
- **Truncation / "start of"** (`yearStart`/`quarterStart`/`monthStart`/`weekStart`/`truncHours`/
  `truncMinutes`/`truncSeconds`) → `date_trunc('part', x)` (Postgres) / `DATETRUNC(part, x)` (SQL
  Server 2022+; the older `DATEADD(DATEDIFF(part,0,x))` fallback overflows int for fine parts —
  seconds since 1900 > 2³¹).
- **Convert** (`toPlainDate`/`toPlainDateTime`) and the `.date`/`.timeOfDay` members → `SqlCast` to
  `date`/`datetime2`(`timestamp`)/`time`.
- **Whole-unit diff** (`daysTo`/`monthsTo`/`yearsTo`) → SQL Server's `DATEDIFF`-with-CASE correction
  / Postgres date subtraction + `age()`. Duration component members (`.hours`/`.minutes`/`.seconds`)
  → `DATEPART`/`date_part`.

Deferred within the tier: `Temporal.Now` (server-now constant, like `Clock.now` — `DateParameters`)
and the `since(x).total(unit)` composition (`DateDiffFunctions`).

**enum `.toString()` in query.** `a.sex.toString()` → a value→name `CASE` (the enum member name,
not the raw int). A new `EnumType` (`entities/types.ts`) is put on the bound enum column by the
binder (was bare `number`), carrying the enum object so the nominator builds the CASE from its
members; `toString` now dispatches on any receiver (Object.prototype fallback) so the null/enum case
no longer throws. `EnumToString`/`NullableEnumToString` green; full suite **PG 434→436 / SS 417→420**,
no regressions.

**MethodExpander infrastructure + `inDB` (entity→query bridge).** A general port of Signum's
`IMethodExpander` (`ExpressionCleaner.BindMethodExpression`): a method marked `@methodExpander(fn)`
(or `sf.__methodExpander = fn`) is rewritten by `fn(instance, args)` **in `ExpressionSimplifier`**,
before binding — not in the binder. `MethodExpander` = `(instance, args) => Expression`;
`fromQuoted` stamps `sf.__methodExpander` onto the `CallExpression`, and `ExpressionSimplifier.visitCall`
invokes it and re-simplifies the result. This is altea's first such hook; it generalises to other
`[MethodExpander]` methods (e.g. `@quoted` `AutoExpressionField` members).

`entity.inDB(sel)` / `lite.inDB()` re-query a single in-memory entity, in two contexts:
- **Runtime bridge** (`logic/index.ts`) for top-level use: `inDB()` → `table(ctor).filter(e => e.is(self))`,
  `inDB(sel)` → `…map(sel).single()`. The selector is `Quoted`, and `__lambdaType`/`__resultType` are
  attached so it types inside quoted lambdas too. `table(this.constructor)` / `table(lite.entityType)`
  means the query targets the receiver's **runtime type** — `animal.inDB(a => a.legs)` hits
  `table(Cat)` or `table(Dog)` per the actual subclass.
- **`expandInDB`** (the MethodExpander) for `inDB` *inside* a quoted lambda: it `partialEval`s the
  receiver (Signum's `ExpressionEvaluator.PartialEval` — a constant entity, or `entity.toLite()` on
  one), and for a constant rewrites to the source expression `value.inDB().map(sel).single()`
  (reusing the runtime bridge, so same polymorphism); a bound (non-constant) reference degrades to
  `sel(entity)` by substituting the selector's parameter (`ParamReplacer`, Signum's
  `Expression.Invoke`). The resulting `…single()` used as a value is scalarised by the binder
  (`asScalarValue`: a single-result `ProjectionExpression` → `ScalarExpression`).

`inDB.test.ts` **9/9** both dialects; full suite **PG 436→444 / SS 420→428**, no regressions.

**Whole suite uncommented (API-stability gate).** Every ported LinqProvider test body
was uncommented and the suite now **compiles clean** (`tspc -b`, offline 42/42) — the
TDD "compile-clean = stable API" gate the plan describes, now covering the deferred
tiers too. Tests that reference unbuilt subsystems were made to compile against
**throwing stub APIs** that lock the intended call shape (recorded in each test's TODO
comments); they run **red, not commented** (per request). Live: **PG 332 / SS 323** (the
drop from ~473 is entirely the previously-*fake*-green empty bodies now showing their real
red status; the always-green suites — `where`, `allAnyContains`, `async`, `binder` — are
unchanged, so no working test regressed). Stub surface added:

- **Bulk DML** (`Query`): `executeUpdate(u => u.set(…))` + `UpdateSetter`/`UpdatePartSetter`
  builders, `executeDelete`/`executeDeleteChunks`/`executeDeleteMList`,
  `executeInsert`/`executeInsertMList`/`executeInsertView`, `executeUpdatePart`/
  `executeUpdateMList`/`executeUpdateMListPart`.
- **Query operators**: `reverse` (real — the binder lowers it), `cast`/`ofType`,
  `minBy`/`maxBy`, `expandLite`/`expandEntity`, a `join(separator)` overload (string
  aggregate — `query.map(sel).join(sep)`, distinct from the inner-join overload by its
  string arg), and `map`/`flatMap` widened with the index overload (`@lambdaTypeForParam`
  supplies `[element, number]`; `IQuery` kept in sync, since `Quoted<>` is invariant).
  Collection string-agg uses native `Array.join`. Bulk DML uses an **object-literal setter**
  (no fluent builder): `executeUpdate(a => ({ field: valueExpr, … }))`,
  `executeUpdatePart(a => a.part, p => ({ … }))`, plus `executeDelete` / `executeInsert` /
  `executeDeleteChunks`. The setter returns `UpdateValues<T>` = `{ [K in keyof T]?: unknown }`
  (keys validated, values loose — `int`/`PrimaryKey` are branded and value expressions widen
  to `number`). The `*MList*` / `executeInsertView` variants were **removed** — altea has no
  MList, so those tests operate on the **part-entity table** directly
  (`table(AlbumEntity_Songs).executeUpdate(…)`). Nested-embedded / mixin sub-field updates
  (`a.bonusTrack.name`, `a.mixin(M).x`) aren't expressible as object-literal keys → kept red.
- **Entity / Lite extension methods** are consolidated in the logic barrel **`logic/index.ts`**
  (declare-module augmentation + prototypes, installed via MusicLoader's `import "@altea/altea/logic"`;
  a `"./logic"` package-exports entry maps the bare specifier to `index`): `save` (delegates to
  `Saver`), `inDB()`/`inDB(selector)`, `Lite.retrieve`/`retrieveAndRemember`, plus `toLite(model)`.
  `index.ts` also re-exports `table`, `view`, `SchemaBuilder`. (`Lite.model` was dropped — the model
  display string is `lite.toString()`.)
- **Layering: `entities/` must not import `logic/`.** The quote-transformer model (`@quoted`,
  `@lambdaTypeForParam`, `@resultType`, `StaticFunction`, …) moved to **`entities/quoted.ts`** and
  `@column` to **`entities/decorators.ts`** (both re-exported from `logic/query` / `logic/schema` for
  back-compat); `Clock` → `entities/clock.ts`, `CorruptMixin` → `entities/corruptMixin.ts`. So the
  test entity model (`music.ts`) references only `entities/*`. A cross-entity subquery expression-field
  (`ArtistEntity.albumCount`, which needs `table(AlbumEntity)` from logic) can't be a pure-entity
  `@quoted` member, so it's a stub (its test runs red). `EntityContext.entityId` and the
  `ExpandLite`/`ExpandEntity` enums live in **`logic/query.ts`**; `view` in **`logic/table.ts`**.
  (`EntityContext.mListRowId` was removed — altea has no MList; a collection row is a part entity with
  its own `id`, reachable via `entityId`.)
- **Array** (`globals.ts`): `stdDev`/`stdDevP`. No 0-arg `count()`/`some()` overloads —
  a collection's count is `coll.length` and its EXISTS is `coll.some(a => true)` (the 0-arg
  `.some()` stays a `Query<T>` terminal). Group aggregates use `gr.elements.max(sel)` (no spread).
- **`@quoted` expression-members** (`music.ts`): the `[AutoExpressionField]` members
  (`isMale`, `fullName`, `albumCount`, `lonely`, `friendsCovariant`) are real `@quoted`
  methods (single-return bodies the transformer captures), not throwing stubs; callers use
  `a.isMale()` etc. The binder doesn't expand `@quoted` entity members yet, so they run red.
- **Entities** (`music.ts`): the `[AutoExpressionField]` computed members the tests use
  (`isMale`, `fullName`, `albumCount`, `lonely`, `friendsCovariant`) as query-only getters/
  methods (skipped by the `@field` transformer).
- **Test-only helpers** (`altea-test/test/_apiStubs.ts`): `Throw<T>()`, `today`, `Clock`,
  `EntityContext`, `ExpandLite`/`ExpandEntity`, `view`/`MyTempView`, `CorruptMixin`,
  `AwardLiteModel`.

A handful of bodies stay commented (with a `// BLOCKED:` note) because they can't be
*compiled*, not merely translated: the quote-transformer can't quote a **block-bodied
lambda** or an `as any`/`as unknown` cast; and a **query terminal used inside a quoted
lambda** is typed `Promise<T>` (the async-terminal typing gap — `inDB().…single()`,
correlated sub-queries in projections). These need the PromiseType/`.$v` gap or
transformer features resolved first, not just a stub. (The earlier `Math.max(...spread)`
blockers are gone — those tests now use `gr.elements.max(sel)`.)

**Tier 2 (Unsafe DML — set-based UPDATE / DELETE / INSERT … SELECT).** The bulk-DML
tier landed end-to-end on both dialects with **zero regressions** (non-unsafe suites
hold at PG 332 / SS 321). Live: **unsafeDelete PG 9/9 · SS 8/9**, **unsafeUpdate PG
30/38 · SS 28/38**, **unsafeInsert 5/9** both. The slice (faithful port of Signum's
DbQueryProvider Delete/Update/Insert path):

- **Command nodes** (`expressions.sql.ts`): `CommandExpression` base + `DeleteExpression`,
  `UpdateExpression`, `InsertSelectExpression`, `CommandAggregateExpression`, and the
  `ColumnAssignment` holder. Visitor hooks (`visitDelete`/`visitUpdate`/`visitInsertSelect`/
  `visitCommandAggregate`/`visitColumnAssignment`) added to `DbExpressionVisitor`.
- **Binder** (`QueryBinder.bindCommand` → `bindDelete`/`bindUpdate`/`bindInsert`): binds the
  source to a `ProjectionExpression`, then builds `ColumnAssignment[]` from the object-literal
  setter via a faithful port of Signum's `AssignAdapterExpander` + `Assign`/`AssignColumn`
  (`visitors/AssignAdapterExpander.ts`). The adapter reshapes a value to its target column:
  a captured-constant entity/lite/embedded → the matching Entity/Lite/Embedded expression with
  constant id/sub-columns; `?:`/`??` distribute the column extraction into branches; an entity
  → IB fans out across implementation columns, → IBA fills id + clean-name discriminator. The
  WHERE is the `id == externalId` self-correlation; **owned-child (`FieldEntityArray`, cascade)
  rows are deleted first** (Signum's MList-table deletes) so the parent DELETE doesn't violate
  the back-FK. `executeUpdatePart` updates a navigated target (values read from the source row).
- **Formatter** (`queryFormatter.ts`): `visitDelete`/`visitUpdate`/`visitInsertSelect` with the
  dialect split (SQL Server `DELETE … FROM` / `UPDATE … FROM`, Postgres `DELETE … USING`), and
  `wrapRowCount` (SQL Server `SELECT @@rowcount`; Postgres `WITH rows AS (… RETURNING 1) SELECT
  count(*)`). A table-name `Alias(ObjectName)` (Signum's `aliasGenerator.Table`, used as the
  UPDATE/DELETE target reference) now renders as the qualified, per-part-quoted table name.
- **`CommandSimplifier`** (`visitors/CommandSimplifier.ts`, port of UpdateDeleteSimplifier):
  collapses the trivial single-table DELETE self-join into `DELETE FROM <alias> FROM <table>`
  on SQL Server (no-op on Postgres).
- **Execution** (`table.ts` `executeCommand`, a new `IQueryTranslator` method the
  `executeUpdate`/`executeDelete`/`executeInsert`/`executeUpdatePart` terminals call directly —
  no command-vs-query sniffing in `execute`): each aggregate sub-command (owned-child deletes
  precede the parent) is **optimised, simplified, formatted, and executed independently**.
  Optimised independently so each visitor pass starts with fresh state — sub-commands can share a
  source SELECT instance, and a shared OrderByRewriter would otherwise accumulate its orderings
  across them (yielding `ORDER BY id, id`). Executed independently because Postgres rejects
  multiple parameterised statements in one prepared query. The row-count command (last) yields
  the affected scalar. `executeDeleteChunks` is a pure utility (Signum's `UnsafeDeleteChunks`):
  it loops `orderBy(id).top(chunkSize).executeDelete()` until a pass deletes fewer than a chunk —
  not a distinct command node.

Deferred/out-of-scope (flagged, not regressions): `Clock.now` (server-now constant, unported),
explicit-id insert (needs `DisableIdentity`/`OVERRIDING SYSTEM VALUE`), MList-part row-index on
insert, `[ForceNullable]` on `AlbumEntity.label` (altea models it non-null → `UpdateFieNull` hits
the constraint), an all-NULL `CASE` needing a typed cast on Postgres (`UpdateIbFieConditional`/
`UpdateEfieConditional`), the embedded-`== null` query used by the `UpdateEfie*` *post-update
assertion* (a SELECT-side gap, not the UPDATE), and SQL Server's navigated-target UPDATE binding
(`UnsafeUpdatePart`, passes on Postgres) + entity-cast DELETE (`DeleteJoin`).

**Entity/Lite ToString — column path + value ToString (partial).** `toString.test.ts` is
**8/8 on both dialects**; full suite **PG 336→343 / SS 325→332**, zero regressions. Landed:

- **`ToStr` column + pre-saving.** The `SchemaBuilder` adds a `ToStr` value column
  (`table.toStrColumn`) to an entity table whose own `toString()` is a hand-written method
  (not `@quoted`); `collectAssignments` writes `entity.toString()` into it on INSERT/UPDATE
  (Signum's `SetToStrField`).
- **`entity.toString()` / `lite.toString()` in queries** read that column (Signum's
  `Completed(ee).GetBinding(ToStrField)`): `entityToStringColumn` completes the reference and
  reads `ToStr`; a lite recurses to its reference; an IB → a CASE over implementations.
  Returns undefined (caller falls back) when there's no column. `query.join(sep)` over an
  entity re-projects its ToString first (= `map(e => e.toString())` then STRING_AGG).
- **Value `x.toString()` → SQL `CAST`** via a new minimal `SqlCastExpression`
  (`CAST(x AS varchar|nvarchar(max))`), lowered in the nominator; non-string STRING_AGG
  arguments are cast too (Postgres rejects `string_agg(integer, …)`). The expression layer now
  resolves `Number`/`Boolean` receivers so `value.toString()` types as string.

**EntityCompleter (ported) — eager Lite-`toStr` fill now works.** `visitors/EntityCompleter.ts`
is a faithful port of Signum's EntityCompleter, run in `bindQuery` after binding and before join
expansion. Its decisive piece is `visitProjection`, which **wraps the projection in a fresh
enclosing select** (FROM = the original select, re-projected via `ColumnProjector`): a projected
lite's completion join — registered against the *inner* select — is then spliced by
`QueryJoinExpander` as a *sibling* of that inner select under the new outer select, so the top
projection never becomes a join (the failure mode of the earlier naive pass, which regressed 22
tests). `visitLiteReference` sets the lite's eager model (`toStr`) via the binder's
`liteModelExpression` (= the reference's ToString, completing it). Verified live: a projected
typed lite now materialises with its real display string (e.g. `"Billy Corgan"`); **PG 343 /
SS 332, zero regressions**. Scope vs Signum: conservative — `visitEntity` is a no-op (single
references stay lazy/stubbed; only *directly-projected* lites get a model), and IBA-lite /
`@quoted`-toString models + `ExpandLite` hints are not wired yet.

**Default `@quoted toString()` on `Entity` (landed).** `Entity` now has a `@quoted` default
`toString()` = `isNew ? newNiceName(this) : niceName(this) + " " + this.id.toString()` (Signum's
`BaseToString`); `niceName`/`newNiceName` (type → human name) were added to
`entities/utils/localization.ts`. The schema rule keys off it: a column exists iff the entity's
*resolved* `toString` is a hand-written non-`@quoted` method — so a subclass with no own toString
inherits the `@quoted` default and gets **no column**, its display computed inline. The binder
expands the default directly to `<NiceName> " " CAST(id)` (`expandQuotedToString`), resolving
`niceName(this)` → a per-type constant and `this.isNew` → false (DB rows are never new). Verified
live: a projected lite of an entity with no own toString (e.g. an `AwardEntity` implementation)
now shows `"Grammy Award 1"`. Full suite **PG 343→344 / SS 332→333** (`isNew` folding also greens a
`getTypeAndNew` case), zero regressions; `toString.test.ts` + `selectLiteModel` green both dialects.

**Still pending (smaller refinements):** model `toStr` as a conditionally-`@ignore`d *field* on
`Entity` rather than the equivalent side `table.toStrColumn` slot (purely structural); expand a
subclass's *own* `@quoted` toString inline (deferred — bodies like `NoteWithDate`'s reach the
not-yet-supported `date.toString()` tier, so the eager fill skips them and the lite keeps an empty
model rather than failing); and filling lite fields *inside* a materialised entity (the
conservative EntityCompleter `visitEntity` no-op skips them).

**Step 7 (GetType / Type expressions — runtime type access in queries).** `.constructor`
(altea's `GetType()`) and `typeof(X)` comparisons now bind, compare, project, group, and
materialise across typed / `@implementedBy` / `@implementedByAll` references. Verified live:
**getTypeAndNew.test.ts 17/17 on both dialects** (was PG 1/17), and a stash-verified full-suite
diff confirms **zero regressions** on either dialect (the change also greened `SelectType`/
`SelectTypeIBA`/`SelectTypeNull`/`SelectEntityWithLiteIbType` in select and
`GroupEntityByTypeFieCount`/`GroupEntityByTypeIbCount` in groupBy — +4 in `selectImplementations`
isolated). The slice (faithful port of Signum's Type-expression tier):

- **Expression nodes** (`expressions.sql.ts`): `TypeEntityExpression` (a typed reference's
  static type, guarded by its `externalId` for the null check) and `TypeImplementedByExpression`
  (a map of implementation ctor → its nullable id column). `TypeImplementedByAllExpression`
  (the string type-discriminator column) already existed. Visitor base-traversal methods
  (`visitTypeEntity`/`visitTypeImplementedBy`) added to `DbExpressionVisitor`; like IB/IBA the
  nominator/column-projector need **no overrides** — the base traversal recurses into the
  id/type columns so they get projected, and never nominates the Type wrapper (client-
  materialised into a constructor `Function`, altea's analogue of a C# `Type`).
- **Binder** (`QueryBinder.getEntityType`, Signum's `GetEntityType`): `.constructor` on an
  EntityExpression → `TypeEntity`, on an ImplementedBy → `TypeImplementedBy`, on an
  ImplementedByAll → its existing `typeId`; lite-wrapped references unwrap first. `.constructor.name`
  (Type.FullName) → the JS ctor-name string (a `SqlConstant` for a typed ref, a CASE over the
  implementation columns for IB). Intercepted at the top of `bindMember`.
- **`smartEqualizer.ts`** (`typeEqual`, port of Signum's `TypeEquals`): a Type expression vs a
  captured ctor constant (`typeof X`), null, or another Type expression lowers to id-not-null
  guards (typed → `id IS NOT NULL` when the static type matches else False; IB → that
  implementation's `id IS NOT NULL`) or a discriminator-string comparison (IBA →
  `typeColumn = cleanTypeName(ctor)`). Full const-vs-node and node-vs-node dispatch ported. Wired
  into `visitBinary`'s `==`/`!=` ahead of the reference-equality (`polymorphicEqual`) branch via a
  new `isTypeExpression` guard.
- **Reader** (`translatorBuilder.ts`): `visitTypeEntity` → `(id != null ? ctor : null)`;
  `visitTypeImplementedBy` → a right-folded `(idN != null ? ctorN : …)` chain;
  `visitTypeImplementedByAll` → `retriever.type(typeColumn)`, a `Retriever` method resolving the
  TypeEntity-id discriminator → ctor (Signum's `Schema.GetType`).

**`TypeEntity` + `TypeLogic` (real type↔id table).** The interim clean-name-*string* discriminator
was replaced by a real **`TypeEntity` system table** and an int-id discriminator, mirroring Signum's
`Engine/Basics/TypeLogic.cs` (no Synchronizer yet). Verified live: getTypeAndNew stays 17/17, IBA
suites unchanged, full suite **PG 410 / SS 396, zero regressions** (one offline `binder.test.ts` IBA
shape assertion was updated from the old `"Album"` string to `TypeLogic.typeToId(AlbumEntity)`). The
slice:

- **`entities/typeEntity.ts`** — `@entity(SystemString, Master)` with `tableName`/`cleanName`/
  `namespace`/`className`. Non-identity int PK and **no ticks** (Signum's `[TicksColumn(false)]`),
  so the SchemaBuilder special-cases it alongside enum side-tables (`isSeeded`). (`@reflect` is also
  applied so the quote-transformer injects `@field` — it augments an existing `./reflection` import.)
- **`logic/typeLogic.ts`** — `start(schema)` (called from `SchemaBuilder.complete()`) assigns each
  entity-ctor table a **deterministic int id** (sorted by ctor name, 1..N), builds `typeToId` /
  `idToType` / `idToEntity` (the `Map<PrimaryKey, TypeEntity>`), and registers a generation step that
  seeds the rows with those explicit ids. The same deterministic assignment runs in every process, so
  the in-memory caches and the DB rows agree **without a read-back** (Signum reads ids from the DB —
  altea computes them, since there is no Sync; documented for when Sync lands).
- **IBA type column → int FK to `TypeEntity`** (`column.ts` `ImplementedByAllTypeColumn(name,
  typeEntityTable)`, `avoidForeignKey`); the SchemaBuilder auto-includes `TypeEntity` in the IBA
  branch and always in `complete()`. `sqlBuilder.insertTypeEntities` seeds the rows.
- **Discriminator is the id everywhere**: `save.ts` writes `TypeLogic.typeToId(ctor)`,
  `SmartEqualizer.typeConstant` compares it, `AssignAdapterExpander` writes it, `GroupEntityCleaner`
  groups by it, and `Retriever` (IBA / lite-IBA / `type`) resolves id → ctor via `TypeLogic`. The
  binder types the IBA discriminator column `number`. (`schemaBuilder`'s own `cleanTypeName` stays
  separate — physical table/column naming, Signum's `Reflector.CleanTypeName`, not the discriminator.)

Deferred (Signum's "Sync"): loading ids from the DB instead of computing them (so ids stay stable as
the type set evolves), and the `TypeEntity` unique indexes on `tableName`/`cleanName`. A query `Type`
value is still the bare constructor, not yet a `TypeEntity` lite/reference.
- **groupBy** (`GroupEntityCleaner`): a typed/IB Type key reduces to a `TypeImplementedByAll` over
  a CASE that yields the TypeEntity int id (so the GROUP BY column and the materialised key
  agree — grouping by *type*, not by entity id); an IBA Type key already is that discriminator
  column (base traversal). Greens `WhereToTypeEntityIB/IBAGroupBy`.

**`skip` (OFFSET/FETCH · LIMIT/OFFSET).** Implemented as an `offset` on `SelectExpression`,
threaded through every optimiser pass alongside `top` (base `visitSelect`, OrderByRewriter,
QueryRebinder, RedundantSubqueryRemover, ConditionsRewriter, AggregateRewriter, ScalarSubqueryRewriter,
ChildProjectionFlattener). `bindSkip` wraps in an OFFSET select; OrderByRewriter floats the inner
ORDER BY onto it (OFFSET, like TOP, makes the order meaningful and SQL Server requires one — a bare
`skip` gets `ORDER BY (SELECT 1)`); RedundantSubqueryRemover merges a following `top` so
`skip(n).top(m)` is one `OFFSET n ROWS FETCH NEXT m ROWS ONLY` (SQL Server) / `LIMIT m OFFSET n`
(Postgres). Verified live: **takeSkip PG 17/19, SS 14/19**; full suite **PG 410→422, SS 396→405**,
no skip-caused regressions. The remaining takeSkip reds are out of scope: `OrderByCommonSelectPaginate`
(needs `OrderAlsoByKeys` for stable pagination over a non-unique key), the empty-key-groupBy +
element-aggregate `AllAggregates*` cases (SQL Server), and `InnerTake` (a pre-existing collection
`top`+filter case, not skip). (One SQL-Server `select` test flakes between runs under parallel load now
that the skip suite issues real queries instead of erroring instantly — it passes in isolation.)

**Still pending (Type-adjacent):** `Lite.entityType` / `Type.is` on a lite (`SelectToTypeLite`,
still `// BLOCKED`); `.constructor` through a coalesce/conditional reference (Signum's
GetEntityType conditional/coalesce branches); IBA `.constructor.name` (no test); and the
`CombineUnion`/`CombineCase` polymorphism strategy (`SelectType*Union/Switch`) which altea doesn't
model.

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
- `skip` is implemented via an **`offset` on `SelectExpression`** (modern SQL:
  `OFFSET … FETCH` on SQL Server, `LIMIT … OFFSET` on Postgres) rather than
  Signum's older RowNumber rewrite. `bindSkip` wraps in an OFFSET select;
  OrderByRewriter treats an OFFSET select like a TOP one (the inner ORDER BY is
  floated onto it, since OFFSET needs an order); RedundantSubqueryRemover merges a
  following `top` so `skip(n).top(m)` lands as one `OFFSET n … FETCH m` select. A
  bare `skip` with no order gets a synthesised `ORDER BY (SELECT 1)` on SQL Server
  (which requires one). **Not** ported: `OrderAlsoByKeys` (Signum appends the PK to
  make pagination stable across ties) — so pagination over a non-unique key
  (`OrderByCommonSelectPaginate`) is order-unstable and stays red, as the test's
  `TODO(api): OrderAlsoByKeys` notes.
- String SQL functions (`contains`/`startsWith`/`endsWith` → `LIKE`, `indexOf`,
  `toLowerCase`, `substring`, …) are translated in the **`DbExpressionNominator`**
  (`visitCall` → `hardCodedMethod`), like C#'s `HardCodedMethods` — not in the binder.
  `QueryBinder` leaves them as residual `CallExpression`s (receiver + args bound) and
  the nominator lowers them during nomination; `fullNominate` does the same for WHERE /
  ORDER BY / aggregate-argument expressions. Entity-semantic method calls (`toLite`,
  `is`, `some`/`every`, array/collection `contains`) stay in the binder, as in Signum.
  (`string.length`, a *member* access rather than a method call, is still lowered to
  `LEN`/`length()` in the binder's `bindMember` — member translation hasn't moved to
  the nominator yet, a smaller remaining divergence.)
  Array `contains` over a captured constant array binds to `IN`
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
  yet for all of Signum's `Schema.Current`, post-formatters, MList,
  temporal/system-time, full-text, vector, and unsafe update/delete/insert paths.
  ImplementedBy/ImplementedByAll **are** modelled now (step 7): an IB is one
  nullable FK column per implementation; an IBA is a single id column plus a
  string type discriminator (`cleanTypeName`, not yet an int FK to a TypeEntity
  table). `SmartEqualizer` lowers reference equality / `instanceof` over them.
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
| `ExpressionVisitor/DbExpressionNominator.cs` | `altea/logic/linq/dbExpressionNominator.ts` | Partial port; DbExpressionVisitor (like Signum). Rewriting visitor: nominates server subtrees **and** translates residual method calls in `visitCall` → `hardCodedMethod`, keyed `"<receiverType>.<method>"` like Signum (`DeclaringType.TypeName() + "." + MethodName`, e.g. `"string.indexOf"`). `nominate` returns `{candidates, expression}`; `fullNominate` translates WHERE/ORDER BY. Date/Math/ToString cases still pending |
| `ExpressionVisitor/ColumnProjector.cs` | `altea/logic/linq/visitors/ColumnProjector.ts`, `altea/logic/linq/columnProjector.ts`, `altea/logic/linq/ColumnGenerator.ts` | Partial port |
| `ExpressionVisitor/TranslatorBuilder.cs` | `altea/logic/linq/translatorBuilder.ts` | Partial port |
| `ExpressionVisitor/OverloadingSimplifier.cs` | `altea/logic/linq/visitors/ExpressionSimplifier.ts` | Very partial analogue |
| `ExpressionVisitor/AliasGatherer.cs` | none | Not ported |
| `ExpressionVisitor/AliasProjectionReplacer.cs` | none | Not ported |
| `ExpressionVisitor/AliasReplacer.cs` | none | Not ported |
| `ExpressionVisitor/AggregateFinder.cs` | `altea/logic/linq/visitors/AggregateRewriter.ts` (inner `AggregateGatherer`) | Ported (folded into AggregateRewriter) |
| `ExpressionVisitor/AggregateRewriter.cs` | `altea/logic/linq/visitors/AggregateRewriter.ts` | Ported — hoists `AggregateRequestsExpression`s into their GROUP BY select; wired first in `bind()` |
| `ExpressionVisitor/ChildProjectionFlattener.cs` | `altea/logic/linq/visitors/ChildProjectionFlattener.ts` | Ported (scoped) — eager only; `{k,v}` ObjectExpression keys; correlated + Distinct + uncorrelated paths |
| `ExpressionVisitor/ConditionsRewriter.cs` | `altea/logic/linq/visitors/ConditionsRewriter.ts` | Ported (scoped) — SQL-Server-only; no nullable-bool/SqlCast/TVF/command nodes |
| `ExpressionVisitor/ConditionsRewriterPostgres.cs` | none (no-op for altea) | Not needed yet — only does a bool→int SqlCast tweak altea lacks |
| `ExpressionVisitor/DbExpressionComparer.cs` | none | Not ported |
| `ExpressionVisitor/DbQueryUtils.cs` | none | Not ported |
| `ExpressionVisitor/DuplicateHistory.cs` | none | Not ported |
| `ExpressionVisitor/EntityCompleter.cs` | `altea/logic/linq/visitors/QueryBinder.ts` (`completed`) | Partial — single-reference completion inline in the binder (lazy `EntityExpression` → bound entity + join request) |
| `ExpressionVisitor/GroupEntityCleaner.cs` | `altea/logic/linq/visitors/GroupEntityCleaner.ts` | Ported (scoped) — strips a group-key EntityExpression to its `externalId`; a Type key (TypeEntity/TypeImplementedBy) reduces to a TypeImplementedByAll over the clean-name CASE discriminator; Lite/IB via base traversal; no entity-coalesce combine path |
| `ExpressionVisitor/OrderByRewriter.cs` | `altea/logic/linq/visitors/OrderByRewriter.ts` | Ported (scoped) — Reverse flag + float-ORDER-BY-to-outermost/TOP; key machinery dormant |
| `ExpressionVisitor/QueryFilterer.cs` | none | Not ported |
| `ExpressionVisitor/QueryRebinder.cs` | `altea/logic/linq/visitors/QueryRebinder.ts` | Ported (scoped) — value-keyed column scopes; no SetOperator/RowNumber/command nodes |
| `ExpressionVisitor/QueryJoinExpander.cs` | `altea/logic/linq/visitors/QueryJoinExpander.ts` | Partial — `TableRequest` (single-row LEFT OUTER JOIN) only; `UniqueRequest`/`UnionAllRequest` deferred |
| `ExpressionVisitor/RedundantSubqueryRemover.cs` | `altea/logic/linq/visitors/RedundantSubqueryRemover.ts` | Ported (scoped) — Gatherer + SubqueryRemover + SubqueryMerger + JoinSimplifier; no Skip/SetOperator |
| `ExpressionVisitor/Replacer.cs` | none | Not ported |
| `ExpressionVisitor/ScalarSubqueryRewriter.cs` | `altea/logic/linq/visitors/ScalarSubqueryRewriter.ts` | Ported — lifts a scalar subquery used inside an aggregate to an OUTER APPLY (SQL-Server-only; no-op on Postgres) |
| `ExpressionVisitor/SmartEqualizer.cs` | `altea/logic/linq/smartEqualizer.ts` | Ported (scoped) — `polymorphicEqual` (entity/IB/IBA/Lite/null/captured-constant) + `entityIsInstance`; no PrimaryKey struct / Guid comparer / MList element / external period / nullable-bool; IBA type compared as the target's TypeEntity int id (`TypeLogic.typeToId`) |
| `ExpressionVisitor/SubqueryRemover.cs` | `altea/logic/linq/visitors/RedundantSubqueryRemover.ts` (inner `SubqueryRemover`) | Ported |
| `ExpressionVisitor/TableFinder.cs` | none | Not ported |
| `ExpressionVisitor/UnusedColumnRemover.cs` | none | Not ported |
| `ExpressionVisitor/UpdateDeleteSimplifier.cs` | `altea/logic/linq/visitors/CommandSimplifier.ts` | Ported (scoped) — DELETE self-join collapse (SQL-Server-only); SelectRowRemover not needed (commands always return the row count) |
| `ExpressionVisitor/AssignAdapterExpander.cs` (nested in QueryBinder.cs) | `altea/logic/linq/visitors/AssignAdapterExpander.ts` | Ported (scoped) — constant entity/lite/embedded → shaped value, `?:`/`??` distribution, entity→IB/IBA fan-out; no Interval/Mixin-combine/three-valued-bool |
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
| `SqlFunctionsTest.cs` | 37 (0) | `sqlFunctions.test.ts` | 37 (1) |
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
NOTE: the suites share one loaded database and run **in parallel** (no
`--test-concurrency=1`). The mutating `executeXXX` suites (`unsafeUpdate`/
`unsafeDelete`/`unsafeInsert`) are isolated via **`Transaction.noCommit`**: each
such test runs inside a real transaction that is rolled back at the end (not
committed) without throwing, so the write path is exercised and the test sees its
own uncommitted rows, but nothing persists — the shared sample graph the read-only
suites query is never contaminated. The wrapper is the `txTest(...)` helper in
`test/setup.ts` (used in place of `test(...)` in those three suites). This made the
full-suite counts **deterministic** (a re-run yields the identical pass/fail set);
before it, the committed mutations made parallel runs nondeterministic and
inflated/deflated read-suite results at random.

The plain script is the offline gate only — it runs `tspc -b` (the API-stability
/ quote-transformer compile check) plus the handful of DB-free unit tests
(`binder.test.ts` and friends); every other suite SKIPs:

```powershell
# Offline: compile + DB-free unit tests only. NOT sufficient to verify a change.
corepack pnpm --filter @altea/altea-test test
```

At the last offline run, 31 DB-free tests passed (including array `contains` →
`IN`, the step-5 navigation→JOIN shape, and the step-7 IB/IBA shapes). But that is
the *floor*, not the bar: live runs are now at **Postgres 383 / SQL Server 390
pass** (up from PG 306 / SS 306) — the order+TOP tier brought both to 316,
ConditionsRewriter took SQL Server to 323, collections/SelectMany added +11 each
(PG 327 / SS 334), Lite added +8/+6 (PG 335 / SS 340), ChildProjectionFlattener
(eager nested queries) added +15/+17 (PG 350 / SS 357), and ImplementedBy/
ImplementedByAll + SmartEqualizer added +33 each (PG 383 / SS 390). The remaining
failures are still-unimplemented features (`groupBy`, `GetType`/`typeof` in query,
combine-strategy, `contains`, two-level nesting, scalar-in-projection, `skip`,
`join`, and a few Postgres-side aggregate-coercion cases), so the live numbers, not
the offline ones, measure real progress. The order+TOP family (`OrderByFirst`,
`OrderByLast`, `OrderByTop`, `OrderByTakeOrderBy`, …), the navigation→JOIN tests,
and the IB/IBA projection / cast / `instanceof` / equality tests pass on **both**
dialects. Treat a feature as done only when its DB-gated suite is green on both
Postgres and SQL Server.

**Current stable baseline (post-`noCommit`, deterministic): Postgres 444 / SQL
Server ~428 pass** of 553 (TypeEntity + skip + Date/Time + enum `.toString()` + `inDB`/MethodExpander landed; one
SQL-Server `select` test flakes between runs under parallel load —
`SelectCount`/`SelectEmbedded`/`SelectGroupLast` — all pass in isolation). (These supersede the historical figures above, which
were measured before the `executeXXX` suites were enabled and before the
`Transaction.noCommit` isolation made the parallel run deterministic — the earlier
runs' committed mutations contaminated the shared data and made the totals
unreliable.) The GetType/Type tier brought `getTypeAndNew` to 17/17 on both
dialects. Remaining red is still-unimplemented features (`skip`, combine-strategy,
date-truncation/diff tiers, two-level nesting, `minBy`/`maxBy`, `view()`, and the
documented out-of-scope `unsafe*` cases — `Clock.now`, identity-insert, MList
row-index, typed-NULL-CASE).
