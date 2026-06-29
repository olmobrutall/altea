# Porting Signum LinqProvider tests → altea-test

Each file in `old/Framework/Signum.Test/LinqProvider/*.cs` becomes
`altea/altea-test/test/<name>.test.ts`. Goal of this phase: **lock a stable
`Query<T>` API** by translating every test so the suite *compiles* (the
quote-transformer runs under `tspc`). Tests run live only with `ALTEA_TEST_DB`
set; until the translator lands they SKIP, so compile-clean is the bar.

Reference file: `where.test.ts`. Match its structure exactly.

## Idiom (C# → altea)

| C# (Signum) | altea |
|---|---|
| `Database.Query<AlbumEntity>()` | `table(AlbumEntity)` |
| `.Where(a => …)` | `.filter(a => …)` |
| `.Select(a => …)` | `.map(a => …)` |
| `.SelectMany(a => a.Coll)` | `.flatMap(a => a.coll)` |
| `.OrderBy/.OrderByDescending` | `.orderBy/.orderByDescending` |
| `.ThenBy/.ThenByDescending` | `.thenBy/.thenByDescending` |
| `.Take(n)` / `.Skip(n)` | `.top(n)` / `.skip(n)` |
| `.Distinct()` | `.distinct()` |
| `.Count(pred?)` | `await .count(pred?)` |
| `.Any(pred?)` / `.All(pred)` | `await .some(pred?)` / `await .every(pred)` |
| `.Sum/.Min/.Max/.Average(sel?)` | `await .sum/.min/.max/.avg(sel?)` |
| `.First/.FirstEx(pred?)` | `await .first(pred?)` |
| `.FirstOrDefault(pred?)` | `await .firstOrNull(pred?)` |
| `.SingleEx(pred?)` | `await .single(pred?)` |
| `.SingleOrDefaultEx(pred?)` | `await .singleOrNull(pred?)` |
| `.ToList()` / `.ToArray()` | `await .toArray()` |
| `.GroupBy(k)` / `.GroupBy(k,e)` | `.groupBy(k)` / `.groupBy(k, e)` → `{ key, elements }` |
| `.Join(other,k,ok,res)` | `.join(other, k, ok, res)` |
| `new { a.Year, X = a.Foo }` | `({ year: a.year, x: a.foo })` (camelCase!) |
| `Tuple.Create(a, b)` | `({ item1: a, item2: b })` (object literal) |
| `a.Author.ToLite()` | `a.author.toLite()` |
| `a.Is(b)` / `lite.Is(x)` | `a.is(b)` / `lite.is(x)`  (added: Entity/Lite `.is(Entity\|Lite\|null)`) |
| `a.Author == michael` | `a.author.is(michael)`  (prefer `.is`; `==` on entities is reserved for the binder) |
| `x is ArtistEntity` | `x instanceof ArtistEntity` |
| `(PersonalAwardEntity?)x` cast | `// TODO(api): entity cast` — translate as `(x as PersonalAwardEntity)` and flag |
| `a.GetType()` | `// TODO(api): GetType` — use `a.constructor` and flag |
| `n.Mixin<CorruptMixin>().Field` | `n.mixin(CorruptMixin).field` (`.mixin<M>()` cast exists) |
| `Sex.Female` (enum) | `Sex.Female` |
| `a.Sex.ToString()` | `// TODO(api): enum toString in query` — write `a.sex.toString()` and flag |
| `$"Hi {x}"` interpolation | `// TODO(api): string interpolation` — write a `+` concat and flag |
| `a.Name.Contains("x")` | `a.name.contains("x")` (needs `import "@altea/altea/entities/globals"`) |
| `females.Contains(a)` (subquery) | `await … ` inside lambda → `table(...).filter(...).some(...)` etc. |
| `.QueryText()` | `.queryTextForDebug()` (sync) |
| `Assert.Equal(a,b)` / `Assert.True` | `assert.equal(a,b)` / `assert.ok(x)` (node:assert/strict) |
| `Assert.Throws<T>(() => …)` | `await assert.rejects(async () => …)` |

## File skeleton (copy from where.test.ts)

```ts
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { Connector } from "@altea/altea/logic/connection/connector";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // only if string methods used
import { hasDb, start } from "./setup";
import { /* entities + enums used */ } from "../entities/music";

describe("<TestClassName>", { skip: !hasDb }, () => {
    // start() connects + sets Connector.default (no data load — the sample graph
    // is generated once by `gen:*`); terminals run directly, no wrapper.
    before(async () => { await start(); });

    // C# original as a comment above each test
    test("<MethodName>", async () => {
        const list = await table(AlbumEntity).filter(a => a.year < 1995).toArray();
        assert.ok(Array.isArray(list));
    });
});
```

## Quote-transformer limits (idiom rules — learned from batch 1)
A quoted lambda body is a single expression the transformer captures. It now
SUPPORTS `x as T` casts and `x!` non-null assertions. It still CANNOT capture
`...spread` or block bodies `{ … }`. Inside `filter`/`map`/etc. lambdas:
- **Navigate a `Lite<T>` via `.entity`** — `Lite<T>` does NOT expose `T`'s
  fields. `a.member.entity.sex`, not `a.member.sex`. (The binder makes lite-nav
  a no-op/join.)
- **`x as T` casts ARE supported** — use them for entity downcasts
  (`(a.lastAward as PersonalAwardEntity)`) and to type a `PrimaryKey`:
  **`(a.id as number) > 1`**, `(a.id as number)` wherever an id is used as a
  number. The target type is carried as a name string (primitive or entity).
- **`x!` is supported** (transparent — type-only).
- **No spread / no block-bodied lambda** → expression bodies only; else skip+flag.
- **Entity collections** (`a.songs`, `b.members`) now have the query operators
  (`top/skip/distinct/orderBy/count/sum/min/max/first/single/contains/...` via
  globals.ts) — use them directly; `defaultIfEmpty`/`reverse`/result-selectors
  are still gaps → skip+flag.
- **`CorruptMixin` is NOT modelled** (deliberately deferred). Tests using it:
  `{ skip: true }`, body fully commented out, `// TODO(api): CorruptMixin`.
- **PrimaryKey** (`a.id`) is `string|number` — cast at use site:
  `(a.id as number)` for compares/arithmetic, `(a.id as string)` for concat.

## Rules
- Entity field names are **camelCase** in altea — check `../entities/music.ts` for the exact names (e.g. `Year`→`year`, `LastAward`→`lastAward`, `Author`→`author`, `Members`→`members`). Collections that were `MList` are part-entity arrays (e.g. `Band.Members` → `band.members`, elements have a `.member` value field — see music.ts).
- All terminals are **async** → always `await`.
- Keep the C# test method order; put the original C# one-liner as a comment above each.
- If a test uses a feature with no altea API yet, **still write the most natural altea form**, mark it `test.skip(...)` or add `{ skip: true }`, and put a `// TODO(api): <what's missing>` comment. Do NOT invent new entity/Query methods beyond the table above.
- Lambdas passed to `filter/map/...` are auto-quoted by the transformer — write them as plain arrows, no `@quoted`.
- Assertions on data: replicate Signum's assertions where present (counts, names). Where the C# test only builds+executes without asserting, just `await` it and `assert.ok(Array.isArray(list))`.
- Do not run any build; just write the `.ts` file.
