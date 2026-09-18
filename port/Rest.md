# Signum.Rest → @altea/altea-rest

Port ledger: what the C# original does, what altea does instead, and why. Nothing here is needed to *read*
the altea code — it is needed to re-apply a future Signum change, or to line a database up with a Signum
deployment. Rules that bind at the point of edit stay in the source.

Source: `old/Framework/Extensions/Signum.Rest/`

| Signum | altea |
| --- | --- |
| `RestApiKeyEntity.cs`, `RestLog.cs` | `data/Rest.ts` |
| `RestLogFilter.cs` | `server/RestLogFilter.ts` |
| `RestLogLogic.cs` | `server/RestLogLogic.ts` |
| `RestLogController.cs` | `server/RestLogServer.ts` |
| `RestApiKeyLogic.cs` | `server/RestApiKeyLogic.ts` |
| `RestApiKeyServer.cs` + `RestApiKeyController.cs` | `server/RestApiKeyServer.ts` |
| `RestApiKeyClient.tsx`, `RestClient.tsx`, `Templates/*` | `client/*` |
| `RestLogLogic.Start` + `RestApiKeyLogic.Start` (two calls) | `server/RestModuleLogic.ts` (one `start`) |

The module is two halves — an API KEY that authenticates a machine caller, and a replayable LOG of every
request that reached the app's public REST surface. Only the second reshapes.

## The structural divergence: an MVC action filter becomes Express middleware

Signum's `RestLogFilter` is an `ActionFilterAttribute` decorating a CONTROLLER class, so its scope is
"every action of that controller" and it learns the controller type and action name from the filter
context. altea's server is Express behind a typed route wrapper (`WebBuilder`), which has neither
controllers nor action filters — so the same thing is EXPRESS MIDDLEWARE the app mounts on the path prefix
its public API lives under:

```ts
ws.app.use("/api/catalog", RestLogFilter.middleware({ name: "CatalogAPI", allowReplay: true }));
```

A path prefix is what "this controller" means once controllers are gone, and it composes the same way: one
mount per logged API, each with its own options.

Consequences:

- **the RESPONSE body is captured by wrapping `res.write` / `res.end`**, where Signum swaps `Response.Body`
  for a MemoryStream and copies it back. Same idea, and the same caveat: a streamed or binary response is
  buffered in memory, which is why `ignoreResponseBody` exists.
- **the row is written from the `finish`/`close` event**, which is what makes a request that THREW get
  logged too — Signum's second save path (`OnActionExecutionAsync`'s exception branch).
- **the REQUEST body needs no `EnableBuffering`.** altea's route wrapper installs a `rawBody` middleware
  that leaves the whole body on `req.body` as a STRING, so it is simply read — Signum has to rewind the
  stream and be careful not to close it.
- **`controller` / `controllerName` / `action`** follow altea's own established mapping for "which endpoint
  was this", the one `exceptionFilter.fillContext` already uses, since altea has no MVC controller/action
  pair to read: `controller` is the matched route path, `action` is the HTTP method. `controllerName`
  carries the `name` the caller passed, which is the closest thing to Signum's short controller name and is
  what the log's search page groups by.
- **it must be mounted AFTER `AuthLogic.start`**: that is what installs the per-request user scope, and
  `UserHolder.current()` is read here. Express runs middleware in registration order.
- the log row is saved in `ExecutionMode.global` (Signum does the same) and in its OWN transaction, so
  logging a request can neither be blocked by the caller's rules nor roll back with the request it
  describes.

## An `?apiKey=` is REDACTED in the logged query string

Signum stores the query string verbatim. A key is a long-lived credential and this table is readable by
anyone who can read RestLog, so logging it in the clear would turn a request log into a credential store.
Nothing needs the logged value: the replay resolves the key from the log's USER, and the url the replay
sends has `apiKey=` stripped anyway — the key rides as the `X-ApiKey` HEADER instead, which is the same
surgery Signum does by hand in its replay.

## The entities

- **`MList<QueryStringValueEmbedded>` → `@part` rows.** Signum marks the collection `[PreserveOrder]`,
  which is exactly a `@rowOrder` child table here. The type keeps Signum's NAME, "Embedded" suffix
  included, as altea-tour's `CssStepEntity` and the AD configurations do.
- **`RestLogEntity.user` is `@implementedBy(() => [])`.** Signum declares `Lite<IUserEntity>?`; as with
  `ExceptionEntity.user`, `IUserEntity` is an INTERFACE with no runtime constructor, so the implementations
  are declared empty and the app widens them —
  `overrideImplementedBy(RestLogEntity, r => r.user, () => [UserEntity])` in its EntityOverrides. This
  module does depend on altea-auth (Signum.Rest depends on Signum.Authorization too), but the LOG's user is
  the framework's `IUserEntity` slot, so it follows core's pattern rather than hard-wiring a concrete type
  into the column.
- **`Duration` is a `@quoted` member plus a registered expression.** Signum declares it
  `[Unit("ms"), ExpressionField]` over `(EndDate - StartDate).TotalMilliseconds`. Here it is
  `durationMilliseconds()`, `@quoted` so it IS an orderable query column — unlike the in-memory
  `duration()` helpers in @altea/altea-processes / -scheduler / -migrations, which return the branded
  `int` the transformer cannot emit a runtime type reference for. A plain `number` lowers to
  `DATEDIFF(millisecond, start, end)` through `since().total()`. `@legacyPropertyRoute("Duration")` keeps
  the Signum property name for a legacy database.
- **`toString()` is kept where Signum has none.** Signum's `RestLogEntity` does not override `ToString` at
  all, so its table has no ToStr column. altea keeps the more useful `"METHOD url"` display and marks it
  `@quoted` instead of dropping it: both columns are on this same row, so the query provider expands the
  string inline and materialises nothing.
- **`ReplayState` / `ChangedPercentage` are declared but never assigned**, exactly as in Signum: the replay
  UI diffs the two response bodies in the browser and stores nothing. They are kept because the search page
  offers them as columns, and because a host that wants to record a replay outcome has somewhere to put it.
- `RestApiKeyEntity.apiKey`'s `min: 20` is Signum's.

## The API key

- **the cache is ASYNC.** `sb.globalLazy` returns a `ResetLazy<T>` holding the resolved value (altea has no
  synchronous DB access), so the authenticator awaits it. That is fine: the authenticator chain is already
  async. Signum's `FrozenDictionary` becomes a plain Map — nothing here mutates it.
- **`WebEncoders.Base64UrlEncode` → `randomBytes(32).toString("base64url")`**, the same 32 random bytes in
  the same alphabet, so a key generated by either framework is indistinguishable.
- **the authenticator is ASYNC and reads the key through `AuthRequestLike.query`**, a member added to
  altea-auth for this: the chain previously only needed `hasQuery` (the token authenticator asks whether
  `?refreshToken` is present), never a query VALUE. It matters that it returns every occurrence, because
  Signum REFUSES a request carrying more than one key rather than picking one — a request with two keys is
  ambiguous about who it acts as.
- **`AuthLogic.Disable()` → `ExecutionMode.global()`**: resolving the key's user must not itself be subject
  to the type/row rules of a user who is not authenticated yet.
- **`/api/auth/loginFromApiKey` lives in THIS module**, not in altea-auth. Signum puts it on its
  AuthController because that is where `AuthTokenServer.CreateToken` is; altea-auth exports `createToken`,
  so the route can live with the module that owns the concept and altea-auth needs no knowledge of API keys.
- `AppDomain.CurrentDomain.FriendlyName` has no Node counterpart, hence the `ALTEA_APPLICATION_NAME`
  environment variable behind `RestLogLogic.applicationName`.

## Routes and client

- **the replay's id is a path segment.** The url is a QUERY parameter here as it is in Signum, but the id
  is the route's own path segment (`/api/restLog/:id`) rather than a second query parameter — that is the
  shape every other altea entity-addressed route uses, and it makes the id typed by the router.
- **`HttpClient` → `fetch`.** A logged GET is replayed as a GET; a logged request that had a body is
  replayed as a POST of that body, which is Signum's own branch — a request whose body matters is a POST in
  practice.
- **the "how long ago" unit is dropped.** Signum decorates `startDate` with luxon's `toRelative()`; altea's
  dates are `Temporal` and core has no relative formatter, so the absolute value stands alone.
- **no `modified = true`** in the key editor: dirtiness is snapshot-based in altea, so writing the field IS
  what makes the entity dirty. Signum's flag has no counterpart.
- **one `start` per module.** Southwind calls `RestLogLogic.Start(sb)` and `RestApiKeyLogic.Start(sb)` as
  two lines; altea packages expose one `start` (the shape `TreeModuleLogic` / `HelpModuleLogic` use), so an
  app writes one line and cannot half-install the module.

## Not ported

- **Swagger / `[IncludeInDocumentation]`** — altea's `httpMeta` carries OpenAPI hints but no generator is
  wired.

## What this port needed from core

- `AuthRequestLike` gained **`query(name)`**: the authenticator chain only ever needed `hasQuery` before,
  and an authenticator that authenticates ON a query parameter must see every occurrence.
- **`Duration.total({ unit })` did not translate to SQL** — only the bare-string `total("ms")` form did, so
  the object form every duration helper in the workspace is written in failed at query time. Fixed in core.
