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
**client**. The boundary is enforced by the tsconfig presets, not by convention: a `client` file that
reaches for the engine is a build error, which is what keeps the engine, and your connection string, out
of the browser bundle. This is the smallest complete module in the demo application.

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

export namespace ShipperOperation {
    export const Save: ExecuteSymbol<ShipperEntity> = init();
}
```

**An entity is a plain class with plain fields** — no getters, no setters, no change tracking. Because
the same file is what both tiers compile, a validator declared once runs in the form as the user types
*and* again before the `INSERT`. There is no DTO layer and nothing to keep in sync.

### Server — the table, the operations, the queries

Declaring the class is not enough: an entity reaches the schema only when it is **registered**, and
`sb.include` is that registration — the table, its columns and its indexes, then whatever else this type
offers.

```ts
// ShipperLogic.server.ts
sb.include(ShipperEntity)
    .withSave(ShipperOperation.Save)
    .withQuery();
```

**Queries are LINQ, and they become SQL** — the same array methods you already use, over a table:

```ts
const busiest = await table(OrderEntity)
    .groupBy(o => o.shipVia)
    .map(g => ({ shipper: g.key, orders: g.elements.length }))
    .orderByDescending(x => x.orders)
    .toArray();
```

One statement, one round trip. Nothing in there is a string, so a renamed field is a compile error rather
than a runtime surprise — and `o.shipVia` is a reference, so the join to reach it is the provider's
problem, not yours.

It can also `UPDATE` or `DELETE` without retrieving anything first:

```ts
await table(ProductEntity)
    .filter(p => p.category.is(seasonal))
    .executeUpdate(() => ({ discontinued: true }));
```

**And the table itself is derived, then migrated by diff.** There are no migration classes to write by
hand: the console compares the model against the live database and writes the script it proposes, for you
to read before it runs. Renames are asked about rather than guessed, because a wrong guess drops a column.

### Client — the search page and the form

All of this is **optional**: an entity with no client registration still gets a search page and a
generated form. This is where you override those defaults.

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

A `TypeContext` is the entity plus where you are inside it — the value, its property route, its
read-only-ness — so `ctx.subCtx(s => s.phone)` hands a Line everything it needs to render and validate
that one field.

That is the whole feature. The schema, the `/api` surface, the search page, the save button and its
authorization all follow from those declarations — and the form is a plain React component, so the lines
are yours to arrange.

## The compiler magic

If you have written TypeScript for any length of time, two of the claims above should have bothered you.
**Types are erased** — `shipVia: Lite<ShipperEntity> | null` is checked and then deleted, so nothing at
run time knows that property is a foreign key. **And a lambda is a closure** — `p => !p.discontinued` is a
function you can call, with no way to ask what it does.

`quote-transformer` puts both back. It is a TypeScript transformer run through
[ts-patch](https://github.com/nonara/ts-patch), which is why the build command is `tspc` and not `tsc`.

### Automatic metadata

A class carrying `@entity`, `@part` or `@reflect` gets an `@field(…)` decorator synthesised onto every
property, derived from **the type annotation you already wrote**:

```ts
// what you write                     // what the compiler emits (verbatim, from Order and Shipper)
companyName: string;                  field({ typeName: "String" })
customer: CustomerEntity;             field({ type: () => CustomerEntity })
details: OrderLineEntity[];           field({ type: () => OrderLineEntity, array: true })
shipVia: Lite<ShipperEntity> | null;  field({ type: () => ShipperEntity, nullable: true, lite: true })
quantity: int;                        field({ typeName: "Number", subTypeName: "int" })
```

A decorator is an ordinary function call, so unlike the type it survives compilation — and `field` records
what it was given in a per-class registry, alongside a `registerType(…)` naming the class and a
`__fileInfo` saying which package it came from.

That registry is **reflection**, and it is what every layer reads instead of reading your source. The
schema builder asks it for columns, sizes and foreign keys; the serializer asks it how to rebuild a graph
from JSON; the client asks it which editor `<AutoLine>` should render and which query tokens the search
page can offer. Write `@field` yourself and yours is kept; `@field(false)` opts a property out.

This is the piece that removes the code generator: one declaration, read by everything, with no second
artefact to regenerate and no way for the two to disagree.

### Quoting expressions

**Quoting** is capturing an expression as *data* rather than compiling it to code. You write a lambda;
what the transformer stores beside it is an **expression tree** — the operators, the property reads and
the constants, in a structure something else can walk, understand and translate into another language.
C# spells it `Expression<Func<T, bool>>`, and it is the mechanism LINQ is built on.

`Quoted<T>` is the marker, and it is barely a type at all:

```ts
type Quoted<T extends Function> = T & { __quoted?: () => ExLambda };
```

A quoted lambda is still an ordinary function you can call. What it gains is a property holding its own
body — a tree of plain arrays with the operator in slot 0: `["p", …]` a parameter, `[".", …]` a member
access, `["c", …]` a captured constant, `["()", …]` a call, and a binary operator spelled as in
JavaScript. Plain data — no `eval`, no parsing a function's `toString()`.

Two things produce one, and you write neither.

**`@quoted` on a method**, when you want it to be part of the model — callable in memory *and* usable as
a column. `ShipperEntity.toString`, source and emitted:

```ts
@quoted toString(): string { return this.companyName; }

quoted(() => (_this => ["=>", [_this], [".", _this, "companyName"]])(["p", "_this"]))
```

`OrderEntity.totalPrice` is the same thing with a body worth computing —
`this.details.sum(d => d.subTotalPrice())` — and registering it makes `TotalPrice` a column users can
filter, sort, chart and export by, summed in the database rather than fetched row by row.

**A `Quoted<…>` position**, for everything else. Anywhere a parameter, field or variable is declared
`Quoted<…>`, the arrow you put there is stamped. `Query.filter` declares
`predicate: Quoted<(element: T) => boolean>` — which is the entire reason a query lambda works:

```ts
table(ProductEntity).filter(p => !p.discontinued)

table(ProductEntity).filter(Object.assign(p => !p.discontinued, {
    __quoted: () => (p => ["=>", [p], ["!", [".", p, "discontinued"]]])(["p", "p"])
}))
```

Both leave the function untouched and still callable; the tree just travels beside it.

**The practical consequences.** Build with `tspc`; plain `tsc` compiles happily and produces functions with
no `__quoted`, so everything fails at run time with "has not been quoted". And a change to the transformer
is invisible to tsc's up-to-date check — after one, `tspc -b --force`.

## The LINQ provider

**You already know how to write these queries.** `filter`, `map`, `flatMap`, `some`, `every`, `includes`,
`reverse` — they are the array methods you use every day, taking the arrows you would write for an array,
over a table instead of an array. There is no query language to learn, no builder to assemble, no object
DSL to look up, and no string to typo: a renamed field is a compile error, and your IDE's rename fixes
every query in the codebase.

More to the point, there is no *edge* to the syntax. Because the provider reads the expression you wrote
rather than a DSL you assembled, a query can call a method you defined, navigate a reference, or nest
another query — things a builder cannot express because no vocabulary was invented for them.

**Operators that BUILD the query.** Each returns a new `Query<T>` and touches nothing — chain as many as
you like, and hand the result around unfinished.

| | |
| --- | --- |
| `filter(p)` | `WHERE` |
| `map(f)` | `SELECT` — project to an entity, a model, or an object literal |
| `flatMap(f)` | one row per element of a nested collection |
| `distinct()` | `DISTINCT` |
| `orderBy(f)` · `orderByDescending(f)` | `ORDER BY` |
| `thenBy(f)` · `thenByDescending(f)` | the next sort key |
| `reverse()` | invert the ordering so far |
| `top(n)` · `skip(n)` | `TOP` / `LIMIT`, and `OFFSET` |
| `groupBy(k)` | `GROUP BY`, yielding `{ key, elements }` |
| `ofType(T)` · `cast(T)` | narrow a polymorphic reference to one implementation |
| `innerJoin` · `leftJoin` · `rightJoin` · `fullJoin` | explicit joins — rarely needed, a reference joins itself |

**Operators that RUN it.** Each is `await`ed, and each is where a statement is finally sent.

| | |
| --- | --- |
| `toArray()` | the rows |
| `first()` · `firstOrNull()` · `last()` · `lastOrNull()` | one row, throwing or null when there is none |
| `single()` · `singleOrNull()` | the same, and complains if there are two |
| `count(p?)` | `COUNT` |
| `sum(f?)` · `avg(f?)` | `SUM` · `AVG` |
| `min(f?)` · `max(f?)` | `MIN` · `MAX` |
| `minBy(f)` · `maxBy(f)` | the ROW with the smallest / largest value |
| `some(p?)` · `every(p)` | `EXISTS`, and `EXISTS` over the negated predicate |
| `includes(x)` | `IN` |
| `executeUpdate(f)` · `executeDelete()` | one statement, nothing retrieved |

Nothing before an `await` reaches the database, so a query is worth passing around and adding to. And the
same names appear on *both* sides of the line depending on where you write them: `o.details.some(…)`
inside a lambda is an `EXISTS` sub-query the outer statement carries, not a second round trip.

Between your arrow and the rows, four steps:

1. **Tuples become an expression tree** — typed nodes, with any parameter-free subtree folded to a constant, which is how a captured variable becomes a query parameter and not a column.
2. **The tree becomes a relational one** — `QueryBinder` turns the operators into selects, joins and columns, and expands `o.customer.address.city` into the joins that reach it.
3. **A dozen rewriters tidy it** — aggregates into their `GROUP BY`, orderings into columns, unused columns and redundant sub-queries and duplicate joins removed.
4. **SQL, and a projector** — the statement plus a "build an object from this row" function, emitted as JavaScript and compiled with `new Function` rather than interpreted per row.

**Where N+1 goes.** A collection is not a join that multiplies rows, and never a query per parent: each
child collection is **one** more query, grouped into a lookup keyed by the parent id that the projector
reads its slice out of. Ten thousand orders with their lines is two queries, whatever you do to it.

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
