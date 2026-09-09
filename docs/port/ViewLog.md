# Signum.ViewLog → @altea/altea-view-log

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.ViewLog/`

| Signum | altea |
| --- | --- |
| `ViewLogEntity.cs` | `data/ViewLog.ts` |
| `ViewLogLogic.cs` | `server/ViewLogLogic.ts` |
| `ViewLogClient.tsx` | `client/ViewLogClient.tsx` |

The module IS one table plus three subscriptions: "the API handed out an entity", "a query ran", and the
two navigations that let any type's search page ask "who looked at this one?".

## The three core seams it forced

All three were added for this module, in the shape `OperationLogic.surroundOperation` established — a
handler returning an AFTER callback, where Signum's event returns an `IDisposable` and the `using` scope
runs the second half.

- **`ExecutionMode.onApiRetrieved` / `apiRetrievedScope`** — Signum's same event, in the same place and for
  the same reason: the DATA layer must not know about HTTP, and other modules report their own "a client
  just looked at this" scopes through it. Opened by `/api/entity/:type/:id` and
  `/api/entityPack/:type/:id`, exactly where Signum's EntityController opens it. It is also how
  altea-dashboard / -user-queries / -chart report their scopes, where Signum has those three modules
  import Signum.ViewLog directly — so an optional module stays optional and nothing happens when no
  observer is installed.
- **`DynamicQueryContainer.queryExecuted`** — Signum's same event minus its `ExecuteType` argument, which
  it only ever used as the logged action name: altea funnels every read through one `executeQueryAsync`
  (the queryValue route builds a QueryRequest too), so there is nothing to discriminate.
- **`Connector.withSqlCapture(sink, fn)`** — an ASYNC-LOCAL SQL sink, because Signum captures the SQL of a
  query by swapping the process-wide `Connector.CurrentLogger` for a StringWriter for its duration. That
  swap is racy on a server running concurrent work: the StringWriter sees every OTHER query's SQL too. The
  sink is additive (`currentLogger` keeps working, so Signum's `DuplicateTextWriter` is unnecessary) and
  the CALLER owns the array, which is what lets the observer log a query that THREW.

## Divergences

- **the row is saved INLINE, awaited**, where Signum fires a detached `Task.Factory.StartNew`. A floating
  promise in Node is an unhandled rejection waiting to happen and races process exit; the write is one
  INSERT in its own transaction and the response has already been sent by the time the after-half runs.
- **everything that touches the database happens in the AFTER half.** The before half runs while the
  observed query is about to execute, and issuing a read there would share its pinned connection
  (node-postgres warns, and a second statement on a busy client is undefined behaviour).
- **`registerExpressions` is per CONCRETE type** — Signum hangs `ViewLogs()` / `ViewLogMyLast()` off
  `Entity` itself, but altea keys an extension token on a constructor and the token walk follows the
  concrete prototype chain (the accommodation altea-alert already makes).
- **`ViewLogMyLast` stays a QUERY** rather than Signum's single-row `FirstOrDefault()`: altea's registered
  expressions are projections and there is no single-entity extension token. It is narrowed to the current
  user, so the sub-token a search page offers reads `LastViewLog.Any.…`.
- **`Duration` is a `@quoted` member plus a registered expression**, as in @altea/altea-rest: a plain
  `number` lowers to `DATEDIFF(millisecond, …)`, the branded `int` the in-memory `duration()` helpers in
  altea-processes / -scheduler / -migrations return does not.
- **`target` is logged as the QUERY entity for a search**, via `QueryLogic.tryGetQueryEntityByKey` — a map
  lookup into the key→QueryEntity cache altea loads at `schema.initialize()`, matching Signum's
  `QueryNameToEntity`. It used to be a `table(QueryEntity)` read, which fired on EVERY observed query (once
  per search) and showed up as an extra round-trip per request in the heavy profiler.
- **no `toString()`**, as in Signum, so the table has no ToStr column: `target` is `@implementedByAll` and
  no query can expand an ANY-entity reference's display string inline, the target table being known only
  per row.
- **`user` and `target` are both non-nullable**, as Signum types them: the logger stands down entirely when
  there is no current user.
- **`@implementedBy(() => [])` on `user`**, widened by the app — core's pattern for a `Lite<IUserEntity>`,
  exactly as `ExceptionEntity.user` does.
- **the client quick link's findability guard is INSIDE `isVisible`**, evaluated per type, where Signum
  guards the whole registration on `Finder.isFindable(ViewLogEntity, false)`. `start` runs before the
  metadata blob has been applied, so asking at registration time would answer for the wrong role — the
  same reason core's operation-log quick link puts its check in `isVisible`.
- **the query's default columns are registered on the client**, which Signum gets from its `WithQuery`
  projection on the server; altea's `withQuery()` is parameterless.

## Not ported

- **`ExceptionLogic.DeleteLogs`** — altea has no log-retention machinery, the note every log-owning module
  carries.
- **`EntityEvents<TypeEntity>.PreDeleteSqlSync`** — no such schema event, so deleting a TypeEntity row does
  not sweep this table's `@implementedByAll` orphans.
- **`registerChangeLogModule`** — altea's change log takes its entries from a per-module `Changelog.ts`
  registered from that module's client `start`; Signum's file here is an empty dictionary.

## Reachability

Of the three "a client looked at this asset" scopes Signum reports, only the DASHBOARD ones are reachable
in altea — `UserQueriesLogic.retrieveUserQuery` / `UserChartLogic.retrieveUserChart` are cache-hit fast
paths nothing routes to, because altea's SPA fetches a user asset through the generic `/api/entity/…`.
Those views are still logged, under `EntitiesController.GetEntity`.

## Resolved

An `@implementedByAll` column stores only (id, typeId), so a query used to hand back a lite with NO display
string — the `target` column of every view-log and operation-log row rendered blank. **Fixed in core**: the
Retriever now resolves it as Signum's `IRetriever.RequestLite` does, one lite PROJECTION per type at the end
of `completeAll`, with the caller's rights.
