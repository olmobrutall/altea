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

A module is one folder with the same three layers every altea package has — **data**, **server**,
**client**. This is the smallest complete one in the demo application.

### Data — the model

One file, compiled into the server bundle AND the browser bundle. It imports neither the engine nor
React — and it SHAPES both. `companyName` is a `varchar(100) NOT NULL` with a unique index, because the
field is non-nullable and the validator's `max` sizes the column; it is also a required text box that
refuses fewer than three characters as you type, and a sortable, filterable column on the search page.
One declaration, read from both ends.

```ts
// Shipper.data.ts
@entity("Main", "Master")
export class ShipperEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    companyName: string;
    @stringLengthValidator({ min: 3, max: 24 })
    phone: string;
    @quoted toString(): string { return this.companyName; }
}

// Cross-entity navigation: declared here, implemented in the server layer where `table(T)` lives.
export interface ShipperEntity {
    orders(): IQuery<OrderEntity>;
}

export namespace ShipperOperation {
    export const Save: ExecuteSymbol<ShipperEntity> = init();
}
```

### Server — the table, the operations, the queries

```ts
// ShipperLogic.server.ts
sb.include(ShipperEntity)
    .withSave(ShipperOperation.Save)
    .withExpressionTo(s => s.orders())
    .withQuery();
```

And the navigation the model declared — a LINQ query, and the reason the model could declare it without
knowing anything about the database:

```ts
ShipperEntity.prototype.orders = withQuoted(function (this: ShipperEntity): Query<OrderEntity> {
    return table(OrderEntity).filter(o => o.shipVia!.id == this.id);
});
```

That one registration turns `Orders` into a token on the Shipper query — so a user can add *Orders.Count*
as a column, filter by *Orders.Any.Total price*, or chart against it, none of which anybody wrote a screen
for. `await shipper.orders().toArray()` is the same expression, from code.

### Client — the search page and the form

```ts
// ShipperClient.client.ts — the view, and which columns the search page opens with.
cb.configure(ShipperEntity)
    .withView(() => import("./Shipper"))
    .withQuerySettings(token => ({
        defaultColumns: [
            token(a => a.id),
            token(a => a.companyName),
            token(a => a.phone),
        ],
    }));
```

```tsx
// Shipper.tsx — the form. `AutoLine` picks the editor from the field's own type, and the orders this
// shipper carried are a search page embedded in it.
export default function Shipper(p: { ctx: TypeContext<ShipperEntity> }): React.JSX.Element {
  const ctx = p.ctx;
  return (
    <div>
      <AutoLine ctx={ctx.subCtx(s => s.companyName)} />
      <AutoLine ctx={ctx.subCtx(s => s.phone)} />
      <h2>{OrderEntity.nicePluralName()}</h2>
      <SearchControl findOptions={OrderEntity.findOptions(token => ({
        filterOptions: [token(a => a.shipVia).filter("EqualTo", ctx.value)]
      }))} showSimpleFilterBuilder={false} />
    </div>
  );
}
```

That is the whole feature. The schema, the `/api` surface, the search page, the save button and its
authorization all follow from those declarations — and the form is a plain React component, so the lines
are yours to arrange. Leave the view out entirely and the entity still gets a generated one.

## The ideas behind it

**Entities are the centre, and there is one of them.** An entity is a plain class with plain fields — no
getters, no setters, no change tracking. The same file is compiled into the server bundle and the browser
bundle, so a validator declared once runs in the form as the user types *and* again before the `INSERT`.
There is no DTO layer and nothing to keep in sync.

**Queries are LINQ, and they become SQL.** Not a builder that happens to look like LINQ — a provider that
translates the expression tree you wrote, and avoids N+1 by construction. It can also `UPDATE` or `DELETE`
without retrieving anything first:

```ts
await table(ProductEntity)
    .filter(p => p.category.is(seasonal))
    .executeUpdate(() => ({ discontinued: true }));
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

## The compiler magic

Two of those claims should look impossible. TypeScript erases types at run time, and a lambda is just a
closure — nobody can see inside it. So how does the schema builder know `phone` is a 24-character string,
and how does anything turn `o => o.totalPrice() > 100` into a `WHERE` clause?

A **compiler plugin** puts back what the compiler throws away. `quote-transformer` is a TypeScript
transformer, run through [ts-patch](https://github.com/nonara/ts-patch) — which is why the build command
is `tspc`, not `tsc`. It does exactly two things.

### 1. It writes your `@field` decorators for you

A class carrying `@entity`, `@part` or `@reflect` gets one synthesised onto every property, derived from
the **type annotation you already wrote**:

```ts
// what you write                     // what the compiler emits (verbatim, from Order and Shipper)
companyName: string;                  field({ typeName: "String" })
customer: CustomerEntity;             field({ type: () => CustomerEntity })
details: OrderLineEntity[];           field({ type: () => OrderLineEntity, array: true })
shipVia: Lite<ShipperEntity> | null;  field({ type: () => ShipperEntity, nullable: true, lite: true })
quantity: int;                        field({ typeName: "Number", subTypeName: "int" })
```

That decorator is **data**, and it survives to run time. The schema builder reads it to decide the column
type, its nullability and its foreign key; the client reads the same thing to pick an editor for
`<AutoLine>` and to build the filter tokens for the search page. Write `@field` yourself and yours is
kept; `@field(false)` opts a property out entirely.

This is the piece that removes the code generator. There is no `.d.ts` to regenerate, no decorator to keep
in step with the type beside it, and no way for the two to disagree — because there is only one of them.

### 2. It attaches the source of a lambda to the lambda

`Quoted<T>` is the marker, and it is barely a type at all:

```ts
type Quoted<T extends Function> = T & { __quoted?: () => ExLambda };
```

A quoted lambda is still an ordinary function you can call. What it gains is a property holding **its own
body, as data** — a tree of plain arrays with the operator in slot 0. This is the whole of `ShipperEntity`'s
`toString`, source and emitted output:

```ts
@quoted toString(): string { return this.companyName; }

quoted(() => (_this => ["=>", [_this], [".", _this, "companyName"]])(["p", "_this"]))
```

`["p", …]` is a parameter and `[".", …]` a member access; elsewhere `["c", …]` is a captured constant,
`["()", …]` a call, and a binary operator is its own JavaScript spelling. Note that the parameter node is
built once and referenced from both the parameter list and the body — the binder matches parameters by
object identity, not by name.

It is plain data: no `eval`, no parsing a function's `toString()`, nothing to build until something asks.

**There are exactly two ways a function becomes `Quoted`, and you write neither of them.**

*You ask for it, with `@quoted`* — that is the case above, and it is for a **method that is part of the
model**: something you want callable in memory *and* usable as a column.

*Or the position asks for it.* Anywhere a parameter, field or variable is declared `Quoted<…>`, the arrow
you put there is stamped — you just write an arrow. `Query.filter` declares
`predicate: Quoted<(element: T) => boolean>`, and that is the whole reason a query lambda works. Here is
the shipper's `orders()` from the module above, source and emitted (the inner arrow only — the whole
method is wrapped the same way):

```ts
return table(OrderEntity).filter(o => o.shipVia!.id == this.id);

return table(OrderEntity).filter(o => o.shipVia.id == this.id);
//                               ↑ still a plain arrow — the tree rides beside it:
(o => ["=>", [o], ["==", [".", [".", o, "shipVia"], "id"], [".", _this, "id"]]])(["p", "o"])
```

The arrow is untouched and still runs. The transformer wraps it with `Object.assign(fn, { __quoted: … })`
so the tree travels with it — which is also how a *registered* expression is passed:
`withExpressionTo(s => s.orders())` emits `Object.assign(s => s.orders(), { __quoted: … })`.

So `@quoted` marks a model method; `Quoted<T>` in a signature quietly does the rest, and the day-to-day
experience is that you write ordinary TypeScript and it happens to reach the database. The transformer
also emits a `registerType(...)` call and a `__fileInfo` constant per file, so a type knows its own name
and which package it came from — what the schema builder and the reflection endpoint read.

**The practical consequences.** Build with `tspc`; plain `tsc` compiles happily and produces functions with
no `__quoted`, so everything fails at run time with "has not been quoted". And a change to the transformer
is invisible to tsc's up-to-date check — after one, `tspc -b --force`.

## The LINQ provider

If you have used **Prisma**, **Drizzle** or **TypeORM**, you have written the same query twice: once as
the shape you want, once in whatever the library can actually see.

```ts
// Drizzle — a builder, because JS cannot look inside an arrow
.where(and(eq(orders.state, "Ordered"), gt(orders.totalPrice, 100)))

// Prisma — an object DSL
where: { state: "Ordered", totalPrice: { gt: 100 } }

// altea — the predicate IS TypeScript
.filter(o => o.state == "Ordered" && o.totalPrice() > 100)
```

The difference is not syntax sugar. Because the transformer left the body on the function, altea's provider
can *read the expression you wrote*, so the predicate is checked by the compiler, renamed by your IDE's
rename, and free to call a method you defined (`o.totalPrice()`) — a computed value that lowers into the
SQL rather than being fetched and recomputed in Node. This is LINQ, the idea .NET has had since 2007, and
it is the whole reason the `@quoted` machinery above exists.

Here is what happens between your arrow and the rows coming back.

**1. Tuples become an expression tree.** `Expression.fromQuotedLambda` walks the arrays and builds typed
nodes — `PropertyExpression`, `BinaryExpression`, `CallExpression` — resolving each one's type from the
`@field` metadata of section 1. Any subtree that mentions no parameter is folded to a constant in the same
pass, which is how a captured variable from the enclosing scope becomes a query *parameter* rather than a
column reference.

**2. The tree becomes a relational one.** `QueryBinder` is the piece that knows about databases: it turns
`.filter` / `.map` / `.flatMap` / `.groupBy` into selects, joins and columns, expands `o.customer.address.city`
into the joins that reach it, and resolves a polymorphic reference into its type-discriminator columns. The
result is a `ProjectionExpression` — a relational query plus a description of the object to build from each
row.

**3. A dozen rewriters tidy it.** Aggregates get hoisted into their `GROUP BY`; orderings get promoted to
columns; unused columns, redundant sub-queries and duplicate joins are removed. This is why the SQL for a
three-line query does not look like three lines of query — it looks like what you would have written.

**4. SQL, and a compiled projector.** The formatter emits the statement and its parameters. Separately, the
projector — the "build an object from a row" half — is emitted as **JavaScript source and compiled with
`new Function`**, so materialising ten thousand rows runs compiled code rather than an interpreter walking
a tree per row.

**Where N+1 goes.** A collection is not a join that multiplies rows, and it is certainly not a query per
parent. Each child collection becomes **one** additional query, whose rows are grouped into a lookup keyed
by the parent id; the projector reads its slice out of that lookup. Ten thousand orders with their lines is
two queries, whatever you do to it.

**And nothing forces a round trip.** `.executeUpdate(…)` / `.executeDelete()` translate to a single
statement — no `SELECT`, no entities materialised, no optimistic-concurrency dance — which is what the
example in *The ideas behind it* above is doing.

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
