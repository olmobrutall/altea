# LINQ test port — surfaced API gaps

From porting 8 LinqProvider files (Where, Select, SelectMany, SelectNested,
OrderBy, TakeSkip, Distinct, SingleFirst, AllAnyContains ≈ 193 test methods).
The point of the TDD-first pass: let the translation reveal the `Query<T>` /
entity API surface. 152 compile errors fall into the buckets below.

## A. Quote-transformer can't capture some JS (changes the test idiom)
These are hard compile blocks — the transformer rejects the syntax inside a
quoted lambda, so the *idiom* must change (not just add API):
- **`x as T` cast** (20×, "Unable to quote AsExpression") — entity/up casts
  can't use `as`. Need a quotable `cast<T>(x)` helper or `instanceof`-narrowing.
- **`x!` non-null assertion** (10×, "Unable to quote NonNullExpression").
- **spread `...x`** (4×) and **block-bodied lambdas `{ … }`** (2×).
→ DECISION: pick the cast idiom; forbid `!`/spread/blocks in quoted lambdas
  (rewrite to `?? `, explicit args, expression bodies).

## B. Lite navigation typing (idiom clarification, no new API)
- `lite.name` / `lite.sex` (30×) — agents navigated a `Lite<T>`'s fields
  directly. `Lite<T>` doesn't expose `T`'s members; go through `.entity`
  (`f.friend.entity.name`). The binder turns lite-nav into a no-op/join.
→ FIX: cheat-sheet rule "navigate a Lite via `.entity`"; re-pass affected files.

## C. PrimaryKey comparability (typing)
- `a.id > 0`, `a.id + x`, `id` → `number` param (12×). `PrimaryKey = string|number`
  isn't `<`/`+`/number-assignable.
→ DECISION: how do queries compare/emit ids? (branded comparable PrimaryKey,
  or a `pk(n)` helper, or relax operators in quoted context.)

## D. Genuine missing API (the real design surface)
1. **Entity collections in queries** (BIGGEST) — `a.songs`, `b.members` are
   `Entity[]` (part-entity arrays). Tests call `.count()/.top()/.distinct()/
   .contains()/.defaultIfEmpty()/.reverse()/.first()/.single()/.sum()/.max()`
   and chained `.filter().map()` on them. Native arrays only have
   some/filter/map/every. → Need entity collections to type as a queryable
   surface (e.g. `Query<T>`) inside quoted lambdas, borrowing Query<T> metadata.
2. **`groupBy` result-selector overload** — Signum `GroupBy(k, g => result)`;
   altea yields `{ key, elements }` only.
3. **`Query.contains(item)` / subquery membership** — `females.Contains(a)`
   (Query<string> vs Query<Entity> variance, 6×).
4. **`Lite.inDB(selector)`** — entity→query bridge (InDBTest pattern).
5. **Polymorphic expression hints** — `.combineUnion()` / `.combineCase()` on a
   polymorphic reference; **expression-properties/methods** (`IsMale`, `Lonely`,
   `AlbumCount()`) via `@quoted`/`withQuoted`.
6. **`DefaultIfEmpty`** (left/outer join in flatMap), **`Reverse`**,
   **collection `.toString(sel, sep)`** aggregate, **`InSql()`** hint,
   **`GetType()`** in query, **indexed `filter`/`flatMap` `(x, i) =>`**,
   **result-selector `flatMap`** `(outer, elem) => …`.

## E. Test-domain modelling gaps
- **CorruptMixin not modelled** in `music.ts` (3×) — WhereMixin* / Select mixin
  tests need it.

## F. Downstream `implicit any`
- 20+ params typed `any` — fallout of the index/result-selector overloads and
  `as any` casts above; resolves once D/A are decided.

---

# Full backlog (all 26 ported files) — the translator's red→green targets

RESOLVED this phase: entity-collection operators (globals.ts), `x as T` / `x!`
(transformer), `Entity`/`Lite.is()`, lite-nav via `.entity`, `(a.id as number)`.

OUTSTANDING, grouped (each is a `// TODO(api)` somewhere in test/):

**Query operators / shape**
- `groupBy` result-selector overload `(k, g) => r`; `where`/`filter` over a grouping; `flatMap` over a grouping; empty-key group (whole-table aggregate).
- `flatMap` index `(x,i)=>` and result-selector `(outer,elem)=>` overloads; indexed `map`/`filter`.
- `defaultIfEmpty` / GroupJoin / LEFT·RIGHT·FULL OUTER join; `Query.reverse`; parameterless `orderBy()`; `Query.contains(item)` + subquery-membership variance (`Query<string>`→`Query<Entity>`).
- collection no-arg `.some()` (C# `Any()`), collection `.toString(sel, sep)` aggregate, per-row collection sub-aggregates in a projection.

**Polymorphism / types**
- `is Lite<T>` runtime test in query. (DONE: `Ctor.isLite(lite)`, `Ctor.isInstance(entity)`, `lite.isInstanceOf(Ctor)` — real type-tests, consistent in query and in memory. The `x instanceof Ctor` operator does a real test on an ENTITY ref; on a LITE it is constant `false` both in query and in memory — matching JS, since a lite is never a runtime instance of the entity — so use `isInstanceOf`/`isLite` for a lite. Also `GetType()` / `typeof(X)` compare / `Type.FullName`/`NiceName` / `ToTypeEntity` / `Lite.entityType`.)
- Interface **upcast** works (`x as IAuthorEntity` / `as Lite<IAuthorEntity>` — an unregistered interface resolves to a null cast type, so the binder treats it as identity). Interface-typed `@implementedBy` **references**, `combineUnion()`/`combineCase()`, and `@quoted` interface **members** — both through a concrete cast (`(ArtistEntity)x).fullName()`) AND directly off the polymorphic combine (`a.author.combineUnion().fullName()`/`.lonely()`, `SelectPolyExpressionPropertyUnion`/`…MethodUnion` + Case variants) — all work. Still missing: `Cast<T>()` / `OfType<T>()` query operators.
- Lite **downcast** projection (`x as Lite<ArtistEntity>`). (DONE: `is Lite<T>` runtime-type test → `Ctor.isLite(lite)`; entity type-test → `Ctor.isInstance(entity)` — both static methods on Entity, work in memory and in query.)
- `IsNew` flag in query; `Lite.id`/`toString` of an `@implementedByAll` ref.

**Expression members / functions**
- `@quoted` expression-properties/methods on entities (`IsMale`, `Lonely`, `AlbumCount`, `FriendsCovariant`).
- SQL string fns beyond JS (`Like`, `Start/End/Reverse/Replicate`, `Before/After/Try*`), `InSql()` hint.
- DateTime/Date/TimeSpan: part-extraction, truncation, conversions, diffs, `Clock.Now`/`Today`, `new DateTime/DateOnly/TimeOnly/TimeSpan` literals; `Math.*`; `DayOfWeek`.

**Entity/ORM bridges**
- `InDB(selector)` / `Lite.InDB()` entity→query bridge; `Lite.RetrieveAndRemember`; `Lite` custom model/`toLite(model)` + LiteModel projection; `ExpandLite`/`ExpandEntity` eager-load hints; `EntityContext.EntityId`/`MListRowId`.
- Mixin in query (`mixin(M).field`); `CorruptMixin` not modelled; `Database.View<T>()`; `MListQuery` (link-row access). (DONE: `WithHint` — SQL Server table hint, `.withHint("NOLOCK")`; dropped on Postgres.)

**Bulk DML (delayed tier)** — `executeUpdate(u => u.set(sel, val))` (+ `UpdatePart`/`UpdateMList`/`UpdateView`), `executeInsert(Target, row => {...})` (+ `setReadonly`, `InsertMList`), `executeDelete()` (+ chunks/`MList`/`View`). Shapes captured in the unsafe*.test.ts headers.

**Materialisation** — deep retrieval-completeness assertion (Signum `AssertRetrieved`) for retriver.test.ts.
