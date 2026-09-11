# Signum.Playwright → `@altea/altea-playwright`

Signum's test-support assembly for driving its React UI from xUnit, ported to `@playwright/test`. The DOM
contract is identical in both frameworks — every line renders `data-property-path` + `data-changes`, every
frame `data-main-entity` + `data-refresh-count`, every search `data-search-count` — so the selectors and
the waiting strategies carry over unchanged. What changed is the API.

## Nothing is named by string

Signum's proxies take `object queryName`, `string token`, `string operationKey`, and its own suites read
accordingly: `SearchPageAsync(typeof(PersonEntity))`, `AddFilterAsync("Entity.Customer.Name", "Contains",
"Maria")`, `results.EntityClickAsync<PersonEntity>(1)`. C# could not do much better — `QueryTokenString<T>`
exists over there but lives in the React project, and its proxies are non-generic.

altea takes the typed thing everywhere:

| Signum | altea |
| --- | --- |
| `SearchPageAsync(typeof(OrderEntity))` | `searchPage(OrderEntity)` → `SearchPageProxy<OrderEntity>` |
| `FramePageAsync<OrderEntity>(lite)` | `framePage(order)` / `framePage(lite)` / `framePage(OrderEntity, id)` |
| `AddFilterAsync("ShipName", "Contains", "Ernst")` | `addFilterFor(o => o.shipName, FilterOperation.Contains, "Ernst")` |
| `CellTextAsync(0, "TotalPrice")` | `cellText(0, o => o.totalPrice())` |
| `ExecuteAsync(OrderOperation.Save)` (untyped symbol) | `execute(OrderOperation.Save)` — `ExecuteSymbol<T>` of THIS frame's entity |
| `EntityClickAsync<OrderEntity>(0)` | `entityClickModal(0)` — the type comes from the query |
| `data-entity` as `"Order;3"` | `liteAt(0)` → `Lite<OrderEntity>` |
| enum value as its member name | the enum VALUE (`OrderState.Ordered`), converted through the route's enum |

A column that is not a property (the `Entity` column, an aggregate, a cast) is a `QueryTokenString`, which
is the same builder the application's own `Type.token(…)` uses — so a test and the client produce the same
string, and a renamed property breaks the build rather than the run.

**This forced a core move**: `QueryTokenString` (and the unparsed `FilterOption` / `OrderOption` /
`ColumnOption` DTOs its builder methods produce) moved from `client/` to `data/dynamicQuery/`. Naming a
column is not a UI concern — the server executes stored user queries, and a node-side test cannot import
React. `client/QueryTokenString.ts` re-exports it, so no call site changed.

## Scoping: `Task<T>.Then` → a thenable

Signum's central idiom is closure-oriented, and `Then` disposes the proxy in a `finally`:

```csharp
await b.SearchPageAsync(typeof(PersonEntity)).Then(async persons => {
    await persons.Results.EntityClickAsync<PersonEntity>(1).Then(async john => { … });
});
```

Every navigation here returns a `Scope<T>` — a `PromiseLike` carrying `.scoped(body)` — so the same shape
reads the same, with no intermediate `await`:

```ts
await b.searchPage(PersonEntity).scoped(async persons => {
    await persons.results.entityClickModal(1).scoped(async john => { … });
});
```

`await using` works too (every scoped proxy implements `Symbol.asyncDispose`), and the free
`scoped(source, body)` is still there — it is what `Scope.scoped` calls.

## The test environment: snapshot / template database

Signum's `SouthwindTestClass` restores the database before EVERY test
(`Administrator.RestoreSnapshotOrDatabase()`) and then POSTs `api/cache/invalidateAll` so the running
server drops what it cached. That machinery is `Administrator` in Signum's engine, and it is ported into
altea core the same way (`altea/server/Administrator.ts`):

- `withSnapshotOrTemplateDatabase()` wraps a full generation. SQL Server takes a `CREATE DATABASE …
  AS SNAPSHOT OF` on the way out; PostgreSQL has no snapshots, so the generation is redirected into
  `<db>_Template` and the real database is created `WITH TEMPLATE` on the way out.
- `restoreSnapshotOrDatabase()` rewinds to it: `RESTORE … FROM DATABASE_SNAPSHOT` / `DROP DATABASE` +
  `CREATE DATABASE … WITH TEMPLATE` (after `pg_terminate_backend`, since Postgres refuses either statement
  while a connection is open — including the application server's pool, which reconnects).

Two altea-side additions this needed: `Connector.databaseName()` and `Connector.withDatabase(name, fn)`
(Signum's `ChangeConnectionStringDatabase`), because a database cannot be dropped from inside itself.

The cache invalidation differs. Signum posts to `api/cache/invalidateAll`, its ANONYMOUS broadcast-peer
endpoint authenticated by a shared-secret hash. An altea application whose broadcast is PostgreSQL
LISTEN/NOTIFY has no such peer endpoint, so the application-side helper uses the one a human would:
`POST /api/cache/clear`, gated by `CachePermission.InvalidateCache` (see eastwind's `test/appStack.ts`).

## Not ported

- `SignumPlaywrightTestClass`'s CDP debug mode (launch Chrome with a user-data-dir, connect over the
  debugging port, keep it open on failure). `@playwright/test` ships `--headed`, `--debug` and UI mode,
  which is what that machinery re-created for xUnit.
- `HtmlLineProxy`, `GuidBoxLineProxy`, `EntityListProxy` (altea has no EntityList line),
  `EnumCheckBoxListProxy`, `MultiValueLineProxy`.
- The panel proxies: `ToolbarSidebarProxy`, `SearchValueLineProxy`, `ColumnEditorProxy`,
  `ContextMenuProxy` — the underlying selectors are the same, so each is a small addition when a test
  needs one.
- `Signum.Playwright.Workflow` (the `CaseFrame` page / modal proxies).
