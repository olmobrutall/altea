# Legacy mode — reading a database Signum generated

`SchemaSettings.legacyMode` makes altea name and shape things the way Signum names and shapes them,
wherever altea's own convention would otherwise diverge for no reason but taste. A `terminal sync` against
a Signum-generated database then reads as a MIGRATION (the model differences) instead of a rebuild (every
table renamed), which is what makes migrating an application — or running both frameworks against one
database — practical.

Like `isPostgres`, it is a SCHEMA-BUILD choice the APP makes before including any table, and the app is
what knows where the answer comes from (eastwind reads a `LegacyMode` environment variable in its Starter,
beside `isPostgres`). The default is altea's own naming.

Two standing rules:

- **Every legacy accommodation is gated on this one flag**, never on a second flag of its own.
- **Reading only.** Where the two frameworks would write different values, altea writes ALTEA's — a token
  altea stores must stay resolvable by a Signum deployment reading the same row. Legacy mode widens what
  altea ACCEPTS; it does not change what altea emits. (The naming rules below are the exception that
  proves it: a physical name is not a value, and both frameworks must agree on it or neither can read the
  other's tables.)

Signum's wider clean-name suffix strip is NOT one of these — altea adopted Entity + Symbol as its own
rule, unconditionally; see `cleanTypeName` in `data/registration`.

---

## What it covers

### Physical naming

| # | Rule | Where |
| --- | --- | --- |
| 1 | A `@part` row table joins to its owner with a SINGLE underscore on Postgres, not a double one — `role_inherits_from`, not `role__inherits_from`. Inert on SQL Server, which produces neither. | `physicalTableName` |
| 2 | A COLLECTION row is named after the owner's table plus the collection PROPERTY, not after the row entity — `user_query_columns`, not `user_query_column`. Composed from the NameSequence down the property route, so a collection declared inside an embedded contributes both members (`application_configuration_azure_ad_role_mapping`). Recurses through `settings.tableName`, so a part owning a part composes, and an app's override is respected. | `legacyCollectionTableName` |
| 3 | `@legacyTableName("WordTemplate")` — a declared Signum NAME wins over both derived rules. An OVERRIDE: a type that declares `@legacyClassName` already derives its Signum table name from it (rule 5), so this is for the table that does not follow. | `SchemaSettings.tableName` |
| 4 | `@legacyTableName({ wasVirtualMList: true })` says Signum has NO MList table for the collection holding this type (it modelled it as a standalone Entity behind a virtual MList), so rule 2 stands down and the ordinary derived name is right. | `mlistRowOwner` |
| 5 | `@legacyClassName("WordTemplateEntity")` — the C# CLASS name Signum has for a type altea renamed, and the ROOT of the three names: the CLEAN name follows by stripping the kind suffix, the TABLE name follows from that. Declared because Signum STORES it (`TypeEntity.className`) and keeps synchronizing that column back to its own answer. | `legacyCleanNameOf` / `classNameOf` |
| 5b | `@legacyCleanName` — an OVERRIDE of the clean name rule 5 derives, for the type whose two Signum names do not follow the ordinary suffix rule. | `data/decorators` |
| 6 | An MList table follows its OWNER's schema, whatever package the element type is declared in — Signum's `GenerateTableNameCollection` takes the schema from the owner and never asks where the element came from. Only shows where the two differ (`AzureADRoleMappingEmbedded` is declared in `auth` but held by the app's own configuration, so Signum's table is `public.application_configuration_azure_ad_role_mapping`). | `schemaForType` |
| 7 | `@legacyColumnName("ResourceOperationID")` — the LOGICAL name Signum gives a field's column, for a field altea models differently but which occupies one column. Still goes through `idiomatic`, so one declaration is right on both dialects. | `legacyColumnName` |
| 8 | An MList row's back reference is `ParentID` — ONE column whatever the owner is, because in Signum an MList table has no polymorphic parent at all. The `_<Impl>` suffix that disambiguates an ordinary `@implementedBy` has nothing to disambiguate, and there must be exactly one implementation to name. | `generateField` |
| 9 | An MList of EMBEDDEDs inlines the element's members with NO prefix at all (`file_name`, not `element_file_name`) — an MList element has no property in Signum, so there is nothing to prefix with. Marked by `@valueField` on the element field. | `generateField` |
| 10 | An MList row's element column is named after the element TYPE (`EntityID_User`, `TypeConditionID`) rather than after the field altea invented for the row, and its index column is `Order` whatever the `@rowOrder` field is called (Signum builds it with a NULL route, so no property is behind it). | `legacyMListColumnBase` |

### Table shape

| # | Rule | Where |
| --- | --- | --- |
| 11 | A `@part` that stands in for a real Signum ENTITY gets its Ticks stamp BACK — a dashboard part's content, an email service, a scheduler rule, a virtual-MList child — because their tables have one there. An MList ROW still has none: it is not an entity in Signum at all. Which is which is DERIVED, never declared. | `completeTable` |
| 12 | An MList table has no ToStr column. | `completeTable` |
| 13 | An MList row gets no `basics.type` row — Signum has no entity there, and Signum's own synchronizer DELETES rows it does not recognise, so the two applications would take turns adding and removing them. | `TypeLogic.typedTables` |
| 14 | An MList row gets no `basics.query` row, for the same reason. | `FluentInclude.withQuery` |
| 15 | A system-versioned MList ROW gets no PK+period index — Signum's `TableMList.GenerateAllIndexes` is a separate method that does not add one. | `generateIndexes` |

### DDL

| # | Rule | Where |
| --- | --- | --- |
| 16 | System versioning installs the upstream `temporal_tables` function Signum ships, instead of altea's native one, and the trigger takes Signum's `VersioningTriggerArgs` (`'{sysPeriod}', '{historyTable}', true`). Neither is wrong; this one is what a Signum database HAS. | `sqlBuilder.createVersioningFunction`, `postgres/versioning` |
| 17 | A filtered index's WHERE predicate is rendered with Signum's semantics. Without it a Signum-generated index and altea's compare unequal and every sync rewrites them. | `indexWhere` |

### Stored values that must be READ back

These are the "reading only" rules — altea keeps writing its own spelling.

| # | Rule | Where |
| --- | --- | --- |
| 18 | A query token stored by Signum starts at its `Entity` column; altea's root is rootless, so a leading `Entity.` is dropped. Only when nothing ANSWERS to `Entity` — a query named by a row MODEL has a real `Entity` member, and that one wins. Mirror image of the fallback Signum's own `QueryTokenSynchronizer` has, which ADDS the prefix. | `stripLegacyRootPrefix` |
| 19 | A Signum MList element IS the value, so a stored token that stops at a collection ELEMENT means the element's value: `Telephones.Any` resolves to altea's `Telephones.Any.Telephone`. A row with no `@valueField` is left where it stopped. | `appendLegacyValueField` |
| 20 | A stored property route is spelled Signum's way, PascalCase (`Id`, `ShipAddress.City`), and writes the collection ROW's `@valueField` wrapper away. | `PropertyRoute` |
| 21 | `extraSyncRoutes` FAKES the routes altea's model cannot name (`@legacyPropertyRoute`), so a Signum database's `auth.rule_property` row on `Product.ValueInStock` is preserved rather than offered as a rename and dropped. Registers NOTHING in normal mode. | `PropertyRouteLogic` |
| 22 | `renameSymbolContainer(container, to, members?)` re-keys a renamed symbol CONTAINER, because a symbol's key IS the `key` column of its table and the rows are FK targets. Called from the app's shared entity-overrides module, NOT the Starter — both tiers must agree. | `data/reflection` |
| 23 | `simplifyDiffTables` removes from the database description, before it is diffed, the tables and columns altea has no counterpart for — so they are neither renamed into something unrelated nor dropped. `simplifyDiffEnums` is its sibling for an enum table's ROWS. Neither registers anything in normal mode. | `schemaSynchronizer` |

### Application level

| # | Rule | Where |
| --- | --- | --- |
| 24 | `EASTWIND_FILE_STORE_ROOT` plus a per-store alias, because a file-backed row holds a suffix relative to whatever the Signum deployment's `Folders` was set to. | eastwind `Starter` |
| 25 | A BigString's file is named by `storedMemberName`, so `InitialState.txt` rather than `initialState.txt` — the name is written into the stored suffix, so the two deployments must agree on it. | `BigStringLogic` |

---

## Adding a rule

Gate it on `SchemaSettings.legacyMode` (or `Table.legacyMode` / the dialect's copy, where the flag has been
carried down for rendering), add a row above, and — if it is one of the "stored values" kind — make sure it
only affects READING.

Prefer DERIVING the answer over a new decorator. `mlistRowOwner` is the workhorse: *is this `@part` row
altea's stand-in for a Signum MLIST TABLE, and if so whose?* Ten of the rules above are that one question
asked in different places. A decorator is for what cannot be derived — `@legacyTableName`,
`@legacyColumnName`, `@legacyClassName`, `@legacyPropertyRoute`, `wasVirtualMList` — i.e. a fact about what
Signum CALLED something, which nothing in the TypeScript records. And prefer ONE declaration to three:
`@legacyClassName` is the root the other two names derive from, so `@legacyCleanName` / `@legacyTableName`
are for where that chain does not land on Signum's answer.

Every one of them is read ONLY while legacy mode is on. The flag lives in the DATA layer
(`setLegacyMode` / `isLegacyMode` in `data/registration`) because both tiers resolve a clean name and a
client has no schema; `SchemaSettings.legacyMode` is an accessor over it, and constructing a
SchemaSettings clears it, so a build that says nothing about legacy mode gets altea's own names.
