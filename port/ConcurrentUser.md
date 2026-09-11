# Signum.ConcurrentUser → @altea/altea-concurrent-user

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.ConcurrentUser/`

Live presence on an open entity: who else has it open, whether they are typing, and whether the copy on
screen is already stale. Every open entity is a GROUP named by its lite key; a tab joins on mount and
leaves on unmount, and presence rows make the membership queryable. Two pushes go the other way —
`ConcurrentUsersChanged` (someone joined / left / started typing) and `EntitySaved` (the row's `ticks`
moved, so your copy is stale).

## SignalR → altea's WebSocket hub

Node has no SignalR server, so core grew `altea/server/webSocketHub.ts` + `altea/client/useWebSocket.tsx`
(see [the hub's own notes](../../altea/server/webSocketHub.ts)); this module is its first consumer.

- `Clients.Group(k).Method(...)` → `hub.sendToGroup(k, "Method", ...)`; `Context.ConnectionId` → `conn.id`;
  the three `useSignalR*` hooks → the three `useWebSocket*` hooks; `HubConnectionState.Connected` → the
  string state `"Connected"`.
- **`IHubFilter` (LogHubExceptionFilter.cs) becomes `hub.onError`** — one hook instead of a filter class,
  since every throw already funnels through the hub. The write needs its own transaction (a failed hub
  method may have rolled its own back) — the lesson from the scheduler port.
- **hub methods carry NO ambient transaction or user** (a WebSocket frame is not an HTTP request), so each
  opens its own `Transaction.forceNew` and runs under `ExecutionMode.global` (altea's `AuthLogic.Disable()`).
- **the user is the CONNECTION's, not the `userKey` the client passes.** Signum trusts that argument; here
  the socket is authenticated so the server can do better, and a tab can no longer register presence as
  somebody else. The parameter is still accepted, and ignored.
- **a browser WebSocket cannot send `Authorization`**, so the token rides the FIRST FRAME and is validated
  through the same authenticator chain an HTTP request uses. A WebSocket upgrade carries no query string
  here, so no authenticator in the chain can authenticate on a query parameter over this transport.
- `window.__disableSignalR` → `window.__disableWebSockets` — same escape hatch, renamed with the transport.
- the `#if DEBUG` w3wp check that sets `DisableSignalR` (IIS's connection limit on Windows client OS) is
  NOT ported: it diagnoses a Windows-only hosting quirk of a server altea does not run on. The client-side
  escape hatch it fed is kept, so a host can still set it.

## Divergences

- **`SignalRConnectionID` → `connectionID`**, because altea has no SignalR and naming a field after a
  transport it does not use would be actively misleading (the client DTO already said `connectionID`). The
  COLUMN stays Signum's through `@legacyColumnName`: a database cannot see the difference, and a Signum
  database must not be asked to rename a column over a naming preference.
- **`Lite<UserEntity>` directly**, rather than core's `@implementedBy(() => [])` + app override: this module
  already references altea-auth, exactly as Signum.ConcurrentUser references Signum.Authorization.
- **`GraphExplorer.hasChangesNoClean(entity)` → `entity.isDirty()`.** altea tracks modification against a
  SNAPSHOT rather than per-field `modified` flags, so "has unsaved changes" is a method on the entity and no
  graph walk (nor Signum's clean/no-clean distinction) exists.
- **`isModified` is set EXPLICITLY, not by a field initializer**: a non-nullable field must be SET by
  whoever creates the row (altea's implicit NotNull validator rejects `undefined`), where C#'s `bool` gives
  Signum this `false` for free. The repo's convention keeps zero-value initializers off the entity.
- **`startTime` crosses the wire as an ISO STRING**, matching Signum's own generated client DTO. A DTO
  crosses as an untyped `CustomType`, so the serializer has no field metadata to revive a Temporal from;
  typing it as one would hand the widget a string that fails only later, when the widget calls a Temporal
  method on it.
- **`toRelative` measures against `Clock.now`, NOT `Temporal.Now`.** `startTime` is a wall clock with no
  zone, written server-side by `Clock.now`, whose `TimeZoneMode` defaults to UTC. Comparing it against the
  BROWSER's local wall clock offsets every duration by the browser's UTC offset — which read as "2 hours
  ago" for a row created seconds earlier. `Clock` is isomorphic, so reading it on both sides keeps them in
  the same frame whichever mode the app picks. (luxon's `DateTime.fromISO(x).toRelative()` →
  `Intl.RelativeTimeFormat` over a Temporal difference.)
- `EntityKindCache.GetEntityKind(t)` → `tryGetTypeInfo(t).entityKind`, and `getTypeInfo(e.Type)` →
  `tryGetTypeInfo(e.constructor)` — altea has no `.Type` string discriminator; the constructor IS the type.
  Same default predicate, and it must stay in sync with `ConcurrentUserLogic.watchSaveFor`, exactly as
  Signum's comment warns.
- `UserEntity.niceCount(n)` is not an altea API: the count is rendered with the plural nice name.
- **`EntityEvents<TypeEntity>.PreDeleteSqlSync` is NOT registered here.** altea derives one for the WHOLE
  schema from the `@implementedByAll` discriminator columns, so no module has to name its own field — see
  `TypeLogic.deleteImplementedByAllRowsOfType`.
- `OperationLogic.AllowSave<ConcurrentUserEntity>()` has no counterpart: altea does not enforce "requires a
  save operation" yet, so a direct `.save()` is already allowed.
- `ChangeLogClient.registerChangeLogModule` is not ported.
- the commented-out `console.log` / `useUpdatedRef` scaffolding Signum left in place is dropped.

## Kept from Signum

- the **1s heartbeat** pushes only a CHANGE of the modified flag, so an idle tab is silent.
- **`NotifyEntitySavedOnCommit`**: accumulate in the transaction's user data and push ONCE, after the real
  commit — pushing inside the transaction would tell every open tab to reload a version a rollback then
  un-does. Registered ONCE per transaction; Signum re-subscribes a static handler and relies on delegate
  identity to dedupe, and a closure has no such identity, so the guard is a first-time branch.
- a **set-based delete** never materialises its rows, so the keys are read first; `ticks: null` is the
  "gone" marker, and the client's stale check fires on any change.
- **`OnDisconnectedAsync`**: a closed tab leaves its rows behind, so drop them all and tell the groups they
  were in. The hub has already emptied `conn.groups` by then, so the notification targets are read from the
  DELETED rows, exactly as Signum does.
- **`CleanConcurrentUsersIfNeeded`** — a 1-in-100 sweep of rows older than a day.
- presence is read with authorization off: presence is not the entity, and a user who can see the page must
  be able to see who else is on it.
