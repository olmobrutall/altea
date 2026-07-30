# DynamicQuery port — status

Port of Signum's `Signum/DynamicQuery/**` + `Signum/Basics/QueryLogic.cs`. The server-side query
layer that backs SearchControl: the token tree, the DQueryable/DEnumerable execution pipeline, the
request/result model, and the query registry.

## Architecture (after the query-shape redesign)

- **A query's shape is a reflected `BaseEntity` type** — a full `Entity` (auto queries) or a
  `ModelEntity` (custom projections). There is NO `QueryDescription`/`ColumnDescription`: column
  metadata (types, implementations) comes from reflection on the shape type; derived metadata
  (`IsAllowed`, and later unit/format/niceName) comes from the `MetadataVisitor` (`Meta`).
- **The token tree roots on a single `RootToken`** (key `""`, `tokens/rootToken.ts`) whose type is
  the shape type. Navigations are **rootless** — `"Name"`, `"Customer.Name"` — never `"Entity.Name"`.
  There are no "column" tokens; "computed columns" are registered expressions (`ExtensionToken`).
- **Three query flavors, differing only in execution** (all metadata from reflection):
  1. `WithQuery` (parameterless) → `AutoDynamicQueryCore.fromEntity(T)` = `table(T)`.
  2. Manually-registered `AutoDynamicQueryCore(() => Query<T-or-Model>)` — filter/join/project,
     LINQ-translated. A model projection uses `SomeModel.create({ entity, … })` in a `.map`.
  3. `ManualDynamicQueryCore(rootType, request => ResultTable)` — imperative execution.
- Registered in `DynamicQueryContainer` (lazy buckets) behind `QueryLogic.queries`; expressions in
  `QueryLogic.expressions`. `QueryLogic.getRootToken(queryName)` is the navigation entry point.

## Done

- **Phase 0** — `PropertyRoute` + `Implementations` (`entities/`).
- **QueryUtils** — `FilterType` + `getKey`/`getNiceName` (`queryUtils.ts`).
- **QueryToken base + tokens** (`tokens/`): `RootToken`, `EntityPropertyToken`, `HasValueToken`,
  `EntityToStringToken`, `ObjectPropertyToken` (value member — string.length, date parts, …),
  `AsTypeToken` (polymorphic cast), `DateToken`, `ModuloToken`, `CountToken`,
  `CollectionElementToken` (Element/Element2/Element3), `CollectionAnyAllToken` (Any/All/NotAny/NotAll),
  `CollectionToArrayToken` (SeparatedByComma/NewLine ±Distinct → `string_agg`), `AggregateToken`
  (Count/Sum/Min/Max/Average + Count-where/Count-distinct), `ExtensionToken`.
- **BuildExpression retarget** — tokens hand-build altea `Expression` nodes → `bindAndOptimize`.
  `@implementedByAll` sub-token source wired via `QueryLogic.getImplementedByAllTypes`.
- **DQueryable** (`dQueryable.ts`) — the authoring pipeline (entry: `Query.toDQueryable()`):
  `selectMany` (2-arg `flatMap` + `defaultIfEmpty` → OUTER APPLY, owners kept populated), `where`,
  `orderBy`, `select` (+ the CollectionToArray collect-path), `groupBy` (+ `Dominates`/`getRootKeyTokens`
  redundant-key dedup), `toDEnumerable`, `tryPaginate`/`tryPaginateAsync`, `count`/`countAsync`,
  `allQueryOperations(Async)` (+ `groupResults` WHERE/HAVING split, + `forConcat` to skip pagination).
- **DEnumerable / DEnumerableCount** (`dEnumerable.ts`) — in-memory arm (`where`/`orderBy`/`select`/
  `concat`/`tryPaginate`) via an env-based `evalExpr` (supports `.some`/`.every` closures).
- **ResultTable / ResultColumn / ResultRow** (`resultTable.ts`) — columnar materialisation; the
  entity is split out as the row identity (`token.isEntity()`).
- **Requests** (`requests.ts`) — `Filter`/`FilterCondition`/`FilterGroup` (+ nested any/all),
  `FilterOperation`, `Order`/`OrderType`, `Column`, `Pagination` (All/Firsts/Paginate), `QueryRequest`.
- **Meta / MetadataVisitor** (`meta.ts`, `metadataVisitor.ts`) — provenance (CleanMeta/DirtyMeta) of a
  computed expression; wired into `ExtensionToken` (IsAllowed + getPropertyRoute). `IsAllowed` resolves
  via `PropertyRoute.isAllowedCallback` (unset ⇒ allowed).
- **ExpressionContainer** (`expressionContainer.ts`) + `FluentInclude.withExpressionTo`/
  `withExpressionFrom` (entity-valued, auto niceName from the target type) + low-level `register`.
- **DynamicQueryContainer / DynamicQueryCore** — Auto (Type 1 & 2) + Manual (Type 3); `FluentInclude`
  + parameterless `withQuery()`.
- **RedundantJoinRemover** (`logic/linq/visitors/RedundantJoinRemover.ts`) — merges sibling
  single-row LEFT JOINs to the same table on the same FK (post-pass after RedundantSubqueryRemover).
- **Model projections** — `Ctor.create({ … })` in a `.map` accepts View OR ModelEntity subclasses
  (`isProjectableCtorValue` in expressions.ts + `isViewCtor` in QueryBinder.ts).

## Remaining

Pipeline:
- [ ] `OrderAlsoByKeys` — a stable tie-break key before Skip/Take so pages don't overlap on a
      non-unique order.
- [ ] Full-text filters (`FilterSqlServerFullText` / PG) + `ToTableFilter`; `FilterCondition` covers
      comparison / string / IsIn only.
- [ ] `CollectionNestedToken` / `SelectWithNestedQueries` — nested result sub-tables.
- [ ] Wire `Meta` into custom-projector (Type 2/3) columns; teach `MetadataVisitor` to recognise
      `table(T)` as a `CleanMeta` root (Signum's VisitConstant) so projected columns get provenance.

Leaf tokens (low priority, not blocked):
- [ ] `StepToken` chain (numeric buckets) + `RoundingExpressionGenerator`.
- [ ] `DatePartStartToken` ("Month/Quarter/…Start", "Every N …") — needs SQL date-trunc helpers.
- [ ] TimeSpan/duration parts (wire the `TemporalType("duration")` branch — HasValue only today).
- [ ] `TimeOnlyProperties`; `weekNumber` (binder lacks it); `EntityTypeToken` ("[EntityType]", needs
      TypeEntity-lite plumbing).

QueryLogic registration:
- [ ] `QueryLogic.Start(sb)` — `Include<QueryEntity>().withQuery()`, `QueryNameToEntity`/`liteToEntity`
      caches, seed `QueryEntity` rows + `SynchronizeQueries`, QueryEntity unique index + DB gen.

Client:
- [ ] `Signum/React/QueryToken.ts` + `SearchControl/QueryTokenBuilder.tsx` — the browser token model +
      picker (a separate `react/` reimplementation, as in Signum). Also `QuerySettings.defaultColumns`
      (the default display columns — a client concern; server queries have none, UserQuery uses Replace).

## Never-port (until the corresponding altea feature exists)

FullText (`FullTextRankToken`/`PgTsVectorColumnToken`), Vector (`VectorColumnToken`/
`VectorDistanceToken`), `TranslatedToken`, `OperationToken`/`OperationsContainerToken`,
`QuickLinksToken`, `ManualToken`, `StringSnippetToken`, and `MListElementPropertyToken`
(RowId/RowOrder — altea models MList as part-entities, so it is not needed).
