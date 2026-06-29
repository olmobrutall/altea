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

## Most important differences so far

- TypeScript uses `quote-transformer` expressions instead of
  `System.Linq.Expressions`. This means the binder has to recover some type and
  method information from Altea metadata and from expression annotations.
- `DbExpressionNominator` intentionally inherits from `ExpressionVisitor`, not
  `DbExpressionVisitor`, because its input is always the TypeScript/source
  expression tree. It manually recognizes SQL nodes where needed.
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
- `thenBy` currently uses a queued/revisit pattern to stay close to Signum's
  `QueryBinder` behavior.
- Aggregate terminals currently use `UniqueFunction.Single` at the root, matching
  Signum.
- `skip` is deliberately deferred. Signum rewrites this through row-number /
  overload simplification paths; Altea's `SelectExpression` does not yet have
  the required shape.
- String `contains`, `startsWith`, and `endsWith` bind to `LIKE` for constant
  patterns. General `IN`, array `contains`, and richer method dispatch still
  need more quote/type normalization.
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
| `ExpressionVisitor/DbExpressionNominator.cs` | `altea/logic/linq/dbExpressionNominator.ts` | Partial port; source-expression visitor |
| `ExpressionVisitor/ColumnProjector.cs` | `altea/logic/linq/visitors/ColumnProjector.ts`, `altea/logic/linq/columnProjector.ts`, `altea/logic/linq/ColumnGenerator.ts` | Partial port |
| `ExpressionVisitor/TranslatorBuilder.cs` | `altea/logic/linq/translatorBuilder.ts` | Partial port |
| `ExpressionVisitor/OverloadingSimplifier.cs` | `altea/logic/linq/visitors/ExpressionSimplifier.ts` | Very partial analogue |
| `ExpressionVisitor/AliasGatherer.cs` | none | Not ported |
| `ExpressionVisitor/AliasProjectionReplacer.cs` | none | Not ported |
| `ExpressionVisitor/AliasReplacer.cs` | none | Not ported |
| `ExpressionVisitor/AggregateFinder.cs` | none | Not ported |
| `ExpressionVisitor/AggregateRewriter.cs` | none | Not ported |
| `ExpressionVisitor/ChildProjectionFlattener.cs` | none | Not ported |
| `ExpressionVisitor/ConditionsRewriter.cs` | none | Not ported |
| `ExpressionVisitor/ConditionsRewriterPostgres.cs` | none | Not ported |
| `ExpressionVisitor/DbExpressionComparer.cs` | none | Not ported |
| `ExpressionVisitor/DbQueryUtils.cs` | none | Not ported |
| `ExpressionVisitor/DuplicateHistory.cs` | none | Not ported |
| `ExpressionVisitor/EntityCompleter.cs` | none | Not ported |
| `ExpressionVisitor/GroupEntityCleaner.cs` | none | Not ported |
| `ExpressionVisitor/OrderByRewriter.cs` | none | Not ported |
| `ExpressionVisitor/QueryFilterer.cs` | none | Not ported |
| `ExpressionVisitor/QueryRebinder.cs` | none | Not ported |
| `ExpressionVisitor/RedundantSubqueryRemover.cs` | none | Not ported |
| `ExpressionVisitor/Replacer.cs` | none | Not ported |
| `ExpressionVisitor/ScalarSubqueryRewriter.cs` | none | Not ported |
| `ExpressionVisitor/SmartEqualizer.cs` | none | Not ported |
| `ExpressionVisitor/SubqueryRemover.cs` | none | Not ported |
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
| none | 0 (0) | `binder.test.ts` | 22 (0) |

## Current verification

The offline LINQ tests currently pass with:

```powershell
pnpm --filter @altea/altea-test test
```

At the last run, this executed 22 active tests successfully. Many ported suites
remain DB-gated or individually skipped while the provider catches up.
