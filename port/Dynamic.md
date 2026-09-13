# Signum.Dynamic → @altea/altea-dynamic

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Dynamic/`

Define parts of the application FROM the running application. The module ports **whole** — both halves.

## The two halves, and the question that divides them

Does the feature need a COMPILER?

**INTERPRETED** — `DynamicView` / `DynamicViewOverride` / `DynamicViewSelector` (a view is a JSON node TREE
plus small JavaScript snippets the client interprets), `DynamicCSSOverride` and `DynamicSqlMigration` (both
plain text). Nothing is compiled, so these port as-is.

**COMPILED** — `DynamicType`, `DynamicExpression`, `DynamicValidation`, `DynamicApi`,
`DynamicTypeCondition`, `DynamicMixinConnection`, `DynamicIsolation`. These do what Signum does: GENERATE
source into a `CodeGen` directory, compile it, load it, and restart so the new types take part in the
schema (then a `sync` for their tables).

Which pieces GENERATE and which merely EVALUATE is not a port decision — it follows from what each needs,
and Signum answers the same way. An expression and a type condition must reach the LINQ provider as TREES,
a mixin's fields must be COLUMNS before the schema is built, and a route must exist before a request
arrives: those four are generated. A VALIDATION is asked about an entity in hand, so it is an
`EvalEmbedded` on @altea/altea-eval. (DynamicTypeCondition and DynamicApi carry an EvalEmbedded too, but
only so the editor can compile and test the script.)

## Why the compiled half is possible at all

The quote-transformer's factory takes a `ts.Program` and returns an ordinary `ts.TransformerFactory`, so it
composes into `program.emit` exactly as it does under `tspc`. `DynamicCodeCompiler` does that.

Putting it in the emit pipeline is **not optional**: the transformer is what synthesises
`@field({ typeName … })` from a type annotation, stamps `__fileInfo`, rewrites `init()` with its key, and
turns a `@quoted` lambda into the expression tree the LINQ provider lowers. Generated code that skipped it
would compile and then be invisible to reflection and unquotable in a query.

## The emit is ESM, and loading is `import()`

Not interchangeable, for two independent reasons:

- TypeScript's **CommonJS** module transform ELIDES an import a `before` transformer synthesised, so the
  module compiles and then dies on `field is not defined`.
- `import()` is what makes a generated module share module IDENTITY with the process — Node keys its ESM
  cache by resolved URL — so a generated type registers into the reflection registries the SERVER reads.

Roslyn's `MetadataReference` list therefore becomes ordinary resolution, with no allow-list to maintain,
and finding the generated starter is a plain import where Signum reflects over the loaded assembly for a
type named `CodeGenStarter`.

**An APP's own modules need `typesRoots`, pointing at its DIST.** Nothing depends on an app, so TypeScript
cannot resolve `eastwind/app/orders/Order.data`; `dist` carries the `.d.ts` beside the `.js`, so one directory
serves checking and loading exactly as a published package does (a source root type-checks and then fails
at load). The emitted specifier for such a package is RELATIVE — `DynamicCodeCompiler.specifierFor` is the
single place that decision lives — because Node cannot resolve a bare `eastwind/…`.

## A compile failure is DATA, not a throw

`DynamicLogic.codeGenError` carries it so the server still BOOTS — otherwise a bad definition could only be
fixed in the database by hand — and every later step checks it first, as Signum's do.
`registerExceptionIfAny` warns, **including that a `sync` would now script the missing types as DROPs**.
`/api/dynamic/compilationStatus` and the `/dynamic/panel` page are how an author sees it, since the
diagnostics exist only in the process that tried.

One distinction Signum does not make: a READ failure (the definitions could not be read at all, e.g. an
altea app pointed at a Signum database) is not a compile failure — nothing was generated, so there is
nothing to report to the Exception table, which may not even be reachable yet.

## Reading the DynamicType rows must tolerate a type-cache mismatch

`StartParameters.withIgnoredDatabaseMismatches`. The read needs TypeLogic's type↔id caches, and building
those compares the database's `type` rows against the schema's types — but at that moment the schema
deliberately lacks the dynamic types, since generating them is what the read is FOR. The real check still
runs at `schema.initialize()`.

Signum needs none of this: its type cache is built in `Schema.Initialize`, after `Start`.

## The definition read PROJECTS

Reading the whole `DynamicTypeEntity` makes the definitions unreadable the moment an optional MIXIN adds a
column to `dynamic_type` (DynamicIsolation's does) — raised at exactly the point the definitions are needed
to BUILD the schema, and a schema built without them scripts every dynamic table as a DROP.

So `getTypes()` selects the four columns that are always there, and `DynamicIsolationLogic.strategies` does
its own tolerant read (warn, treat everything as None) so the `sync` that adds the column can run. That
column stores the strategy's NAME where Signum stores its enum ordinal: altea's `IsolationStrategy` is
deliberately a string union, and giving that module a reflected enum for one consumer would add an enum
table and touch every comparison in it.

## The generator: what the generated code SAYS

The SHAPE is Signum's — two generator classes with the same names and the same methods in the same order,
so a change upstream is easy to re-apply. What differs is the output:

- **a C# `using` list becomes an IMPORT MAP, and it needs no configuration.** A registered type already
  knows the module that declares it (the transformer stamped `__fileInfo`), so `getLocation("OrderEntity")`
  yields `@altea/altea-…/data/Order`. Signum's `EvalLogic.Namespaces` has no counterpart at all.
- a `namespace` block becomes a MODULE. Nothing nests, so the indent bookkeeping goes.
- one attribute per DECORATOR LINE rather than a packed `[…, …]` group — what altea's own code looks like,
  and what a diff wants.
- a backing field + Get/Set pair becomes ONE plain property. altea tracks changes with a SNAPSHOT, so there
  is nothing for a setter to notify — which also retires `NotifyChanges` / `[BindParent]`.
- **an operation symbol is written `init()`**, and the transformer fills in the key. Signum must spell out
  `OperationSymbol.Execute<XEntity>(typeof(XOperation), "Save")` because C# cannot see the member name.
  The clearest illustration of why the transformer belongs in the emit.
- **`MList<T>` becomes a generated `@part` ROW type plus a `T[]`** — the one place this generator does
  structurally more work than Signum's. A collection of values or lites is child rows carrying a
  `@valueField`, and `DynamicTypeBackMListDefinition` (TableName / PreserveOrder / OrderName /
  BackReferenceName) describes that row table one for one.
- `ToStringExpression` becomes a `@quoted toString()` — one decorator where Signum has a static
  `Expression<Func<…>>` field plus `[ExpressionField]` plus an `Evaluate(this)` body.
- `IsTreeEntity` means the same thing, but Signum's `TreeOperation.CreateRoot` branch is left out:
  @altea/altea-tree's `withTree` owns those and generated code must not re-register them.

## No `CodeGenExpressionMessage`, and no `ColumnDisplayName`

altea takes a column's caption from the member's own `@niceName`, and there is no QueryDescription to hang
a display name on — so Signum's generated caption enum, `RegisterComplexQuery`, `ColumnDisplayName` and the
`GetAlreadyTranslatedExpressions` / `GetFormattedExpressions` pair are all unported. `queryFields` are
CLIENT default columns, because the server's `withQuery()` takes no projection — so the designer's query
tab lists member NAMES, not `e.Id`-style projection lines.

## The stored definition round-trips with Signum

`isNullable` / `uniqueIndex` inside the JSON are the member NAMES, as Signum's `JsonStringEnumConverter`
writes them; the `DynamicValidator` union's member names are Signum's for the same reason. A numeric altea
enum would have been wrong twice over — the definition would stop round-tripping, and the JSON column is
not a reflected field anyway. Only `DynamicBaseType`, which IS a real column, is an altea enum.

## `DynamicMixinConnectionEntity.entityType` is a PLAIN reference

As every other `Lite<TypeEntity>` in the workspace is. It carried a single-implementation
`@implementedBy(() => [TypeEntity])` that nothing recorded a reason for, and that costs two things a Signum
database sees: the column takes the implementation suffix (`EntityTypeID_Type`) and the polymorphic
always-nullable default, where Signum has a NOT NULL `EntityTypeID`.

The visible symptom was the definition read FAILING against a Signum database — *column
`dmc.entity_type_id_type` does not exist* — so every Southwind sync was built from a schema with NO dynamic
types, exactly the state that scripts every dynamic table as a DROP. The table now matches Signum column
for column (500 → 492 statements).

**An existing altea database needs a `sync`, and this is the case the "run it TWICE" rule is for**: the
first sync cannot read the definitions (the model wants the new column, the database has the old one), so
its script carries the column change AND a DROP of every dynamic table. Apply the column change alone —
answering the rename prompt makes it a `RENAME COLUMN`, so no row loses its type — then re-run the sync and
apply that one.

## `globalValidators` — the one core seam this module forced

`data/reflection`, Signum's `Validator.GlobalValidation`: the one thing a per-field decorator cannot
express, a rule chosen at RUNTIME for a type the rule's author does not own. It runs after the declared
validators and before the field's own `customValidation`, first message wins, and an async result is
honoured on every server path and skipped on the client's live pass (as `customValidation` already is).
`@altea/altea/data/reflection` also became an eval-visible framework module, since a validation script is
handed a FieldInfo.

A validation's `SubEntity` IS a `PropertyRouteEntity` (see CLAUDE.md), but its APPLICABILITY test stays a
route PREFIX rather than Signum's `PropertyRoute.MatchesEntity(mod)`, because altea re-roots a route at each
embedded. **A cascade Signum lacks:** Signum registers the PropertyRouteEntity `PreDeleteSqlSync` for Tour,
Help and TranslatedInstance but not for DynamicValidation, so a sync that removes a route a validation
points at fails on `sub_entity_id`'s foreign key. Fixed rather than mirrored.

## The interpreted half

It forced `Navigator.ViewDispatcher` / `BasicViewDispatcher` / `setViewDispatcher` (altea resolved views
inline, with a `// TODO: real ViewDispatcher` where the seam belonged), and `applyViewOverrides` now asks
the DISPATCHER for overrides so a module can contribute them for a type it does not own.

The node library's **node NAMES, their JSON member names, the node interface and the group/order that
decide the "add node" menu are kept EXACTLY as Signum has them** — that is what lets a `viewContent` JSON
written against Signum load here. Divergences are in what a node reaches for:

- `PropertyRoute.add` THROWS on an unknown member where Signum's `tryAddMember` returns undefined, and a
  half-typed field is normal in a designer — hence a local try-variant.
- `asFunction`'s `thisObject` (Signum passes the frame's entityComponent so a snippet can use `this`) has no
  counterpart: a snippet that used `this` in Signum uses `locals` here.
- operations are per-ROLE metadata, so the operation list comes from `Operations.operationInfos(ti)` rather
  than `ti.operations`; an altea enum is a numeric object, so `EnumType.values()` is `Enum.values(X)`.
- there is no icon picker, so an icon is typed as text.

## Other divergences

- **a DynamicApi script is a FUNCTION THAT REGISTERS ROUTES**, not a controller-class body (altea has no
  controllers), which retires `IDynamicApiEvaluator.DummyEvaluate` and the second controller assembly.
- **`DisabledMixin` does not exist**, so `isDisabled` is a plain field keeping the mixin MEMBER's name —
  hence Signum's own `IsDisabled` column, on DynamicApi and DynamicValidation alike.
- **`DynamicIsolation` is OPT-IN, off by default.** @altea/altea-isolation refuses to start unless EVERY
  table declared a strategy, so generating `Isolation.register` calls for an app that never started it
  would commit it to that assertion by accident. Signum has the same hazard and the same answer.
- **the SQL-migration renames: three of Signum's five strategies port.** Tables, Columns and Enums are
  keyed by buckets altea has; the other two name Signum concepts with no counterpart. Applying a script is
  what the terminal's `synchronize` does, where Signum executes statement by statement through its own
  console.
- **`DynamicViewLogic.getSuggestedFindOptions` walks the TOKEN TREE**, not Signum's field recursion — the
  same set of columns, fewer moving parts, and it covers an `@implementedBy` field for free where Signum
  needs a separate `FieldImplementedBy` branch. The tokens are ROOTLESS (CLAUDE.md).
- **no RESTART button** on the panel: Signum's restarts the ASP.NET host in place behind a supervisor,
  which Node has no convention for. `DynamicPanelPermission.RestartApplication` IS ported and the page says
  plainly that a restart is needed.
- **`TypeHelp` is not ported** (the honest equivalent is editor IntelliSense over the same `.d.ts`), so the
  type combo is a text box with a datalist and the "property template" modal is gone;
  `TypeHelpComponent`'s one needed function is `client/View/FieldExpression.ts`.
- the panel gates on `EvalPanelPermission.ViewDynamicPanel` (@altea/altea-eval), where Signum keeps it, and
  `EvalClient.Options.registerDynamicPanelSearch` becomes `DynamicClient.registerDynamicPanelSearch` —
  altea-dynamic owns the admin pages.

> **Stale notes corrected.** The module's own entry point carried a 36-line header asserting the exact
> opposite of what the module does, and it had ALREADY been corrected in the app's CLAUDE.md and in this
> package's own `data/DynamicPanel.ts` while `server/DynamicLogic.ts` went on saying the old thing:
>
> - it listed the seven COMPILED features as "NOT ported" and called them "a design project, not a port" —
>   in the file whose `compileDynamicCode` compiles them.
> - it said "Signum.Eval does not port either (it IS the Roslyn host)". @altea/altea-eval is ported, and
>   this module depends on it.
> - it said `DynamicPanelPermission.RestartApplication` "is dropped: there is no compilation step to
>   restart for" — 81 lines above the `PermissionLogic.registerPermissions` call that registers it.
>
> The same false premise had spread to three more headers, each re-homing something for the stated reason
> that "Signum.Eval does not port": `client/DynamicClient.tsx` and `client/DynamicViewClient.tsx` on the
> panel search registry, and `client/View/FieldExpression.ts` on `getExpression`. All three re-homings are
> right; the reason is not. TypeHelp is what does not port, and this module owns the admin pages.
>
> Two of them were parity gaps rather than only wrong sentences, and both are now CLOSED:
>
> - `client/View/GlobalModules.ts` said "`TreeClient` is dropped: Signum.Tree is not ported". The key is
>   offered now, and `@altea/altea-tree` is a static dependency of this package — as `@altea/altea-auth` is
>   for `AuthClient`, and as Signum's own `GlobalModules` imports `TreeClient` directly. See
>   [OpenQuestions.md](OpenQuestions.md) §2.2 for the registration-seam alternative and why it lost.
> - `client/View/Nodes.tsx`'s `appropiateComponent` said "altea has no notVisible", where
>   `FieldInfo.notVisible` had landed with the altea-tree port. It skips `notVisible` now, making the
>   designer the third consumer after `AutoComponent` and `EntityTable`'s default columns.
