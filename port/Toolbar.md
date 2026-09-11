# Signum.Toolbar → @altea/altea-toolbar

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Toolbar/`

A Toolbar is a user-authored, XML-portable NAVIGATION BAR: an ordered list of elements (headers, dividers,
items, extra icons), each pointing at a query, a saved user asset, a permission-gated custom block or a raw
URL — or at ANOTHER toolbar entity (a ToolbarMenu → a collapsible group, a ToolbarSwitcher → a
pick-one-of-N dropdown, a nested Toolbar → inlined). Its `location` decides where it renders: the sidebar
(Side), the navbar (Top) or a page of cards (Main).

Most of the client is a faithful port whose only differences are import paths and altea's method-vs-property
spellings (`lite.key()`, `lite.toString()`, `token.fullKey()`). What follows is what actually differs.

## THREE roots and an abstract element base

Signum has one `ToolbarElementEmbedded` reused by two owners, with `ToolbarMenuElementEmbedded` subclassing
it to add WithEntity / AutoSelect. An altea `@part` row carries its OWN `@backReference` to its single
owner, so it cannot be shared: the common members move up into an ABSTRACT base
(`ToolbarElementBaseEntity`, no table) and each owner gets a concrete row type —
`ToolbarEntity_Element` / `ToolbarMenuEntity_Element`. Client code that treats both uniformly types against
the base, and the element TABLE component is generic over the row type where Signum could type it as the
base.

Consequently a row is constructed through `Constructor.construct(ctor, props)` with the ctor taken from the
collection's PropertyRoute, so the right row type is created for each owner — Signum's `New(type, {…})` is
an untyped factory over a clean name.

The three root entities and the element rows are all `@primaryKey("uuid")`: the id IS the portable identity
the XML keys on, and for a row it is also what the client addresses an element by (see
`ToolbarClient.entityElementFilters`). See [UserAssets.md](UserAssets.md) for why that matters.

`StateValidator<ToolbarElementEmbedded, ToolbarElementType>` — a declarative per-state must-be-set /
must-be-null matrix — has no counterpart; the same rules are explicit `@validate`s, keeping Signum's message
keys. `IToolbarEntity.GetSubToolbars()` IS ported, as a method on each root entity, and it drives the cycle
check on save.

## The wire model is declared ONCE

Signum declares the response twice: as C# classes (`ToolbarResponse` / `ToolbarExtraIcon` /
`ToolbarResponseBase` in ToolbarLogic.cs) and again by hand as a TS interface in ToolbarClient.tsx. altea is
one language, so `data/ToolbarResponse.ts` is the single declaration — the server builder produces those
shapes and the client renderers consume them. Member names match Signum's JSON exactly, so the ported
renderers read unchanged.

It is a DTO rather than the entities because the response is a DERIVED view: sub-toolbars are inlined,
unauthorized elements and the dividers / headers they orphan are dropped, and each element's label / icon /
related query are resolved from its content's registered ToolbarContentConfig.

## Where the checks run

Signum runs its element checks and the recursion check from `EntityEvents<T>.Saving`. altea's `saving` event
is SYNCHRONOUS (no sync DB access) and the recursion check must READ the referenced toolbars — so the
element checks moved to owner-level `@validate`s (they need no DB) and the recursion check runs inside the
Save operation's `execute`. Every save goes through the registered Save operation, the XML importer
included, so the coverage is the same.

`registerDelete<T>` is a SQL-SYNC cascade in Signum (`WithCascadeDeleteMListBy` + `PreDeleteSqlSync` +
`UnsafeDeletePreCommandMList`). There are no MList tables here — an element is a `@part` ROW — and no
`Administrator.unsafeDeletePreCommandMList`, so the port hangs off the `preUnsafeDelete` event and deletes
the orphaned element rows itself.

The response builder is ASYNC throughout, because authorization is. Visibility uses
`UserAssetOwnerAuth.filterVisible` rather than `Schema.Current.GetInMemoryFilter<T>(userInterface: false)`,
applied by each lookup because the caches are filled in `ExecutionMode.global`, where the row-level query
filter never ran — the same pattern altea-dashboard and altea-user-queries use.

## The routes carry no permission, deliberately

Neither framework asserts one: a toolbar has no permission of its own. What a caller may see is decided per
ELEMENT inside the response builder (every element's content config is asked `isAuthorized`), plus the
row-level owner scoping on the toolbar itself. An anonymous or unauthorized caller gets `null` or a pruned
tree.

`/api/toolbarMenu/:menuId` takes the menu's uuid PK. The `location` route parameter is the enum's member
NAME (the wire form), which `ToolbarLogic.getCurrent` converts.

## XML

The three roots register a (de)serializer with `UserAssetsImporter`, as UserQuery and Dashboard do — XML
stays off the isomorphic entities. Element and attribute names are preserved so a Signum-exported file
round-trips.

- the `Guid` attribute Signum writes for each root IS its `id` here, so `ctx.include(x)` returns exactly
  that; the ELEMENT rows keep their own `guid` attribute, and it is their primary key.
- element rows are matched through `syncRows` — BY ID, never by position. (This page used to record a plain
  rebuild of the row list; that was true before the row-uuid work and is not any more.)
- Signum's `Content` attribute is polymorphic: a QUERY key, a PERMISSION key, or the GUID of an included
  user asset. That three-way discrimination is preserved, guid first, then query, then permission.

## Client divergences worth knowing

- **`QueryDescription` is gone**, so `SearchToolbarCount` reads the entity types behind a query from its
  ROOT TOKEN (`Finder.getQueryRoot`), whose `type` is the one shared TypeReference — `typeInfos()` gives
  the same list Signum split out of `qd.columns["Entity"].type.name`.
- **`res.content!.entityType` is a CTOR**, not a clean-name string, so type tests are
  `res.content?.entityType === ToolbarMenuEntity` and lookups go through `cleanTypeName`. Same for
  `config.type` in the content-config registry, which keys off the ctor's clean name.
- **Lines read their type from `ctx.memberType`**, so `EntityLine`'s explicit `type={{ name, isLite: true }}`
  prop is gone — the entity picker binds through a `TypeContext` built from the type's PropertyRoute. For
  the same reason an `@implementedBy` Lite belongs to `EntityLine` rather than `AutoLine`, which is what
  the switcher's `owner` uses.
- **`IconTypeaheadLine` → a plain `TextBoxLine`**, the substitution the dashboard editor already made: the
  stored format is identical (`IconHelpers.parseIcon`).
- `a.modified = true` (a manual dirty flag) is dropped: dirtiness is tracked by snapshot.
- `isExternalLink` compares against `AppContext.baseName`, where Signum reads `window.__baseName`.

### Deferred

- **`typeAllowedInDomain(queryKey, entity)`** inside `simplifyForEntity`, and the
  `useDocumentEvent("typeInDomains", …)` that feeds it. It needs Signum's client-side "type conditions in
  domain" feed, which altea has not ported. The `queryKey` the server already sends is kept, so the check
  drops in unchanged when that lands; until then a with-entity element is shown for every entity of the
  menu's type.
- `[Translatable]` on Name / Label, with the rest of instance translation (the dashboard port's deferral):
  the raw stored text is shown, and `PropertyRouteTranslationLogic.TranslatedField` / `TranslatedMList` are
  not called.
- `AuthLogic.HasRuleOverridesEvent` (a role has toolbar overrides) has no analogue yet; the source notes
  where it belongs.
