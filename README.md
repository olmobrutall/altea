# altea

**A TypeScript framework for data-centric business applications.** You write an entity model once; altea
creates and migrates the database schema from it, gives you a typed LINQ provider to query it, and renders
searchable, editable, permission-aware pages for it in React — without a code generator, a second DTO
model, or a REST endpoint per screen.

It stores data in **PostgreSQL** or **Microsoft SQL Server**.

## What you get

The kind of application altea is for — an ERP, a back office, anything where the domain is large and the
screens are many — is mostly the same work repeated: a table, a form, a search page, who may see it, an
audit trail, an export, a scheduled job. altea ships that work as **vertical modules**: about fifty of
them, each owning its own tables, entities, server logic and React components.

Out of the box: authentication with per-role authorization down to the individual type, property, query
and operation; a search control with a token-based filter builder over any entity graph; dashboards and
charts; user-defined queries; mail with templates; file storage (local, Azure Blob, S3); background
processes and scheduled tasks; Excel and Word report templates; a workflow engine; caching; time travel
over versioned tables; an audit log; a chatbot agent.

You add your own modules the same way, and they are not second-class: an application's `OrderEntity` is
registered, queried, authorized and rendered by exactly the mechanisms `UserEntity` is.

## What a module looks like

Three files — and this is a complete one from the demo application: a table, a save operation, a search
page and an edit form.

```ts
// Shipper.data.ts — the model. Compiled verbatim into the server AND the browser.
@entity("Main", "Master")
export class ShipperEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    companyName: string;
    @stringLengthValidator({ min: 3, max: 24 })
    phone: string;
    @quoted toString(): string { return this.companyName; }
}

export namespace ShipperOperation {
    export const Save: ExecuteSymbol<ShipperEntity> = init();
}
```

```ts
// ShipperLogic.server.ts — the table, the save operation, the query.
sb.include(ShipperEntity)
    .withCache()                        // three rows, read constantly, changed almost never
    .withSave(ShipperOperation.Save)
    .withQuery();
```

```ts
// ShipperClient.client.ts — which columns the search page opens with.
cb.configure(ShipperEntity)
    .withQuerySettings(token => ({
        defaultColumns: [token(a => a.id), token(a => a.companyName), token(a => a.phone)],
    }));
```

That is the whole feature. The schema, the `/api` surface, the search page, the edit form, the save
button and its authorization all follow from those declarations.

## The ideas behind it

**Entities are the centre, and there is one of them.** An entity is a plain class with plain fields — no
getters, no setters, no change tracking. The same file is compiled into the server bundle and the browser
bundle, so a validator declared once runs in the form as the user types *and* again before the `INSERT`.
There is no DTO layer and nothing to keep in sync.

**Queries are LINQ, and they become SQL.** Not a builder that happens to look like LINQ — a provider that
translates the expression tree, avoids N+1 by construction, and can `UPDATE` or `DELETE` without
retrieving first:

```ts
await table(OrderEntity)
    .filter(o => Temporal.PlainDate.compare(o.orderDate, cutoff) < 0)
    .executeUpdate(() => ({ cancelationDate, state: OrderState.Canceled }));
```

**A method can be part of the model.** `@quoted` marks one whose body is captured as an expression tree at
build time by a TypeScript transformer, so it is callable in memory *and* translatable to SQL:

```ts
@quoted totalPrice(): Decimal { return this.details.sum(d => d.subTotalPrice()); }
```

Register it and `TotalPrice` becomes a column users can filter, sort, chart and export by — computed in
the database, never fetched row by row.

**The schema is derived, and migrated by diff.** There are no migration classes to write by hand: the
console compares the model against the live database and writes the script it proposes, for you to read
before it runs. Renames are asked about rather than guessed, because a wrong guess drops a column.

**The layer boundary is enforced by the compiler.** Every package is split into `data` (the isomorphic
model), `client` (React) and `server` (the engine), and the tsconfig presets make a violation a build
error — which is what keeps the engine, and your connection string, out of the browser bundle.

## Layout

```
altea/                  @altea/altea — the core: connection, linq, schema, sync, dynamicQuery, reflection
                        and the React UI kit. `presets/` inside it holds the tsconfigs every package
                        extends, which is what enforces the layer boundary
altea-<module>/         one package per vertical module — auth, cache, chart, dashboard, email, files,
                        processes, scheduler, toolbar, workflow, …  (≈50)
quote-transformer/      the ts-patch transformer behind `@quoted`; nothing compiles meaningfully without it
cli/                    altea-clone, altea-simplify, altea-upgrade — see cli/README.md
port/                   the port ledgers — see "Compared to Signum Framework" below
```

## Getting started

altea is consumed as a **git submodule of an application**, not installed from a registry. You do not
start from an empty folder: you copy the demo application and delete the modules you do not want.

```bash
node <workspace>/altea/cli/altea-clone/dist/main.js --name myapp    # a new repo, renamed, altea pinned
cd ../myapp
node <workspace>/altea/cli/altea-simplify/dist/main.js             # untick the modules you do not want
pnpm install
pnpm --filter quote-transformer build
pnpm --filter myapp build
```

`<workspace>` is the application you are copying FROM: the new project's own submodule is not installed
yet, so the CLIs are run from there. `altea-clone` prints these steps with the paths filled in.

[**eastwind**](https://github.com/olmobrutall/eastwind) is that demo application — Microsoft's Northwind
schema and data, with most of the modules wired up. It is the reference for how an altea application is
put together, and its README walks through running it.

**The conventions** — entities, queries, operations, registration, React, localization, build and test —
are [`AGENTS.md`](AGENTS.md). It is addressed to an AI coding agent, and is equally the human's short
guide.

## Build and test

Types build with **`tspc`** (ts-patch, for the quote-transformer), project-references style:

```bash
pnpm --filter @altea/altea build      # tspc -b
```

A transformer change is invisible to tsc's up-to-date check — use `tspc -b --force` after one, or an
incremental build will re-emit entities with no `@quoted` trees at all.

Each package keeps its tests in its own `test/`, run with vitest. The DB-backed suites read a connection
string from that package's `.env.postgres` / `.env.sqlserver`; without it those cases are skipped, so the
model-only tests still run anywhere.

```bash
pnpm --filter @altea/altea gen:postgres     # seed that suite's database (destructive)
pnpm --filter @altea/altea test:postgres
```

---

## Compared to Signum Framework

altea is a **port of [Signum Framework](https://www.signumsoftware.com/en/Framework)**, a mature C# +
ASP.NET framework built on the same ideas — vertical modules, entities at the centre, a full LINQ
provider, schema synchronization, a React UI kit. Signum's
[documentation](https://www.signumsoftware.com/Documentation) and
[tutorials](https://github.com/signumsoftware/docs) largely read true here, and are the best long-form
material available for the concepts.

**What changes is the substrate.** Signum is C# on the server and TypeScript on the client, with a
generator keeping the two entity models in step. altea is TypeScript on both sides: one model, written
once, used by the schema builder and by the browser. No generation step, no second model, one language and
one debugger.

**What you give up** is .NET — its threading, its libraries, its tooling — and the years of production
hardening behind Signum. altea is younger; see *Status* below.

For a Signum developer, the spellings that differ most:

| Signum | altea |
| --- | --- |
| `MList<T>` | a plain `T[]` of `@part` row entities — MLists are gone |
| `EmbeddedEntity` | `@part` as well, with a table and a class of its own |
| `[AutoExpressionField]` | `@quoted`, rewritten into an expression tree at build time |
| `Graph<T, TState>` | `sb.include(X).withStateMachine(x => x.state, …)`, with `fromStates` / `toStates` required exactly where Signum asserts them |
| `new Graph<T>.Execute(…).Register()` | `.withSave(…)` / `.withExecute(…)` on the include |
| `Database.Query<T>().Where(…).Take(n)` | `table(T).filter(…).top(n)` — and every terminal is `async` |
| `.Any(…)` / `.All(…)` | `.some(…)` / `.every(…)` |
| `[LiteModel]` | a custom lite: the model's fields live on the `Lite` itself |
| `DateTime` / `DateOnly` / `decimal` | `Temporal.PlainDateTime` / `Temporal.PlainDate` / `Decimal` |
| `QueryDescription` | gone — token trees are built from the registered metadata |

- **Why each divergence exists**, and the migration it needs, is [`port/port.md`](port/port.md), with one
  ledger per module beside it.
- **Porting an existing Signum application onto altea** — the full translation table, what parity means,
  and the `@legacy*` declarations that let a port run against the database the Signum application left
  behind — is [`AlteaPortLegacy.md`](AlteaPortLegacy.md).

## Status

A port in progress, tracked in [`port/MODULE-PORT-STATUS.md`](port/MODULE-PORT-STATUS.md) — one row per
Signum extension, with what was ported, what diverges and what is deliberately left out. The roadmap is
[`port/PLAN.md`](port/PLAN.md).

There is no version number. Like Signum, altea is distributed as source and identified by commit: an
application pins the submodule to the revision it was verified against.
