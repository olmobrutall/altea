# Signum.Authorization → @altea/altea-auth

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Authorization/`

The module has two halves. AUTHENTICATION — who is logged in, the token, the user state machine — and
AUTHORIZATION — five dimensions of rules folded over a role graph. The shared BaseAD half (directory
configuration, `ADAuthorizer`, OIDC) lives here too and has its own page:
[AuthDirectory.md](AuthDirectory.md).

> **A note on this page's own history.** Seven comments in this module described the port's PLAN rather
> than its code — "Phase 4", "Phase D", "this first slice", "lands with the enforcement phase". Every one
> of them had been overtaken by the work and every one still read as current. A progress note goes stale
> by being *acted on*, which is the one thing you can rely on happening, so none of them belongs in a
> source file. What each said, and what is actually true, is below.

## Authentication

`AuthLogic` is Signum's AuthLogic.cs. What is worth knowing at the point of edit:

- **`withDisabled(fn)` genuinely suppresses authorization** for its async-propagated scope — the row-read
  filter, the save gate and `isAllowedFor` all short-circuit to "allowed". It is an AsyncLocalStorage, so
  it holds across awaited work inside `fn`, like UserHolder. (Signum's is an `IDisposable Disable()`.)
- **`isEnabled()` folds in the global check** that Signum spells `IsEnabled && !ExecutionMode.InGlobal`.
  That matters: a GlobalLazy factory runs in `ExecutionMode.global`, so its cache-loading queries see auth
  suppressed — which is also what breaks the recursion where the row filter's own rule load would re-enter
  the queryFilter provider.
- **`systemUser()` reads with authorization SUPPRESSED, and that is the whole point.** Signum resolves it
  ONCE at startup into a static field, so it never passes a permission check; altea resolves it per call
  through the ordinary gated retrieve, which meant the CALLER's rights decided whether the system user
  could be found. Under the anonymous role (no rules → None) the read came back empty, so `asSystemUser`
  fell through to its no-op branch and ran the block as ANONYMOUS — silently, which is the dangerous half:
  its callers are precisely the ones that must not be subject to the current caller's rights (the login
  failed-counter writes, an anonymous self-registration). `anonymousUser()` never had the bug only because
  its lazy runs inside `ExecutionMode.global`, where authorization is already suppressed — an asymmetry,
  not a design.
- **`anonymousUserName` is the app's whole unauthenticated posture in one string.** Set, a request
  carrying no token is authenticated AS that user, so it passes the gate on every route and is limited
  only by that user's role rules. Null, such a request has no user and the gate rejects it unless the
  route is `allowAnonymous`. Both names are OPTIONAL here where Signum makes them positional-required, so
  a test starter reads as `AuthLogic.start(sb)`.
- `anonymousUser()` is CACHED because with one configured it is on the path of every anonymous request;
  the lazy is registered on the schema builder rather than created locally, so `resetLazies()` and the
  cache panel see it like any other. It is invalidated by a UserEntity save, where Signum's is
  `WithoutInvalidations` — so renaming or re-roling the anonymous user takes effect without a restart.
- **`UserGraph.OnDeactivated` becomes ONE slot**, `AuthLogic.onRemoveUserTickets`. Signum reaches
  UserTicket two ways from the same graph (the event for `Deactivate`, a direct `RemoveTickets` inside
  `AutoDeactivate`); both say the same thing, so the state machine has one code path and this module needs
  no knowledge of tickets.
- Counter and hash writes use `user.save()` directly, not Signum's `AllowSave` + `Execute(Save)`.
- `retrieveUser` opens with authorization disabled, and that is not optional: a login runs with no user at
  all, so the read that FINDS the user cannot be subject to a role's rules. The scope covers the
  failed-counter writes too.

### The token

`AuthTokenServer` is an OPAQUE bearer token: a JSON payload → AES-CBC (key = MD5 of the encryption key,
random IV prepended) → base64, echoed as `Authorization: Bearer <token>` and refreshed periodically
through a `New_Token` header.

- no Deflate around the JSON (correctness-neutral, dropped for simplicity); the byte format is otherwise
  Signum's.
- the payload is a COMPACT hand-rolled shape — user / role id + toStr + passwordHash + creationDate —
  rather than a full serialized graph: enough to rebuild a UserWithClaims and detect a password change.
- it DOES carry the claims bag, as Signum's `AuthToken.Claims` does. A claim is filled from the full user,
  which only the login and the refresh ever hold, so a claim that did not ride along would exist for one
  request and then vanish.
- the authenticator CHAIN is a seam, so UserTicket and the directory authenticators append to it.

### Secure by default

Two cooperating pieces in `AuthServer`, Signum's `SignumAuthenticationFilter`:

1. a per-request `app.use` middleware opens a UserHolder scope and authenticates through the token
   authenticator chain;
2. an authorization gate installed via `setAuthorizeRequest` runs in every route wrapper AFTER routing and
   DENIES the request unless a user is authenticated or the matched route is declared `allowAnonymous`.

So a route is protected unless it opts out. The opt-outs are the login endpoint, the boot reflection
metadata and client-error reporting. A configured anonymous user counts as authenticated for the gate.

> **Stale note corrected.** This file said the authorization-integration block of Signum's
> `AuthServer.Start` "belongs to Phases 4-5 and is intentionally absent here". `AuthServer.start` calls
> `AuthReflectionServer.install()`; it has not been absent for some time.

## Authorization: the role graph

The inherit/merge DAG every dimension folds rules over. Signum keeps it as three GlobalLazys
(`RolesByLite` / `rolesGraph` / `mergeStrategies`); altea loads ONE immutable snapshot, because they are
always read together and a partial refresh has no meaning.

- **`AuthCache`** caches a role's computed allowed value per (role, resource), as Signum's
  `RoleAllowedCache` does: the role's EXPLICIT rule if any, else the MERGE of its direct parents' values
  per the role's merge strategy, else `getDefault(role)` for a root role with no rule.
- Every cache is ASYNC (`sb.globalLazy` + `computeAllowed`) — there is no preloaded GlobalLazy.
- `rolesByName` is not a separate lazy: the ONE loaded RoleGraph is scanned by name.

## The five dimensions

| Dimension | Value | Shape |
| --- | --- | --- |
| Type | `TypeAllowed` — a packed DB level and UI level, `(DB << 2) \| UI`, six valid combinations | `WithConditions<TypeAllowed>` |
| Property | `PropertyAllowed` (None / Read / Write) | `WithConditions<PropertyAllowed>` |
| Operation | `OperationAllowed` (None / DBOnly / Allow) | `WithConditions<OperationAllowed>` |
| Query | `QueryAllowed` (None / EmbeddedOnly / Allow) | scalar |
| Permission | boolean | scalar |

`WithConditions<A>` is a fallback plus ordered condition rules, and evaluating it against an instance is a
REVERSE scan: the allowed of the LAST condition rule whose symbol set all holds, else the fallback. One
generic implementation serves all three conditioned dimensions; the TypeAllowed DB/UI split is applied by
the caller afterwards.

### Merging across roles is a 2ⁿ truth table

When a role inherits from several roles, their per-resource condition rules are over possibly DIFFERENT
symbol sets, so they cannot be merged rule by rule. Each role's WithConditions is expanded into a 2ⁿ
truth-table over the union of the symbols, merged cell by cell (Union → max, Intersection → min), and a
MINIMAL rule set is reconstructed from the merged matrix. That is Signum's `GetMatrix` / `GetRules` /
`MergeBaseImplementations` exactly.

It is GENERIC over the allowed enum: the only per-dimension inputs are the numeric ordering (higher = more
access) and the `top` value (the Intersection identity and max short-circuit); None is always 0, the Union
identity and min short-circuit. Signum's own `maxTypeAllowed` compares numerically, so one core serves
TypeAllowed's packed value and the single-level enums alike.

**Signum's `TypeAllowedPrima` / `WithPrima` / `IsSimplest` tagging is not ported.** It preserved conditions
that PROPERTY or OPERATION auth might override; altea evaluates that coercion per-instance at the SCALAR
level instead, so full minimization here is correct for every dimension.

### Type conditions compile to SQL, and evaluate in memory, from ONE lambda

A `@quoted` lambda is BOTH a real callable and a carrier of its captured AST, so one registration serves
both paths — which is what Signum's `RegisterCompile` achieves by `.Compile()`ing the expression.

`TypeConditionAlgebra` compiles a role's `WithConditions<TypeAllowed>` for a requested access level into a
boolean node tree (True / False + And / Or / Not / Symbol), simplifies it, and lowers it to an altea
Expression spliced onto every query of that type.

- Signum lowers a SymbolNode with `Expression.Invoke(lambda, entity)`; altea has no Invoke node, so the
  predicate lambda's parameter is SUBSTITUTED with the shared entity parameter and its body spliced
  directly — semantically identical, and it lowers to SQL with no invoke to inline.
- **A SymbolNode with neither a predicate nor an audited verdict is treated as NOT satisfied**, rather
  than crashing the query. A type condition can only ever GRANT access, so denying is the safe reading of
  a registration bug.
- `Register<T>` infers T from the C# expression's type; there is no such inference here, so the entity
  ctor is passed explicitly and is the registry key.
- Signum's thread-local `ReplaceTemporally` (a testing seam) is deferred.

> **Stale note corrected.** TypeAuthLogic said "the compile-to-SQL row filter + save gate are Phase D" and
> TypeConditionLogic said the SQL half was Phase D and that "`_TypeConditions` precompute-on-retrieve
> lands with the enforcement phase; until then `inTypeCondition` REQUIRES an in-memory condition". Both
> shipped: `sb.schema.queryFilterProviders` carries the row filter, and a DB-only condition is folded into
> the retrieval SELECT as an additional binding and cached per entity in a WeakMap that `inTypeCondition`
> reads.

### The query auditor

`registerWhenAlreadyFilteringBy` answers "you may read these rows BECAUSE you asked for them in a way that
already constrains them to something you are allowed to read". Answering it means reading the CALLER'S own
query, which is what `QueryAuditorVisitor` walks.

The walk folds the operator chain outward from the base query, tracking a `param` standing for one row of
the base table, a `projector` saying what one row of the current sequence is over that param, and the
`filters` every `filter(...)` has applied. A `map` rewrites the projector, a `filter` appends its AND-split
predicate, the ordering / paging / distinct operators pass all three through, and anything else DROPS the
projector — after which no further filter is collected, because a predicate over an unknown shape says
nothing about the base row.

- Signum models the intermediate state as a fake Expression node so it flows through ExpressionVisitor
  dispatch; altea folds with a plain recursive function returning a record.
- Signum keys its operator sets on `Queryable` / `Enumerable` method names; altea's operators are METHODS
  on `Query<T>`, so the switch is on the member name. The pass-through set adds altea's own
  projector-preserving operators (`reverse`, `toArray`, `expandLite`, `expandEntity`).
- **The auditor is ASYNC and runs one phase earlier.** In Signum it runs INSIDE the binder, which it can
  because its auth caches are always warm and its DB reads are synchronous; altea has no synchronous DB,
  so an auditor runs in the row-security PROVIDER phase — the one place that has both the query and the
  ability to await. Registration and semantics are unchanged; only *when* moved.
- **One Signum bug is fixed rather than mirrored.** Its equality recogniser tests
  `mce.Arguments[0] is ConstantExpression` twice, so the second branch is unreachable; altea tests the two
  sides, which is what the code plainly means. (`Lite.Is(a, b)` is a static there and a method here, so
  the shape being matched is `<receiver>.is(<arg>)`.)

### Property auth

A property is CAPPED by its type's UI-read allowance — it cannot be more accessible than its type — and
with no explicit rule takes a DEFAULT that is worth stating precisely: a role WITHOUT
`BasicPermission.AutomaticUpgradeOfProperties` defaults to NONE, so properties are hidden unless
explicitly granted; otherwise it follows its type. Signum's per-property `MaxAutomaticUpgrade` cap is not
ported.

A rule POINTS at a `PropertyRouteEntity` row, as in Signum, but the runtime CACHES are keyed by
(rootType id, path) rather than by the row: there is no ambient EntityCache, so two reads of one row are
different objects.

**Enforcement is the serializer's write gate, and it needs a per-request SNAPSHOT.** The codec is
SYNCHRONOUS, so per request it calls `resolveContext` once — async, before the walk — to capture an
immutable `SerializationAuthContext` (the role graph + type rules + property rules, each awaited off a
ResetLazy), and then folds over THAT synchronously. Signum keeps a permanently-warm GlobalLazy; a
per-request snapshot is additionally immune to a concurrent `invalidate()`. None → the value is omitted
server→client and its line hidden; Read → read-only, kept on save; Write → normal.

### Parts inherit their owner's rules

A `@part` is owned by exactly one entity and, for authorization, INHERITS that owner's TypeAllowed and
TypeConditions — so parts carry no rules of their own and never appear in the Type-Auth grid. The owner is
discovered STRUCTURALLY from the schema: any field whose target is a part is an owned-part edge, in three
shapes (an array back-reference, a forward single reference, a forward polymorphic reference).

Ownership CHAINS to the nearest non-part ancestor, which is why manually mirroring a Dashboard's rules
onto each part implementation — Signum's pain point — is not needed. MULTI-OWNER IS FORBIDDEN and throws:
use `@entity("SharedPart")` for real sharing, which is shown in the grid with rules defined by hand.

### The other two

**Query.** The gate is `allowed === Allow || (allowed === EmbeddedOnly && !fullScreen)`. The server
executes with `fullScreen: false`, so it only ever blocks None — the full-screen distinction is a client
concern. `AutomaticUpgradeOfQueries` coercion is deferred (coerced = Allow).

**Operation.** Rules are keyed by a composite `${operationId}/${typeId}`, Signum's (OperationSymbol, Type)
resource flattened. Enforcement is the core `OperationLogic.onAllow` hook: `assertOperationAllowed` throws
at execute time and `getEntityPack` omits UI-denied operations. A Construct — no entity to test conditions
against — evaluates the fallback.

### Permission: DECLARED is not REGISTERED

`PermissionLogic` draws the distinction that decides which rows `basics.permission` holds. A permission is
DECLARED by the module that owns it, which happens as soon as anything imports that module's data layer —
and a static import graph pulls in every module the application *could* use, not the ones it does. It is
REGISTERED by that module's `Logic.start`, which runs only for the modules the application actually
starts.

Signum seeds from the REGISTERED set, so an app that never starts the printing module has no
`PrintPermission.ViewPrintPanel` row — nothing to grant, and a row nobody can act on is a row in every
role-rules screen for no reason. altea used to seed every DECLARED permission, which is why a Signum
database always looked short of a few rows.

The consequence of getting it wrong the OTHER way is worth knowing: a permission whose module starts but
which nobody registers loses its row, and with it any role rule pointing at it. The synchronizer names
such a row in a DELETE, which is the check to run after touching this.

## The rule model

Signum's generic `RuleEntity<R>` abstract base becomes a non-generic `@reflect` abstract base carrying
`role`; each concrete rule adds its own `resource`. Resource references are direct FKs to the seeded
TypeEntity / QueryEntity / PermissionSymbol tables.

`PermissionSymbol` is declared in `Signum/Basics` there, so its table lands in the `basics` schema;
`TypeConditionSymbol` is `Signum.Authorization` and stays in `auth`, as the database has it.

**An operation rule is keyed by (OperationSymbol + Type)** — the same symbol can apply to several types
and a role may allow it for one and deny it for another. Signum makes that pair an EMBEDDED
(`OperationTypeEmbedded Resource`); altea keeps two direct FK fields, which is simpler everywhere the rule
is read and indexed, and `@legacyColumnName` is what makes the COLUMNS Signum's — which is all a database
can see of the difference.

### The rule packs are ModelEntities

Signum ships them as `ModelEntity` graphs opened through Navigator; altea does the same, so a pack rides
`Navigator.view` / FrameModal with no propertyRoute needed. Its generic `BaseRulePack<T>` / `AllowedRule<R,A>`
bases collapse into concrete per-dimension models.

> **Stale note corrected.** Rules.ts said "this first slice covers the condition-free dimensions
> (Permission, Query) + the shared symbols/enums; the Type / Operation rule entities … land with the
> Type-authorization slice, and Property auth waits on a PropertyRouteEntity port". All of it is in that
> file, and PropertyRouteEntity is ported. PermissionAuthLogic likewise said "the rule-pack get/set (admin
> write) + XML surface are Phase 5", which `AuthAdminServer` and `AuthImportExport` are.

## AuthRules XML

One `<Auth>` document: a `<Roles>` section the orchestrator owns plus one section per dimension, each
dimension registering its own block through `AuthLogic.registerXmlExporter` / `registerXmlImporter` —
Signum's `ExportToXml` / `ImportFromXml` multicast events. `AuthRulesXml` holds the mechanical parts (role
grouping, section assembly, the per-type overlay loop, enum parsing) so they are not repeated five times.

Divergences from Signum's exact wire format:

- Operation / Query / Property rows carry an `OnType` attribute, because those rules are keyed by (type, …).
- Property rows use `Resource` = the PropertyString PATH. (The source used to gloss this as "no
  PropertyRouteEntity"; the table is ported and `PropertyAuthLogic` resolves through
  `propertyRouteEntitySync` — the XML simply keys by the path, as Signum's does.)
- Import APPLIES directly, in the caller's transaction, through each dimension's verified `set*RulePack`,
  rather than emitting a review SqlPreCommand. Roles are NOT created — matched by name, rename-aware.

## Reflection

`AuthReflection` is the role-filtering overlay on the metadata blob, installed once at web-host startup
and running inside each request's user scope. Because the blob is ONE TypeMetadata per type, it writes the
role's answers onto the objects that already carry the type's nice names instead of shipping a parallel
side-channel map; the extra fields come from an interface expansion in `data/Rules`, so core never sees
them. The blob `buildMetadata` hands over is a fresh deep copy per request, so mutating it here cannot
leak a role's allowances into the shared per-culture store.
