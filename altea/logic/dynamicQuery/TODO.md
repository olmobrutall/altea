# DynamicQuery port — remaining work

Port of Signum's `Signum/DynamicQuery/**` + `Signum/Basics/QueryLogic.cs`. Done so far:
PropertyRoute + Implementations (Phase 0), QueryUtils/QueryDescription (Phase 1), QueryToken base +
ColumnToken + EntityPropertyToken (Phase 2), leaf tokens HasValue/EntityToString/NetProperty/AsType
(3a) + date-part/Modulo (3b), QueryLogic core + `@implementedByAll` token source (Phase 4 core).

The items below are NOT done. Ordered by how blocked they are.

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
- [ ] IN-MEMORY (DEnumerable) any/all: the `evalExpr` interpreter can't evaluate a `.some`/`.every`
      lambda yet, so a FilterGroup-with-anyAll only works on the SQL (DQueryable) side. Simple
      (tokenless) AND/OR groups work in memory.
- [ ] Full-text filters (`FilterSqlServerFullText`) + `ToTableFilter`; `FilterCondition` still covers
      comparison/string/IsIn ops only.
- [ ] `groupBy` (GroupResults), `SelectWithNestedQueries` / `CollectionNestedToken`.
- [ ] `CollectionAnyAllToken` (`.Any`/`.All`/`.NoOne`), `CollectionToArrayToken` (`.ToArray*`),
      `MListElementPropertyToken` (RowId/RowOrder).
- [ ] `ColumnDescriptionFactory` (auto-derive columns from a `withQuery` projection) — today callers
      build ColumnDescriptions / navigate tokens by hand.

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
- [ ] `DynamicQueryContainer` (`DynamicQuery/DynamicQueryContainer.cs`) — real query registration via
      `sb.include(T).withQuery(() => selector)`; replaces the interim `QueryLogic.registerQuery`.
      `GetQueryNames` / `GetEntityImplementations` / `GetTypeQueries`.
- [ ] `ExpressionContainer` (`DynamicQuery/ExpressionContainer.cs`) + `ExtensionToken` — registered
      cross-entity expression sub-tokens (Signum's `QueryLogic.Expressions`). Merge into
      `QueryToken.cachedSubTokensOverride` (the TODO(phase4) hook there).
- [ ] `ColumnDescriptionFactory` (`DynamicQuery/ColumnDescriptionFactory.cs`) + `Meta.cs` — auto-derive
      a query's `ColumnDescription[]` (Type/Implementations/PropertyRoutes/Format/Unit) from a
      `withQuery` projection, replacing hand-built ColumnDescriptions.
- [ ] QueryEntity unique index on `key` + DB generation (deferred with TypeEntity's, no Synchronizer-
      driven unique-index support yet).

## Client / React

- [ ] `Signum/React/QueryToken.ts` + `SearchControl/QueryTokenBuilder.tsx` — the browser-side token
      model + picker. Separate reimplementation in `react/` (as in Signum), out of scope here.

## Never-port (altea doesn't model these)

FullText (`FullTextRankToken`/`PgTsVectorColumnToken`), Vector (`VectorColumnToken`/`VectorDistanceToken`),
`TranslatedToken`, `OperationToken`/`OperationsContainerToken`, `QuickLinksToken`, `ManualToken`,
`StringSnippetToken` — unless/until the corresponding features are added to altea.
