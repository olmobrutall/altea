# DynamicQuery port — remaining work

Port of Signum's `Signum/DynamicQuery/**` + `Signum/Basics/QueryLogic.cs`. Done so far:
PropertyRoute + Implementations (Phase 0), QueryUtils/QueryDescription (Phase 1), QueryToken base +
ColumnToken + EntityPropertyToken (Phase 2), leaf tokens HasValue/EntityToString/NetProperty/AsType
(3a) + date-part/Modulo (3b), QueryLogic core + `@implementedByAll` token source (Phase 4 core).

The items below are NOT done. Ordered by how blocked they are.

## Identical-join dedup — ✅ FIXED (RedundantJoinRemover)

Selecting BOTH a reference-as-lite AND a property of the same reference used to emit two identical
joins (`map(a => ({ lbl: a.label.toLite(), nm: a.label.name }))` → two `LEFT JOIN Label … ON
A.LabelID=X.ID`), because the binder doesn't unify "the entity behind a `toLite()`" with "the entity
reached by direct `.member` navigation" (two EntityExpressions/aliases). A bind-time FK-key dedup
does NOT work — the two FKs sit under different transient subquery aliases (`s0`/`s1`) until
RedundantSubqueryRemover collapses them to `A.LabelID`. Fix: `logic/linq/visitors/RedundantJoinRemover.ts`,
a post-pass run in `table.ts` right AFTER `RedundantSubqueryRemover`, that merges sibling
`SingleRowLeftOuterJoin`s to the same table on the same owner FK (remapping the dropped join's column
refs to the survivor). Conservative — only single-row completion joins to a bare TableExpression;
INNER joins / applies / UNION sub-selects untouched; merges only when table + owner-FK match (same
target row). Covers the toLite, grouped-redundant-key, AND bare full-entity (`{lbl: a.label, nm:
a.label.name}`) scenarios — all now emit ONE join on the shared FK. (A full-entity projection also
adds joins for the entity's OWN references, e.g. label.owner on OwnerID — those are distinct FKs, not
duplicates.) Verified executing on BOTH dialects: PG 788/0, SQL Server 787/0.

## DQueryable + Requests  🟡 CORE DONE (the authoring API), pipeline gaps remain

`DQueryable` is a **user-facing authoring API** (apps write manual queries with it, cf. Southwind
`CustomersLogic`: `Database.Query<T>().Select(…).ToDQueryable(descriptions).AllQueryOperationsAsync(request)`).
So it is a real class, not a helper. Ported in `dQueryable.ts` + `requests.ts`.

DONE:
- [x] `DQueryable` class `{ query: Expression, context }` (altea wraps the query-AST Expression where
      Signum wraps IQueryable) + `toDQueryable(query, description)` + `fromEntity(...)` seeders.
- [x] `selectMany(elementTokens)` (folds in the old queryExpansion.SelectMany), `where(filters)`,
      `orderBy(orders)`, `select(columns)`, `tryPaginate(pagination)`, `allQueryOperations(request)`.
- [x] Terminals: `bindProjection()` (→ ProjectionExpression for SQL), `executeAsync()` (bind + run).
- [x] Requests model (`requests.ts`): `Filter`/`FilterCondition`/`FilterOperation`, `Order`/`OrderType`,
      `Column`, `Pagination` (All/Firsts/Paginate), `QueryRequest` (+ `multiplications()`).
- [x] `CountToken` (`countToken.ts`), `CollectionElementToken` + `CollectionElementType`
      (`collectionElementToken.ts`; buildExpression throws, seeded by selectMany), `subTokensBase`
      ArrayType branch → `collectionProperties` (Count + Element, gated by CanElement),
      `getElementImplementations`. `songs.Element.name` binds to a real correlated `CROSS APPLY`; a
      full QueryRequest → `SELECT TOP n … WHERE … ORDER BY …`.

Divergence: Signum's two-arg `SelectMany` puts `DefaultIfEmpty` on the collection → **OUTER APPLY**
(empty-collection owner kept, null element). altea's single-arg `flatMap` + outermost-only
`defaultIfEmpty` can't express that cleanly, so selectMany uses a plain `flatMap` → **CROSS APPLY**:
empty-collection owners are **dropped**.

DONE (in-memory arm):
- [x] `DEnumerable` / `DEnumerableCount` (`dEnumerable.ts`) + `concat` — the combine-two-sources
      manual query (CustomersLogic's `persons.Concat(companies).OrderBy(...).TryPaginate(...)`). In-memory
      `where`/`orderBy`/`select`/`tryPaginate` via a small expression interpreter (`evalExpr`) over the
      post-select tuple rows.
- [x] `ResultTable` / `ResultColumn` / `ResultRow` (`resultTable.ts`) — columnar materialisation +
      total-element count + totalPages; `DEnumerable.toResultTable(columns, pagination)`. `token.isEntity()`
      added to the base + ColumnToken.
- [x] `DQueryable.toDEnumerableAsync()` / `allQueryOperationsAsync(request)` terminals (execute → wrap →
      paginate in memory).

DONE (SQL-side pagination + count):
- [x] `DQueryable.tryPaginateAsync(pagination)` — Firsts → `top`; Paginate → `skip().top()` (OFFSET/FETCH)
      with a short-page COUNT skip, else `countAsync()` (`SELECT COUNT(*)`); All → execute + length.
      `allQueryOperationsAsync` now paginates SQL-side (was: materialise-all then in-memory slice).
- [x] `countAsync()` / `bindCountProjection()` — `<query>.count()`.

TODO:
- [ ] `OrderAlsoByKeys` — a stable tie-break key for pagination (Signum adds it before Skip/Take so
      pages don't overlap on a non-unique order); altea paginates without it today.
- [ ] Recover OUTER APPLY / keep-empty-owner semantics for selectMany.
- [x] `FilterGroup` (AND/OR groups) + nested any/all filters — `requests.ts` `FilterGroup` +
      `tokens/collectionAnyAllToken.ts` (`Any`/`All`/`NotAny`/`NotAll` + `buildAnyAll`). A group whose
      token passes a CollectionAnyAllToken → correlated `some`/`every` subquery combining element +
      outer conditions (`a.songs.some(s => s.name=='X' && a.year==20)` → `WHERE EXISTS(… AlbumID=A.ID
      AND …Name=@p AND A.Year=@p)`). Wired into `collectionProperties` (CanAnyAll).
- [x] IN-MEMORY (DEnumerable) any/all — `evalExpr` is now environment-based (`Map<ParameterExpression,
      value>`); a lambda argument becomes a real JS closure that extends the env, so `.some`/`.every`
      run natively with the element param bound while the outer row stays in scope. FilterGroup-with-
      anyAll works in memory (element + outer conditions correlate), matching the SQL EXISTS form.
- [ ] Full-text filters (`FilterSqlServerFullText`) + `ToTableFilter`; `FilterCondition` still covers
      comparison/string/IsIn ops only.
- [x] `groupBy` — `DQueryable.groupBy(keyTokens, aggregateTokens)` + `tokens/aggregateToken.ts`
      (`AggregateFunction` Count/Sum/Min/Max/Average; `buildAggregate`). Builds
      `source.groupBy(row => {k…}).map(g => {k…, a…over g.elements})` → `GROUP BY … COUNT(*)/SUM(…)/…`.
      The grouped context resolves key tokens to `gr.kI` and aggregate tokens to `gr.aI`.
- [x] `QueryRequest.groupResults` wired into `allQueryOperations`/`allQueryOperationsAsync`
      (`buildQueryOperations` branch): keys = non-aggregate columns, aggregates = `request.aggregateTokens()`,
      filters split into simple (WHERE, before group) vs aggregate (HAVING, `Filter.isAggregate()`).
      `a.year>1900` + `count>=2` group → `… WHERE A.Year>@p GROUP BY … ) WHERE agg>=@p ORDER BY agg`.
- [x] `GetRootKeyTokens` / `Dominates` — a key dominated by another (ancestor via navigation, no
      collection boundary) is dropped from GROUP BY and recovered off the group's key. `dominates`
      + `isCollectionToken()` on the base; `getRootKeyTokens` in dQueryable. `group by label +
      label.name` → `GROUP BY LabelID` only.
- [x] Count-where / Count-distinct — `AggregateToken` options `{filterOperation, value, distinct}`.
      Count-where → `COUNT(CASE WHEN … )`; Count-distinct → `COUNT` over `SELECT DISTINCT`.
- [ ] `SelectWithNestedQueries` / `CollectionNestedToken` (nested result sub-tables).
- [ ] `CollectionAnyAllToken` (`.Any`/`.All`/`.NoOne`), `CollectionToArrayToken` (`.ToArray*`),
      `MListElementPropertyToken` (RowId/RowOrder).

## 3c — Remaining leaf tokens  (not blocked; low priority)

- [ ] `StepToken` chain — `StepToken` → `StepMultiplierToken` → `StepRoundingToken` +
      `RoundingExpressionGenerator` (Math.Ceiling/Floor/Round). Numeric grouping buckets. Wire into
      `subTokensBase` number branch alongside Modulo.
- [ ] `DatePartStartToken` — "Month/Quarter/Week/Hour/… Start" + "Every N hours/minutes/…". Needs SQL
      date-trunc helper functions (`monthStart`/`quarterStart`/`truncHour`/…) the binder must support.
- [ ] `TimeSpanProperties` / duration parts (hours/minutes/… + totals) — wire the `TemporalType("duration")`
      branch (currently HasValue only).
- [ ] `TimeOnlyProperties` — if/when a time-only temporal type is modelled.
- [ ] `weekNumber` date part — the binder has no `weekNumber`; add it there first, then to
      `dateTimeProperties`/`dateOnlyProperties`.
- [ ] `EntityTypeToken` ("[EntityType]") — needs TypeEntity-lite plumbing:
      `base.constructor` (getEntityType) → `TypeLogic.toTypeEntity` → BuildLite. Then `PreAnd` it in the
      polymorphic (`implementedBy`-many) and `byAll` branches of `subTokensBase`.

## Phase 4 remainder — QueryLogic / registration

- [ ] `QueryLogic.Start(sb)` — `Include<QueryEntity>().WithQuery(...)`, the `QueryNameToEntity` /
      `liteToEntity` caches, `Schema_Generating` (seed QueryEntity rows), `SynchronizeQueries` (diff
      rows via the existing Synchronizer). Mirror TypeLogic/SymbolLogic.
- [x] `FluentInclude<T>` (`schema/fluentInclude.ts`) — `sb.include(T)` now returns a FluentInclude
      wrapping `{ table, schemaBuilder }` with `withIndex`/`withUniqueIndex` (+ `withQuery`/`withExpressionTo`
      by declaration merging from the dynamicQuery layer), like Signum. Internal callers use `.table`.
- [x] `withQuery` (`dynamicQuery/fluentIncludeQuery.ts`) — `sb.include(T).withQuery(r => ({ Entity: r,
      name: r.name, … }))` registers a lazy `AutoDynamicQueryCore` into `QueryLogic.Queries` (the
      DynamicQueryContainer), keyed by the entity type. Its QueryDescription is derived via
      ColumnDescriptionFactory; its runnable source is `table(T).map(selector)`.
- [x] `ColumnDescriptionFactory` (`dynamicQuery/columnDescriptionFactory.ts`) — derives each column's
      PropertyRoute by walking the projection member expression from the row param (altea reads the
      route off the quoted expression; no Meta.cs visitor). Type = reference→Lite, else route.type;
      implementations = route.tryGetImplementations().
- [x] `ExpressionContainer` + `ExtensionToken` (`dynamicQuery/expressionContainer.ts`,
      `tokens/extensionToken.ts`) — `QueryLogic.expressions` (instantiated + owned by QueryLogic, which
      also wires `setExtensionTokensProvider`/`setBuildExtensionExpr`) / `withExpressionTo(a =>
      a.albumCount())` + `withExpressionFrom(SourceType, s => …)` register a cross-entity expression as
      a sub-token; BuildExpression inlines the registered lambda against the parent (ParameterReplacer).
      Key derived from the RAW quoted body's tail member (the expanded body loses the method name).
      Wired into `QueryToken.cachedSubTokensOverride`. `withExpressionFrom`'s source = the lambda's
      param type (a DIFFERENT entity), passed explicitly since altea can't read it off a quoted lambda.
- [x] `DynamicQueryContainer` (`dynamicQuery/dynamicQueryContainer.ts`) + `DynamicQueryCore` /
      `AutoDynamicQueryCore` (`dynamicQuery/dynamicQueryCore.ts`) — the registry of executable queries
      behind `QueryLogic.Queries`. Each query is a lazy bucket (Signum's ResetLazy) keyed by
      `getKey(queryName)`; `register`/`getQueryNames`/`tryGetCore`/`getCore`/`queryDescription`/
      `executeQueryAsync`. `AutoDynamicQueryCore.executeQueryAsync` = `toDQueryable(table(T).map(sel),
      desc).allQueryOperationsAsync(request).toResultTable(columns, pagination)`. `QueryLogic.
      getQueryDescription`/`tryGetQueryDescription` now delegate here (the interim description Map is gone).
- [ ] `DynamicQueryCore.Manual` (the manual-query flavor, arbitrary `request → ResultTable` lambda) —
      only AutoDynamicQueryCore (FromSelector) is ported. `GetTypeQueries` (query-name→entity grouping)
      also not ported.
- [ ] QueryEntity unique index on `key` + DB generation (deferred with TypeEntity's, no Synchronizer-
      driven unique-index support yet).

## Client / React

- [ ] `Signum/React/QueryToken.ts` + `SearchControl/QueryTokenBuilder.tsx` — the browser-side token
      model + picker. Separate reimplementation in `react/` (as in Signum), out of scope here.

## Never-port (altea doesn't model these)

FullText (`FullTextRankToken`/`PgTsVectorColumnToken`), Vector (`VectorColumnToken`/`VectorDistanceToken`),
`TranslatedToken`, `OperationToken`/`OperationsContainerToken`, `QuickLinksToken`, `ManualToken`,
`StringSnippetToken` — unless/until the corresponding features are added to altea.
