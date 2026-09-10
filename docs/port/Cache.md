# Signum.Caching → @altea/altea-cache

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Caching/`

`sb.include(X).withCache()` keeps X's table in memory as raw column TUPLES plus a "completer" that fills a
FRESH instance per read. Storing tuples rather than entities is the whole design: what a caller gets can be
mutated and saved without ever corrupting the cache.

## The two roles a type can take

Signum's `CacheType`:

- **CACHED** — an `EntityData.Master` type: the whole table is held, and every retrieve is served from it.
- **SEMI** — an `EntityData.Transactional` type REFERENCED by a cached one: far too volatile to hold, but
  the referencing row still has to produce a `Lite<T>` display string, so only the referenced LITES are
  cached. A semi type is never served from the cache for its own retrieves.

Caching a type therefore pulls its whole dependency closure into one of the two roles, which is why
`cacheTable` recurses (Signum's `TryCacheSubTables`).

**The walk STOPS at a semi type**, where Signum recurses. That is not a shortcut, it is the containment
guard: following a semi type's own references is how caching one Master type ends up with most of the
database in memory. altea can stop because a full-entity reference on a cached row is left a Retriever stub
and completed from the database.

## The completer is CLOSURES, not codegen

Signum compiles it as a LINQ Expression tree; altea builds the equivalent tree of closures — same structure,
one node per Field, recursing through embeddeds and mixins, with no code generation.

## No CachedTableMList

altea has no MList table: a collection is `@part` child rows in the child's OWN table with a back-reference
FK — i.e. always Signum's *VirtualMList* shape. So a collection is served by the CHILD type's cached table
through a back-reference index (Signum's `GetBackReferenceDictionary` / `RequestByBackReference`), and
`CachedTableMList` has no counterpart at all.

A cached type's own lite is "materialise the row, then `toLite()`" — altea has no lite-model entity.

## The semi-cached lite table is TRIMMED, by a different route

Signum's `ToStringColumnsFinderVisitor` walks the lite MODEL expression for the columns it needs, and
`LiteModelExpressionVisitor` rewrites that expression to read the cached tuple.

altea's equivalent of a lite model is a CUSTOM LITE, whose `fromEntity` is a `Quoted` lambda — a real JS
function that also carries its expression tree. So `LiteColumnsFinder` walks the tree for the column SET,
and at read time the function itself is applied to a PARTIAL entity carrying exactly those columns. Same
guarantee — only the display columns, of only the referenced rows — with no expression rewriting, and the
lite comes out of the same code a query would run.

The side table is an INNER JOIN back to the owner, so it holds only rows some cached row points at.

Why it matters, and it is the whole point of the semi role: a cached `Country` may reference
`Lite<Person>`, and Person is Transactional. Caching the whole Person row would drag in whatever Person
references, and so on transitively.

## SqlDependency is not portable, so `withSqlDependency` is GONE rather than optional

SQL Server query notifications need Service Broker support in the client driver, and Node's (tedious) has
none. Invalidation is always "local save/DML events + an optional broadcast", which is exactly Signum's
own non-SqlDependency configuration. A cached table is therefore never invalidated by the database itself.

`IServerBroadcast` is the transport: one method name, one string argument, deliberately tiny — the payload
is only ever "this table changed" / "everything changed". Signum's `event Action<string, string>? Receive`
becomes a handler ARRAY, and `send` is async-tolerant, because a Node transport writes to a socket.

Two implementations, matching Signum's usable set:

- **`PostgresBroadcast`** (LISTEN/NOTIFY). The payload is `<method>/<pid>/<argument>`, and a message whose
  pid is OUR pid is ignored — that is how a process avoids acting on its own invalidations. Signum
  dedicates a THREAD blocking in `conn.Wait()`; node-postgres raises a `notification` event on its own
  socket, so there is no loop and no thread — just a dedicated `Client` (never a pooled one: a LISTENing
  connection is not returned to the pool) with `unref()`ed sockets, so it cannot hold the process open.
  The payload is sent as a PARAMETER through `pg_notify(...)` rather than interpolated into a `NOTIFY`
  statement — Signum builds that SQL by hand, which breaks on a clean type name containing a quote and is
  a needless injection surface. Signum's channel is misspelled `signum_brodcast`; altea uses
  `altea_broadcast`.
- **`SimpleHttpBroadcast`** — POST to the siblings' own `/api/cache/invalidate*` endpoints. This is what a
  SQL Server app uses; every node just needs the others' URLs. The endpoints are ANONYMOUS (the caller is a
  sibling process, not a user), so each request carries a hash of a shared secret and a mismatch is
  refused. Signum skips its own message by comparing machine name + application name; altea sends a
  per-PROCESS id, which is strictly more precise — two processes of the same app on one machine are told
  apart, so a node may safely list its own URL. `HttpClient` becomes `fetch`, fire-and-forget with a short
  timeout: invalidation is best-effort and must never slow down, or fail, the write that triggered it.

## Refused at startup rather than silently mis-served

- a cached type with **row-level TypeConditions** — altea enforces those as a query FILTER, which a cached
  read bypasses;
- a cached type with **`additionalBindings`**.

And `sb.globalLazy(…, { invalidateWith: [X] })` does NOT start caching X, where Signum force-caches it; the
lazy keeps its event wiring and is also reset by a broadcast.

## Smaller divergences

- `Schema.InvalidateMetadata()` has no analogue: the reflection metadata blob is assembled per request, so
  there is nothing to invalidate.
- `ExecutionMode.IsCacheDisabled` is not ported — `CacheLogic.globallyDisabled` plus the per-transaction
  disable cover every caller altea has.
- the panel's DTOs live in the DATA layer (`data/CacheState.ts`), shared by the server builder and the
  React page instead of declared twice — the convention altea-omnibox uses for its result DTOs.
- the statistics page uses a plain `<table>` (there is no AccessibleTable component yet), and has no
  "Invalidation exceptions" tab: that tab searches ExceptionEntity by `controllerName`, which altea's
  broadcast transports do not write — a failed broadcast is swallowed by design.
- the Signum.Map colour provider is not registered (altea-map has no cache provider).

**One Signum bug is fixed rather than mirrored.** It gates the "!ViewCache" omnibox entry on
`CachePermission.InvalidateCache`, but the page it opens needs `ViewCache` — every route it calls asserts
that one, and only `clear` asserts InvalidateCache. So Signum's condition hides the entry from someone
allowed to open the panel and offers it to someone who may not. Gated on `ViewCache` here.

## The test domain

`test/data/shop.ts` exists to exercise one thing per entity, which is worth knowing before changing it:

| | |
| --- | --- |
| `CountryEntity` | Master, CACHED — value columns of every materialisation shape (int / Decimal / PlainDate / enum / embedded), plus one reference of each kind below |
| `CountryEntity_Region` | a `@part` collection with `@rowOrder`, served from the CHILD's own cached table through its back-reference index |
| `CurrencyEntity` | Master, CACHED, `toString()` HAND-WRITTEN — so the table has a ToStr column and its lite must still come out right |
| `EmployeeEntity` | Transactional ⇒ SEMI, referenced as `Lite<EmployeeEntity>` with a CUSTOM LITE over (name, email). The cache must hold ONLY those columns, for ONLY the referenced rows — never `secretNotes` or `department` |
| `OrderEntity` | Transactional ⇒ SEMI with a hand-written toString: the trimmed table holds the ToStr column and nothing else |
| `DepartmentEntity` | Master, referenced ONLY by the semi-cached Employee. It must NOT be cached — that is the transitive-containment guard |

`test/server/liteColumns.test.ts` runs the column planner with NO DATABASE: `include` + `complete` need no
connector, so the Tables (and therefore the columns) are available offline.
