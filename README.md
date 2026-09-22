# altea

**A TypeScript port of [Signum Framework](https://www.signumsoftware.com/en/Framework)** — an ORM with a
full LINQ provider, a dynamic-query engine, and a React UI kit, for writing data-centric line-of-business
applications. It stores data in **PostgreSQL** or **Microsoft SQL Server**.

Signum's central idea carries over unchanged: the application is built out of **vertical modules** — a
module owns its database tables, its entities, its logic and its React components, and can be shared
between projects. altea ships about fifty of them.

What changes is the substrate. Signum is C# + ASP.NET on the server and TypeScript on the client, with a
code generator keeping the two models in step. altea is **TypeScript on both sides**: one entity model,
written once, used by the schema builder and by the browser. There is no generation step and no wire
model to keep aligned.

- **The conventions** — entities, queries, operations, registration, React, localization, build and
  test — are [`AGENTS.md`](AGENTS.md).
- **Why each of them diverges from Signum**, and the migration it needs, is [`port/port.md`](port/port.md),
  with one ledger per module beside it.
- **Porting an existing Signum application onto altea** is [`AlteaPortLegacy.md`](AlteaPortLegacy.md).

## Main features

* Designed for vertical modules (bounded contexts)
* Entities-first: one plain TypeScript model, shared by the server and the browser
* ORM with a full LINQ provider — no N+1, and `UPDATE` / `DELETE` / `INSERT` without retrieving first
* Unified validation, running on both tiers from the same declarations
* Schema generation and synchronization against a live database
* React + Bootstrap SPA (Navigator, Finder, SearchControl, Lines, Operations)
* Authorization down to the type, property, query, operation and permission

## What a Signum developer will notice first

| Signum | altea |
| --- | --- |
| `MList<T>` | a plain `T[]` of `@part` row entities — MLists are gone |
| `[AutoExpressionField]` | `@quoted`, rewritten into an expression tree at build time |
| `Graph<T, TState>` | `sb.include(X).withStateMachine(x => x.state, …)`, with `fromStates` / `toStates` required where Signum asserts them |
| `Database.Query<T>().Where(…).Take(n)` | `table(T).filter(…).top(n)` — and every terminal is `async` |
| `[LiteModel]` | a custom lite: the model's fields live on the `Lite` itself |
| `DateTime` / `decimal` | `Temporal.PlainDateTime` / `Decimal` |

The full table, member by member, is in [`AlteaPortLegacy.md`](AlteaPortLegacy.md).

## Layout

```
altea/                  @altea/altea — the core: connection, linq, schema, sync, dynamicQuery, reflection
                        and the React UI kit. `presets/` inside it holds the tsconfigs every package
                        extends, which is what enforces the layer boundary below
altea-<module>/         one package per vertical module — auth, cache, chart, dashboard, email, files,
                        processes, scheduler, toolbar, workflow, …  (≈50)
quote-transformer/      the ts-patch transformer behind `@quoted`; nothing compiles meaningfully without it
cli/                    altea-clone, altea-simplify, altea-upgrade — see cli/README.md
port/                   the port ledgers: what Signum does, what altea does instead, and why
```

Every package is split into three layers — `data` (the isomorphic model), `client` (React) and `server`
(the engine) — and the boundary is enforced by the tsconfig presets, not by convention. A `client` file
cannot reach the engine, which is what keeps server code out of the browser bundle.

## Getting started

altea is consumed as a **git submodule of an application**, not installed from a registry. The fastest
route is to copy the demo application and delete what you do not need:

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
schema and data, ported from Signum's Southwind. It is also the reference for how an altea application is
wired.

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

## Status

A port in progress, tracked in [`port/MODULE-PORT-STATUS.md`](port/MODULE-PORT-STATUS.md) — one row per
Signum extension, with what was ported, what diverges and what is deliberately left out. The roadmap is
[`port/PLAN.md`](port/PLAN.md).

There is no version number. Like Signum, altea is distributed as source and identified by commit: an
application pins the submodule to the revision it was verified against.
