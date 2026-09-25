# altea — AI agent instructions

**Type:** altea application framework — a TypeScript ORM + LINQ provider + dynamic-query engine with a
React UI kit, modelled on Signum Framework.
**UI:** React (TypeScript SPA), Bootstrap + react-bootstrap + Font Awesome.

## General guidance

- Follow altea's conventions for entities, queries, operations and React components — they are below.
- Comment density: enough to bind at the point of edit, no more. The test is *"would this still be true
  and useful if the Signum sources were deleted?"* — yes, keep it inline in one to three lines; no, it is
  port narrative and belongs in [`port/`](port/README.md).
- Respect the existing folder and module structure: code is organized by feature/module, not by technical
  concern. `altea/` holds ~50 reusable vertical modules, each with data / client / server halves.
- Messages shown to a user MUST be localized — a `msg(...)` entry in the module's message container, with
  the translations in that package's own `translations/*.xml`.

**The reasoning behind every rule here — what Signum does, what altea does instead, and the migration each
change needs — is [`port/port.md`](port/port.md).** Read it when a rule looks arbitrary, or before
re-applying a Signum change. Per-module ledgers are the sibling files in that directory.

**Porting an EXISTING Signum application onto altea is [`AlteaPortLegacy.md`](AlteaPortLegacy.md)** — the
C# → TypeScript translation table (MList, Graph, LINQ, LiteModel, `@quoted`), what parity means, and the
`@legacy*` names that keep the ported application running against the database the Signum one left.

## Layers

Every package is organized into three layers, and the boundary is enforced by the tsconfig presets in
`altea/presets/{base,data,client,server}.json`:

| Layer | Holds | May reference |
| --- | --- | --- |
| `data` | the shared, isomorphic data model: entities, enums, symbols, reflection, property routes, query tokens, decorators | nothing but `data` |
| `client` | the React UI: Navigator, Finder, SearchControl, Lines, Operations, Frames | `data` |
| `server` | the engine: connection, linq, schema, sync, dynamicQuery, logic | `data` |

**Two organisations, both accepted.** A layer is either a `data/` / `client/` / `server/` **directory** or a
co-located `*.data.ts` / `*.client.ts[x]` / `*.server.ts` **suffix** (a `.tsx` is always client). Use the
suffixes for a simple module where co-locating a domain matters more than separating it; use directories
once a module carries substantial UI or server code, as every framework package does. Pick ONE —
`server/EmailLogic.ts`, never `server/EmailLogic.server.ts`, which states it twice.

`base.json` is what a project that is NOT one of the three layers extends directly (an app's terminal,
`altea-playwright`). A package's `test/` is its own fourth layer (`tsconfig.test.json`), excluded from the
three shipping presets, and the one place that gets both node types and the DOM lib.

## The entity model

- **Entities are plain field bags.** No property getters, no setters. `@reflect` + `@entity(kind, data)` on
  the class; fields carry decorators (`@uniqueIndex`, `@column`, `@implementedBy`, `@notNullValidator`, …).
- **`@part` is a DECORATOR, and a part is a CONTINUATION of its owner, never a root.** A part is reached
  and saved through the entity that OWNS it, so its EntityData is the owner's and it may not root a
  `PropertyRoute`. `@entity("SharedPart")` is the exception: several owners, so it stands alone.
- **MLists are gone.** A collection is a plain `T[]` of `@part` row entities (or scalars on a row's
  `@valueField`). `@id` / `@order` / `@backReference` are markers, not columns; the save cascade fills the
  back reference and the row order from the array position, so do not set them yourself.
- **Do NOT initialize a field to its type's default.** `strictPropertyInitialization` is off, so a field
  needs no initializer. Write `order: int;`, `token: QueryTokenEmbedded | null;`, `parts: X[];`. Keep only
  initializers that carry a real business value (`port = 25`, `creationDate = Clock.now`).
- **Enums** are a numeric `X` object plus `type XKeys = keyof typeof X`. The runtime/wire value is the
  **string member name**, so compare with bare literals (`"Shipped"`), not `X.Shipped`. The enum takes the
  clean name; the union carries the suffix.
- **`@field` typeNames are capitalized**: `String` / `Number` / `Decimal` / `Boolean` / `PlainDate` /
  `Guid` / `Duration` / `Blob`.
- **Dates are `Temporal`** — `PlainDate` / `PlainDateTime` / `PlainTime` / `Duration`. Temporal has no
  relational operators, so a comparison inside a query is written
  `Temporal.PlainDateTime.compare(a, b) < 0`, which is the form the provider translates. A stored
  `PlainDateTime` is in `Clock.mode`'s frame (UTC by default, `timestamptz` on Postgres); anything a user
  SEES or TYPES crosses `Clock.toUserInterface` / `fromUserInterface`.
- **`Type<T>` is the one entity-type handle, and it is a constructor** — abstract-tolerant, so an abstract
  base is a valid handle. `TypeReference` is the one value-type descriptor (`.typeName`, `.array`, `.lite`,
  `.kind`, `.getEnum()`, `.typeInfos()`).
- **Prefer `getType()` / `Type<T>` over `.constructor` / `Function`.** `entity.getType()` is typed
  `Type<this>` (and translatable in a query); `.constructor` is a bare `Function` that needs a cast. Take a
  `Type<T>` parameter, not a `Function`.
- **Prefer `lite.retrieve()` over `retrieve(lite.entityType, lite.id)`.**
- **Prefer `SomeEntity.create({ … })` over `new SomeEntity()` + field assignments.** `create` also seeds
  the mixin defaults, which `new` skips.
- **No compat accessors.** `lite.entityType` (a ctor, not a string), `entity.isDirty()` (snapshot-based).
- **Model rules are decorators**: `@bindParent` (the owner, in a WeakMap, verified on read), `@isReadOnly`
  (field or class; `undefined` means "no opinion"), `@validate` plus the validators in `data/validators`.
  They run on BOTH tiers, so a rule holds for an entity the client just constructed.

## Queries

- **`@quoted` marks a method whose body is an expression TREE.** The `quote-transformer` (a ts-patch
  transformer) rewrites it at build time, which is what lets a lambda navigation lower to SQL. A nav off a
  **nullable** reference uses `singleOrNull` / `firstOrNull` (OUTER APPLY), not `single` / `first`.
  A `withQuoted` prototype member is **query-only**: calling it in memory throws.
- **A query TOKEN is PascalCase and ROOTLESS** — `ShipAddress.City`, not `Entity.ShipAddress.City` and not
  `shipAddress.city`. Build them with `Type.token(a => a.field)`; resolution falls back to a
  case-insensitive match, so nothing stored has to be migrated.
- **A REGISTERED EXPRESSION is DECLARED in `data/` and IMPLEMENTED in `server/`.** The declaration is a
  `declare module` widening the type (optional, `?`), the implementation a `withQuoted` prototype stamp.
  Stamp once on `Entity.prototype` when the body does not depend on the type; per type only when it does.
  Registering on `Entity` itself is how an expression every entity offers is written.
- **A CACHE is read inside a query with `.$v`**, and only if it declares a `runtimeType`: `ResetLazy` /
  `sb.globalLazy(…, { runtimeType: () => new ArrayType(…) })` is what makes `vipIds().$v.includes(o.customer)`
  translatable — the declared type is what the fold dispatches on, and the LINQ provider loads the cache on
  demand while binding. `.$v` is query-only: in memory the accessor throws, so such a lambda cannot double
  as an in-memory predicate (give `TypeConditionLogic.register` an `async` twin instead of using
  `registerCompile`).
- **There is no QueryDescription.** Token trees are built client-side from the registered entity metadata
  (`Finder.getQueryRoot`); a manual query is named by its ROW MODEL, and each column's caption is that
  field's own `@niceName`.

## Registration

- **Operations are declared ON THE INCLUDE.** `sb.include(X).withQuery().withSave(...)`, and
  `.withStateMachine(x => x.state, sm => { … })` for a graph with transitions, where `fromStates` /
  `toStates` are compile-time required exactly where Signum asserts them. A `ConstructFrom` names its
  SOURCE type first, because that is where the button appears.
- **An operation's owning type is its first constructor argument**, standing in for the erased generic.
- **A module registers what a module owns; the app registers only what only the app knows.** Skills,
  e-mail owners, default templates and a module's own file stores belong to the module; credentials, the
  file-store backend and the app's entity domains belong to the app.
- **Symbol tables are seeded through a THUNK**, evaluated when the table is generated / synchronized /
  loaded — so registration order rarely matters, and `OperationLogic.start` may be called first.

## Display names

Fluent and typed, never a free function over a ctor:

```ts
OrderEntity.niceName();  OrderEntity.nicePluralName();  OrderEntity.newNiceName();
OrderEntity.nicePropertyName(a => a.orderNumber);
Enum.niceName(OrderState, "Shipped");   someSymbol.niceToString();   fieldInfo.niceToString();
```

`Localization.Internal` in application or extension code is a bug — it has four legitimate callers.
Two gotchas: `nicePropertyName`'s lambda overload needs an INLINE lambda (that is where the transformer
stamps), and **the transformer does not rewrite lambdas inside JSX attributes** — pass the route as a
string there.

## React

- Functional components as plain functions; type all props and state (isolatedDeclarations).
- Prefer altea's hooks (`useAPI`, `useForceUpdate`) over state-management libraries.
- Imperative mutation of entities in components is fine; immutability is not enforced.
- **Lines read their type from `ctx.memberType`**, not a `type={…}` prop — `AutoLine` dispatches to the
  right editor from it.
- Rule sets live in `client/FinderRules.tsx`, not inline in `Finder.tsx` (the editors import Lines, and
  Lines import Finder).

## Localization

Translations live in **each package's own `translations/` directory** (`altea-workflow/translations/
Altea.Workflow.es.xml`), not in one per-app folder — a module's translations travel with the module. At
boot, `loadAppTranslations` walks the dependency graph and loads the app's own `translations/` LAST, so an
app file wins a collision.

## Build & test

- **Types build with `tspc`** (ts-patch, for the quote-transformer), project-references style: `tspc -b`.
  A transformer change is invisible to tsc's up-to-date check — use `tspc -b --force` after one.
- If you move or rename a `.ts`, delete the stale `dist/` output first; the recursive glob would otherwise
  run both the old and the new file.
- **A package's tests live inside it, in `test/`**, built by the same `tspc -b` into `dist/test/**` and run
  with the Node built-in runner. Each suite reads its own connection string from the package's
  `.env.postgres` / `.env.sqlserver`, so no two suites share a schema; without the variable the DB-backed
  cases are skipped.

| Suite | Env var | Command |
| --- | --- | --- |
| framework (music model) | `ALTEA_TEST_DB` | `pnpm --filter @altea/altea test:postgres` |
| authorization | `ALTEA_AUTH_TEST_DB` | `pnpm --filter @altea/altea-auth test:postgres` |
| cache | `ALTEA_CACHE_TEST_DB` | `pnpm --filter @altea/altea-cache test:postgres` |
| isolation | `ALTEA_ISOLATION_TEST_DB` | `pnpm --filter @altea/altea-isolation test:postgres` |

First run: seed that suite's database with the matching `gen:postgres` (it cleans and regenerates it).
Adding a DECLARED SYMBOL to a module means its suite's database needs regenerating, or every test fails on
a caching mismatch.

## The CLIs

`cli/` holds three commands that work on an APPLICATION built with altea, rather than on altea itself —
see [`cli/README.md`](cli/README.md):

| | |
| --- | --- |
| `altea-cli-utils` | not a command — the plumbing the three share (the application context, git, the console, argv) |
| `altea-upgrade` | apply this application's pending source upgrades (Signum.Upgrade's counterpart), and the toolkit for writing one |
| `altea-clone` | copy the application into a new project, renamed, with its own git repository |
| `altea-simplify` | remove the optional modules it does not need, following its `Modules.xml` |

None of them imports `@altea/altea`, and **no CLI depends on another CLI** — the common half is
`altea-cli-utils`, which itself depends on nothing. Each runs where the framework could not be relied
on: `altea-clone` creates the project a dependency would be installed into, `altea-upgrade` edits source
that does not compile, and `altea-simplify` deletes whole modules. They build with plain `tsc`, not
`tspc`: nothing there is an entity or a query.

A framework change that an application has to mirror in ITS OWN source — a renamed export, a moved
module, a changed option — should ship with an upgrade in `cli/altea-upgrade/upgrades/`. That is the
only way an application that is not this repository ever finds out.

## SQL

**Never create or modify SQL migration files unless explicitly asked.** They are generated by
`terminal sync` and are likely already applied to a database.
