# Signum.Tour → @altea/altea-tour

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Tour/`

A guided walkthrough of a page: an ordered list of STEPS, each a popover anchored to a CSS selector, played
by driver.js in the client. A tour is addressed by its TRIGGER — the thing it explains: an entity TYPE (its
view), a DASHBOARD, a USER QUERY, or a declared `TourTriggerSymbol`.

## Three pieces went into CORE, where Signum keeps them

- **`TourTriggerSymbol` + `TourTriggerLogic`** (Signum.Basics) — so any module can declare a trigger without
  depending on this extension.
- **`TourButton` / `TourButtonOptions`** — the renderer slot altea-tour fills.
- **`EntityPack.extension` + `registerEntityPackExtension`** (Signum's `EntityPackTS.AddExtension`), NEW in
  core because Signum has it and altea did not: it is how the frame widget knows whether a tour exists
  without a round-trip.

## The entity model

- **no `Guid` field.** Like every other user asset here, the portable identity IS the uuid PRIMARY KEY, so
  Signum's `[UniqueIndex] Guid Guid` and its separate index are gone. The XML `Guid` attribute the importer
  keys on is written from `id` and read back into it by the shared importer.
- **`MList` → `@part` rows twice over.** `Steps` is Signum's `[Ignore] MList` + `WithVirtualMList` — which
  IS altea's `@part` collection — and `CssSteps` (a real MList of embeddeds) becomes `@part` rows too.
  Signum calls the element `CssStepEmbedded`; in altea a collection element is an ENTITY, so the name says
  so. `WithVirtualMList(a => a.Steps, s => s.Tour)` therefore needs no counterpart:
  `sb.include(TourEntity)` already builds the child table off the `@backReference`.
- **a "Property" CSS step points at a `PropertyRouteEntity` row**, as in Signum. It used to store the route
  STRING, because altea had no such table; it does now, so the column is Signum's `property_id` again and
  the `PreDeleteSqlSync` cascade that drops a step whose route was removed is back in TourLogic.
- **the Property selector uses the route's LAST SEGMENT.** altea re-roots the PropertyRoute at each
  embedded it renders, so a Line's `data-property-path` is its OWN member (`city`), not Signum's full
  dotted route (`shipAddress.city`) — the same divergence altea-playwright documents.
- **`cssSelector` lives in the DATA layer**, computed once, so the editor's live preview and the DTO the
  player consumes cannot drift. Signum computes it twice (`ResolveCssSelector` on the server, and again in
  the editor).
- Signum's dashboard cascades use `Database.MListQuery(...).UnsafeDeleteMList()`; here the CssStep rows are
  an ordinary table, so it is `table(CssStepEntity).filter(...).executeDelete()`.

## The client

- **`EntityAccordion` is not ported** (the note altea-email's EmailTemplate carries), so the steps use
  `EntityTabRepeater` — the closest thing with a per-item title.
- **`PropertyRouteCombo` lives in the framework**, which is where Signum keeps it too: it moved out of this
  package once the validation designer wanted it.
- **`MarkdownLine` is the real one now.** It stood in as altea-codemirror's `MarkdownCodeMirror` while
  Signum.Markdown was unported.
- **`getCurrentUserQuery` is altea-user-queries' own augmentation** of `SearchControlLoaded`, derived from
  `extraUrlParams.userQuery`; Signum keeps a dedicated field.
- **`Finder.getQueryDescription` is gone** (no QueryDescription): a user query's own stored columns are the
  choices, which is what a tour step can actually point at anyway.
- driver.js is pinned to Signum's own range (^1.3.1 → 1.3.6) so the popover behaviour is the one the steps
  were authored against.
- `isLite(x)` / `TourTriggerSymbol.isInstance(x)` → `instanceof` (altea's Lite and Symbol are real
  classes); `Navigator.addSettings(new EntitySettings(…))` → `cb.configure(…).withView(…)`;
  `Navigator.API.getType(name)` has no counterpart, so the byEntity route takes the clean NAME and the
  "create a tour for this type" path resolves the TypeEntity through `TourClient.API.typeLite`.
- `ChangeLogClient` is not ported, so no changelog registration.

## The routes and the DTO

- **`GetTriggerType` returns the trigger's CLEAN TYPE NAME**, not a `Lite<TypeEntity>`: the editor only
  ever uses it to look up property routes, which are keyed by the ctor on the client, and a lite would
  just cost a second fetch to read the name back out. (The one place that does need the row takes one more
  call.)
- **the enums travel as their member NAME strings**, lower-cased for `side` / `align` as Signum does —
  they are driver.js's own vocabulary — hence the `Enum.toName`, since altea enums are int-FK in memory.
- the query KEY of a `Lite<QueryEntity>` toolbar target is resolved on the SERVER (a lookup the isomorphic
  layer cannot do) and passed into `cssSelector`.

## XML

altea keeps XML off the isomorphic entity — the (de)serializer registers with `UserAssetsImporter`, as
every other altea user asset does — and the element/attribute names are preserved so a Signum-exported Tour
file round-trips.

`Property` is written as the route's PATH and resolved back through
`PropertyRouteLogic.propertyRouteEntitySync` — the sync form of Signum's
`ctx.GetPropertyRoute(typeEntity, path)`, since `fromXml` cannot await. Same file format either way.

**A `ToolbarContent` pointing at a PermissionSymbol is not supported**: altea's `CssStepEntity` declares
`@implementedBy(QueryEntity)` only, matching what the tour editor can actually pick.

## Known gap: a step's text is not translatable

Signum marks `TourStepEntity.Title` and `.Text` `[Translatable]`, so a tour can be authored once and
translated per instance. **altea marks neither**, and nothing calls
`PropertyRouteTranslationLogic.registerRouteFor` for them either — so a tour reads in the language it was
written in whatever the UI culture is.

Core has the machinery (`@translatable` on the compile-time FieldInfo, used by altea-user-queries'
`displayName` / `description`), so closing this is a two-decorator change plus the routes it adds to the
translatable registry. It is additive — a `TranslatedInstance` row is per route, so nothing existing moves
— but it is a behaviour change rather than a documentation one, which is why it is recorded here instead
of being made in passing.
