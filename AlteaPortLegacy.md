# Porting a Signum application onto altea

**This is the manual for moving an EXISTING Signum application onto altea** — the translation table from
C# + Signum.React to TypeScript + altea, plus the rules that keep the ported application able to run
against the database the Signum one left behind.

It is not about altea's own port from Signum. That is [`port/port.md`](port/port.md) (the reasoning) and
[`AGENTS.md`](AGENTS.md) (the conventions distilled out of it). **Read `AGENTS.md` first** — everything
here assumes it. This file only says what the SIGNUM original becomes.

---

## The shape of the job

```
altea-clone   →  a new application, renamed, from eastwind
altea-simplify →  drop the modules this application does not use
add old/      →  the client's Signum repository, as a read-only submodule
port          →  one domain at a time, C# + tsx → data / server / client
```

`old/` is added by hand after the clone (`altea-clone` never copies a submodule), and it is
**read-only**: nothing in it is ever edited, and it is the specification for everything below.

The scaffolded application is eastwind with its own name. Its `starter.server.ts`,
`MainAdmin.client.ts` and `MainPublic.client.tsx` are already one line per module in dependency order —
**keep that order**. A ported domain is added at the end, where eastwind's own domains are.

## Parity is the goal, and parity is defined

A port is DONE when, with `LegacyMode=true`:

1. **The schema is 100% compatible.** `terminal sync` against the Signum application's own database
   produces an empty script — no table, column, index or foreign key differs. That is the acceptance
   test, and it is the reason for every `@legacy*` decorator below.
2. **The translations are the same.** The same keys with the same texts, so no user-visible string moves.
3. **The behaviour is the same.** Same operations with the same names and the same preconditions, same
   queries with the same columns, same views with the same lines in the same order.

**Ask before diverging.** A better spelling, a cleaner state machine, a column that "should" be nullable —
every one of those is a decision for whoever owns the application, not for the port. Port it as it is,
write down what you would have changed, and ask.

**Do not triage.** Every entity, operation, query and view in the source is in scope. "Probably unused"
is not a reason to skip one; the database says otherwise.

## What is NOT ported

| | Why |
| --- | --- |
| C# migrations (`*.sql` under the Signum app's Migrations) | they are already applied to the database this port must MATCH. altea's `terminal sync` writes new ones from here on. |
| Signum's `Workflow` and `Dynamic` definitions | the rows live in the database and the modules read them; there is no source to port. Start the modules, do not re-declare their content. |
| `Southwind.Test.*` C# migration tests | but DO port the logic and browser tests — see [Tests](#tests). |
| anything under `Framework/` | that is the framework, and it is already altea. |

---

## Where each Signum file goes

Signum splits deployment units into sibling PROJECTS and domains into folders inside the first. An altea
application is ONE package whose deployment units are tsconfig projects, so the mapping is:

| Signum | altea |
| --- | --- |
| `App/Orders/Order.cs` (entities, enums, operation symbols, messages) | `app/orders/Order.data.ts` |
| `App/Orders/OrderLogic.cs` | `app/orders/OrderLogic.server.ts` |
| `App/Orders/OrderGraph.cs` | folded INTO `OrderLogic.server.ts` — see [Operations](#operations) |
| `App/Orders/OrderController.cs` | usually nothing; else a `withQuery` / an expression / one route in `OrderLogic.server.ts` |
| `App/React/Orders/OrderClient.tsx` | `app/orders/OrderClient.client.tsx` |
| `App/React/Orders/Order.tsx` (the view) | `app/orders/Order.tsx` |
| `App.Server/Starter.cs` | `app/starter.server.ts` |
| `App.Server/Program.cs` / `Startup.cs` | `app/webServer.server.ts` |
| `App/React/Main.tsx` | `app/MainPublic.client.tsx` + `app/MainAdmin.client.ts` |
| `App/React/Layout.tsx` | `app/Layout.tsx` |
| `App.Terminal/` | `terminal/` |
| `App.Test.Environment` / `.Logic` / `.React` | `test/environment` / `test/logic` / `test/playwright` |
| `App/Translations/*.xml` | `translations/*.xml` — **the same file format** |

A domain folder names its modules after their ROLE (`OrderLogic.server.ts`, not `Order.server.ts`), and
the prefix stays singular even where the namespace is plural.

---

## The entity model

| Signum | altea |
| --- | --- |
| `[EntityKind(EntityKind.Main, EntityData.Transactional)]` + `class X : Entity` | `@reflect` + `@entity("Main", "Transactional")` + `class X extends Entity` |
| `[EntityKind(EntityKind.Part, …)]` | `@part` — bare, no EntityData: a part is a CONTINUATION of its owner |
| `EmbeddedEntity` | `@part` too — altea gives it a table and a class |
| `MixinEntity` | `MixinEntity`, attached with `@mixin(() => [M])` or `MixinDeclarations.register(T, M)` |
| `ModelEntity` (a row model, an operation's argument) | `@reflect class X extends ModelEntity` |
| `MList<T>` | **gone.** A plain `T[]` of `@part` row entities |
| `MList<string>` | a `T[]` of `@part` rows carrying one `@valueField` |
| a property with a getter/setter and `Set(ref field, value)` | a plain field. No getters, no setters, no `INotifyPropertyChanged` |
| `[Ignore]` | `@ignore` |
| `[NotNullValidator]`, `[StringLengthValidator]`, … | `@notNullValidator()`, `@stringLengthValidator({...})`, … |
| `[ImplementedBy(typeof(A), typeof(B))]` | `@implementedBy(() => [A, B])` |
| `[ImplementedByAll]` | `@implementedByAll` |
| `[UniqueIndex]`, `[TableName]`, `[ColumnName]` | `@uniqueIndex`, `@column({...})` |
| `Lite<T>` | `Lite<T>` |
| `[LiteModel(typeof(XLiteModel))]` | a **custom lite** — see below. There is no `LiteModel` entity |
| `enum OrderState { … }` | `export const OrderState = { New: 0, … }` + `type OrderStateKeys = keyof typeof OrderState`; the wire value is the **member NAME**, so compare with `"Shipped"` |
| `DateTime` / `DateOnly` / `TimeSpan` | `Temporal.PlainDateTime` / `Temporal.PlainDate` / `Temporal.Duration`; a comparison in a query is `Temporal.PlainDate.compare(a, b) < 0` |
| `decimal` | `Decimal`, with `Decimal.mul` / `.sub` / `.add` — the operators are not translatable |
| `Guid` | `Guid` |
| `byte[]` | `Blob` |

**Datetimes follow `Clock.mode`, as in Signum.** A `DateTime` field stays a `Temporal.PlainDateTime` in the
clock's frame, and `Clock.mode` (Signum's `Clock.Mode` / `Schema.TimeZoneMode`) decides the rest: under `Utc`
(the default) Postgres stores `timestamptz` with the session pinned to UTC, and the UI shows and edits the
value in the viewer's zone through `Clock.toUserInterface` / `fromUserInterface` (Signum's
`ToUserInterface` / `FromUserInterface`, with `Clock.withTimeZone` for `OverrideTimeZone`). SQL Server keeps
`datetime2` in both modes. Set `Clock.mode = TimeZoneMode.Local` before the schema is built for an
application that stored local time.

**Field initializers.** `strictPropertyInitialization` is off. Write `order: int;`, not
`order: int = 0` — keep only initializers that carry a real business value (`port = 25`).

### Custom lites (Signum's `[LiteModel]`)

altea has no LiteModel entity and no extra round trip: the model fields live ON the lite.

```ts
export class UserChartLite extends LiteImp<UserChartEntity> {
    constructor(id: PrimaryKey, toStr: string, readonly hideQuickLink: boolean) {
        super(id, UserChartEntity, toStr);
    }
    static isCompatible(json: Record<string, unknown>): boolean { return typeof json.hideQuickLink === "boolean"; }
    static fromJson(json: Record<string, unknown>): Lite<UserChartEntity> {
        return new UserChartLite(json.id as PrimaryKey, (json.toStr as string) ?? "", json.hideQuickLink as boolean);
    }
}

registerCustomLite(UserChartEntity, UserChartLite, uc => new UserChartLite(uc.id, uc.displayName, uc.hideQuickLink), true);
```

The `fromEntity` lambda is `Quoted`: it runs in memory for `toLite()` AND is translated to projected
columns by the LINQ provider. Signum's per-field `[LiteModel(…, ForEntityType = …)]` is the
`@customLite(() => XLite, () => XEntity)` field decorator. `ToStringExpression` is simply
`@quoted toString(): string { … }`.

Signum's `As.ReplaceExpression((UserEntity u) => u.ToString(), u => …)` — an application replacing a
framework type's expression — is assigning a new `withQuoted` function to the prototype, on BOTH tiers
(so in `entityOverrides.data.ts`), before the schema is built:

```ts
UserEntity.prototype.toString = withQuoted(function (this: UserEntity): string {
    return this.mixin(UserCareerMixin).firstName + " " + this.mixin(UserCareerMixin).lastName;
});
```

The in-memory body and the query expression are both read off the prototype when used, so queries,
lites and `toString()` all see the replacement (test/server/linqExecute/quotedReplace.test.ts).

### Mixins inline

A mixin's fields land on the OWNER's table (`employee_id` on `user`), where Signum gives the mixin its
own columns. In legacy mode that is what `@legacyColumnName` is for.

---

## Operations

`Graph<T>` and `Graph<T, TState>` are gone. Operations are declared ON THE INCLUDE, and a state machine
is a `.withStateMachine(getState, define)` where `fromStates` / `toStates` are compile-time REQUIRED
exactly where Signum asserts them.

```ts
sb.include(OrderEntity)
    .withStateMachine(o => o.state, registerOrderOperations)
    .withQuery();

function registerOrderOperations(sm: FluentStateMachine<OrderEntity, OrderState>): void {
    sm.withConstruct(OrderOperation.Create, { toStates: [OrderState.New], construct: async args => { … } });

    sm.withConstructFrom(CustomerEntity, OrderOperation.CreateOrderFromCustomer, {
        toStates: [OrderState.New],
        construct: c => OrderEntity.create({ … }),
    });

    sm.withExecute(OrderOperation.Ship, {
        canExecuteExpression: o => o.details.length === 0 ? ValidationMessage._0IsEmpty.niceToString(…) : null,
        fromStates: [OrderState.Ordered],
        toStates: [OrderState.Shipped],
        canBeModified: true,
        execute: (o, args) => { … },
    });

    sm.withDelete(OrderOperation.Delete, { fromStates: [OrderState.Ordered], delete: o => o.delete() });
}
```

| Signum | altea |
| --- | --- |
| `new Graph<Order>.Execute(OrderOperation.Save) { … }.Register()` | `.withSave(OrderOperation.Save)` / `sm.withExecute(sym, { … })` |
| `new Graph<Order>.Delete(…)` | `.withDelete(sym, { … })` |
| `new Graph<Order>.Construct(…)` | `.withConstruct(sym, { … })` |
| `new Graph<Order>.ConstructFrom<Customer>(…)` | `.withConstructFrom(CustomerEntity, sym, { … })` — the SOURCE type is named first, because that is where the button appears |
| `new Graph<Order>.ConstructFromMany<Product>(…)` | `.withConstructFromMany(ProductEntity, sym, { … })` |
| `CanExecute = o => …` | `canExecuteExpression: o => …` |
| `AllowsNew = true` | `canBeNew: true` |
| `Lite = false` | `canBeModified: true` |

A `ConstructFromMany` whose RESULT is another type hangs off THAT type's include:
`sb.include(ProcessEntity).withConstructFromMany(OrderEntity, OrderOperation.CancelWithProcess, { … })`.

### Operation symbols

```ts
export namespace OrderOperation {
    export const Create: ConstructSymbol<OrderEntity> = init();
    export const Clone: ConstructSymbol<OrderEntity, From<OrderEntity>> = init();
    export const CreateOrderFromProducts: ConstructSymbol<OrderEntity, FromMany<ProductEntity>> = init();
    export const Save: ExecuteSymbol<OrderEntity> = init();
    export const Delete: DeleteSymbol<OrderEntity> = init();
}
```

The owning type is the FIRST type argument (it stands in for Signum's erased generic); the transformer
fills the `"Container.Member"` key, which is the `key` column of the symbol's table — **so the container
name and every member name are database identity**. See [Legacy names](#legacy-names).

---

## Queries

Everything is async and lazy: `filter` / `map` / … build the tree, and the terminal returns a `Promise`.

| Signum | altea |
| --- | --- |
| `Database.Query<OrderEntity>()` | `table(OrderEntity)` |
| `.Where(a => …)` | `.filter(a => …)` |
| `.Select(a => …)` | `.map(a => …)` |
| `.SelectMany(a => a.Lines)` | `.flatMap(a => a.details)` |
| `.OrderBy` / `.OrderByDescending` / `.ThenBy` / `.ThenByDescending` | the same names, camelCase |
| `.Take(n)` / `.Skip(n)` | **`.top(n)`** / `.skip(n)` |
| `.Distinct()` | `.distinct()` |
| `.Count(pred?)` | `await .count(pred?)` |
| **`.Any(pred?)`** / `.All(pred)` | **`await .some(pred?)`** / `await .every(pred)` |
| `.Contains(x)` | `await .includes(x)` |
| `.Sum/.Min/.Max/.Average(sel?)` | `await .sum/.min/.max/.avg(sel?)` |
| `.First/.FirstEx` / `.FirstOrDefault` | `await .first` / `await .firstOrNull` |
| `.SingleEx` / `.SingleOrDefaultEx` | `await .single` / `await .singleOrNull` |
| `.ToList()` / `.ToArray()` | `await .toArray()` |
| `.GroupBy(k)` / `.GroupBy(k, e)` | `.groupBy(k)` / `.groupBy(k, e)` → `{ key, elements }` |
| `.Join(other, k, ok, res)` | `.innerJoin` / `.leftJoin` / `.rightJoin` / `.fullJoin` |
| `.UnsafeUpdate()` / `.UnsafeDelete()` / `.UnsafeInsert()` | `.executeUpdate()` / `.executeDelete()` / `.executeInsert()` |
| `.Where(…).UnsafeUpdatePart(…)` | `.executeUpdatePart(…)` |

There is **no `.any()`, `.all()`, `.take()`, `.where()`, `.select()` or `.toList()`** on a server query;
`.join(sep)` is string-join. A `Query<T>` result needs a cast at the call site:
`await table(X).filter(…).singleOrNull() as X | null`.

### `@quoted` — Signum's `[AutoExpressionField]`

```ts
@quoted totalPrice(): Decimal { return this.details.sum(d => d.subTotalPrice()); }
```

The `quote-transformer` (a ts-patch transformer) stamps the body as an expression TREE at build time.
**A nav off a NULLABLE reference uses `singleOrNull` / `firstOrNull`** (OUTER APPLY), never
`single` / `first`.

When the runtime body must DIVERGE from the translated one — SQL propagates NULL where JS arithmetic
throws — write the expression out. It must be a `function` expression (an arrow cannot declare `this`),
with a body of exactly one `return`, and it is never called at runtime:

```ts
@quoted(function (this: OrderLineEntity) {
    return Decimal.mul(Decimal.mul(this.quantity, this.unitPrice), Decimal.sub(1, this.discount));
})
subTotalPrice(): Decimal {
    if (this.quantity == null || this.unitPrice == null) return null!;
    return Decimal.mul(Decimal.mul(this.quantity, this.unitPrice), Decimal.sub(1, this.discount ?? 0));
}
```

### Registered expressions (Signum's `ExpressionExtensions.Register`)

DECLARED in `data/`, IMPLEMENTED in `server/` — because `table(T)` is a server thing:

```ts
// Product.data.ts
export interface ProductEntity { lines(): IQuery<OrderLineEntity>; }

// ProductLogic.server.ts
ProductEntity.prototype.lines = withQuoted(function (this: ProductEntity): Query<OrderLineEntity> {
    return table(OrderLineEntity).filter(ol => ol.product.id == this.id);
});
```

Registering it as a query TOKEN is `.withExpressionTo(p => p.lines())` on the include (or
`.withExpressionFrom(SourceType, …)` from the other side), and a scalar expression is
`QueryLogic.expressions.register(OrderEntity, o => o.totalPrice(), OrderMessage.totalPrice)`.

A `withQuoted` prototype member is **query-only**: calling it in memory throws, so a module that needs an
in-memory path registers a plain twin function beside it.

### Manual queries

There is no `QueryDescription`. `withQuery()` takes no projection; a MANUAL query is named by its ROW
MODEL (`@reflect class OrderLinesRowModel extends ModelEntity`) and registered with
`QueryLogic.queries.register(RowModel, () => new AutoDynamicQueryCore(() => table(…).map(…)))`. Each
column's caption is that field's own nice name.

### Query tokens

A token is **PascalCase and ROOTLESS** — `ShipAddress.City`, never `Entity.ShipAddress.City`. Build one
with `Type.token(a => a.field)`. Because an altea collection element is a `@part` ROW (Signum's MList
element IS the value), a quantifier takes one extra hop:

```ts
token(a => a.telephones).any().append(a => a.telephone).filter("EqualsTo", "213234")
token(a => a.telephones).any(a => a.telephone).filter("EqualsTo", "213234")   // the same thing
```

`any()` / `all()` / `notAny()` / `notAll()` / `element(i?)` / `count()` / `min()` / `max()` / `sum()` /
`average()` are all on the token builder. `SearchValue` / `SearchValueLine` take a **`valueToken`**: the
single scalar to display instead of the row count (omit it and the control shows `Count`).

---

## The client

| Signum | altea |
| --- | --- |
| `Navigator.addSettings(new EntitySettings(OrderEntity, e => import("./Order")))` | `cb.configure(OrderEntity).withView(() => import("./Order"))` |
| `Finder.addSettings(new QuerySettings(…))` | `.withQuerySettings(token => ({ defaultColumns: [token(a => a.id), …] }))` |
| `Operations.addSettings(new EntityOperationSettings(…))` | `.withOperationSettings(…)` |
| `ValueLine` / `EntityLine` / `EntityCombo` / `EntityDetail` | the same names, under `client/Lines/` |
| `<ValueLine ctx={…} type={…} />` | `<AutoLine ctx={…} />` — a Line reads its type from `ctx.memberType` |
| `EntityTable` over an MList | `EntityTable` over the `@part` row array |
| `ViewOverrides` / `.overrideView(vr => vr.insertAfterLine(…))` | the same: `Navigator.getSettings(T)!.overrideView(rep => rep.insertAfterLine(…))` |
| `findOptions={{ queryName: OrderEntity, filterOptions: [{ token: …, value: … }] }}` | `findOptions={OrderEntity.findOptions(token => ({ filterOptions: [token(a => a.customer).filter("EqualTo", ctx.value)] }))}` |

Two transformer gotchas: `nicePropertyName`'s lambda overload needs an INLINE lambda, and **the
transformer does not rewrite lambdas inside JSX attributes** — pass a route as a string there.

---

## Legacy mode

`LegacyMode=true` in the environment points the ported application at the database the Signum one
generated, so `terminal sync` reads as a migration rather than a rebuild. It is a RUNTIME switch, set on
both tiers, and it is the only reason any of the following exists. See
[`port/LegacyMode.md`](port/LegacyMode.md) for the framework side.

```ts
// starter.server.ts
sb.settings.legacyMode = legacyMode;

// entityOverrides.data.ts — runs on BOTH tiers, before anything is (de)serialized
if (legacyMode) {
    setLegacyMode(true);                 // gates every @legacy* name below
    renameSymbolContainer(AppTypeCondition, "OldAppTypeCondition");
    setLegacyPropertyPaths(true);
}
```

### Legacy names

| Decorator | On | What it overrides |
| --- | --- | --- |
| `@legacyClassName("OldName")` | class | the ROOT: the clean name and the table name both derive from it |
| `@legacyCleanName("OldName")` | class | the clean name alone |
| `@legacyTableName("old_table")` / `@legacyTableName({ wasVirtualMList: true })` | class | the table name |
| `@legacyColumnName("OrderID")` | field | the WHOLE logical column name, `ID` suffix included |
| `@legacyPropertyRoute` / `@legacyPropertyRoute("Signum Name")` | method | the stored PropertyRoute of a `@quoted` method |

`renameSymbolContainer(Container, "OldContainer", { NewMember: "OldMember" })` does the same for a symbol
container's KEY, which is a database value. It THROWS if the container declared no symbol, and it must
run before anything reads a symbol by key.

**Find them by running the sync, not by reading the C#.** Generate the schema with `legacyMode` on, run
`terminal sync` against a copy of the real database, and every line of the script is either a legacy
name you have not declared yet or a genuine difference to raise with the owner.

A rule that is only true in legacy mode stays INLINE in the source — there, Signum's behaviour IS the
specification.

---

## Localization

The XML format is the same, so the Signum application's `*.xml` files are carried over as they are and
then renamed to the new package's `translations/<PascalPackageName>.<culture>.xml`.

What changes is the source side: a `[DescriptionOptions]` message enum becomes a plain object of `msg()`
entries, and the MEMBER NAME is the translation key — so **keep the member names, typos included**:

```ts
export const OrderMessage = {
    totalPrice: msg("Total price"),
    subTotalPrice: msg(),
    // The typo is deliberate: the member name is the KEY the shipped translations already carry.
    discountShouldBeMultpleOf5: msg("Discount should be multiple of 5%"),
};
```

A `@quoted` method is not a PropertyRoute and has no `<Member>` entry of its own — its caption comes
from a `msg()` container, which is what the third argument of `QueryLogic.expressions.register` is for.

Translations live in EACH PACKAGE's own `translations/`; the app's own folder is loaded last, so an app
file wins a collision.

---

## Tests

Port both halves of the Signum application's test suite:

- **logic tests** → `test/logic/`, run with vitest against the generated test database;
- **browser tests** → `test/playwright/`, which address lines, columns and filters with property
  LAMBDAS, so they run COMPILED (`testDir: dist/test`) — build first;
- **the environment** → `test/environment/`, the handful of rows every test asserts against. It is
  deliberately NOT the terminal's data load.

The C# migration tests are not ported: the migrations they cover are already applied.

---

## Checklist per domain

1. `<Domain>.data.ts` — entities, `@part` rows for every MList, enums, mixins, operation symbols,
   messages, `@quoted` methods, `@legacy*` names.
2. `<Domain>Logic.server.ts` — `sb.include(...)` with the operations (the Graph folded in), the queries,
   the registered expressions, the tasks and processes.
3. `<Domain>Client.client.tsx` — `cb.configure(...)`, the view import, query settings, operation settings.
4. `<Domain>.tsx` — the view, line for line.
5. Wire the three bootstrap files, at the end, in dependency order.
6. `pnpm --filter <app> build`, then `terminal <env> sync` against a COPY of the real database and read
   the script. Empty script = this domain is done.
7. Port its tests.
8. Write down everything you would have changed but did not, and ask.
