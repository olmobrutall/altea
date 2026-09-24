import { stringLengthValidator } from './validators';
import { Entity } from './entity';
import { setDefaultDatabaseSchema } from './reflection';
import { entity, legacyForceNullable, quoted, uniqueIndex } from './decorators';
import { msg } from './utils/localization';

// Port of Signum's TypeEntity (Signum/Basics/Type.cs): the system table that maps
// every persistent entity type to a stable int id. That id is the discriminator
// stored by `@implementedByAll` (the type column) and resolved back to a
// constructor when materialising a polymorphic reference — replacing the earlier
// interim clean-name-string discriminator.
//
// Differences vs Signum:
//  - no `ticks` column (Signum's `[TicksColumn(false)]`); the SchemaBuilder
//    special-cases this table alongside enum tables (see `isSeeded`). The PK is a
//    real identity column, though (unlike the enum/symbol tables): generation inserts
//    the rows without ids and `TypeLogic.load` reads the DB-assigned ids back, exactly
//    as Signum does.
//  - there is no `ToStr` column: `toString()` is `@quoted` (see below), so the display string is
//    COMPUTED — which is what gives a `Lite<TypeEntity>` its text, and therefore what the
//    `[EntityType]` query token projects.
@entity("SystemString", "Master")
export class TypeEntity extends Entity {
    // The physical table name of the type (e.g. "Artist" / "note_with_date"). Signum: `[UniqueIndex]`.
    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    tableName: string;

    // The clean type name (Signum's Reflector.CleanTypeName, e.g. "Artist") — the
    // human-facing discriminator. Signum: `[UniqueIndex]` (Type.cs).
    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    cleanName: string;

    // The owning npm PACKAGE of the type (Signum's TypeEntity.Namespace analog — TS has no
    // namespaces, so altea records the package, e.g. "@altea/altea" / "@altea/altea-auth" /
    // "eastwind"; resolved from the registration FileInfo). And the unqualified class name.
    //
    // NULLABLE, matching Signum's `public string? Package` — in the object model as well as the
    // column, because the value genuinely can be absent: a type whose registration FileInfo the
    // transformer never stamped has no package to record, and every row in a database a SIGNUM
    // application generated has `package = NULL`. (Signum declares the column and never assigns it —
    // `TypeLogic.Schema_Synchronizing` copies only TableName, CleanName, Namespace and ClassName onto
    // the retrieved row — which also means altea's values SURVIVE a Signum sync untouched: filling
    // them is a one-time migration, not a tug of war.)
    @stringLengthValidator({ max: 200 })
    package: string | null;
    @stringLengthValidator({ max: 200 })
    className: string;

    // Signum's `Namespace` — the C# namespace, which TypeScript has no counterpart for, so altea
    // never writes one. It is declared NULLABLE and kept purely so a database a SIGNUM application
    // generated is not asked to drop the column (and its values) the first time altea syncs it; the
    // type synchronizer therefore CARRIES IT OVER on a merge rather than overwriting it with null.
    // `package` is what altea groups by, and Signum is gaining the same column.
    @stringLengthValidator({ max: 200 })
    namespace: string | null;

    // Whether the type is a `@part` — an entity that exists only
    // as part of the one entity that owns it (`PropertyRoute.isPartType`, the same predicate the route
    // rules and the token layer go through, so the row and the model cannot disagree about what a part is).
    //
    // STORED, deliberately, and that is the whole justification for a column rather than a client-side
    // predicate: the compile-time `TypeInfo.entityKind` already ships to the client, so a predicate is
    // possible — but what is wanted is a SERVER-side filter (`isPart == false` in the query request), and a
    // predicate applied to the rows a page happens to have received cannot do that without lying about the
    // total count and paging past what it hid. Its consumer is the type PICKER (`EntityBase.chooseType`
    // opens `Finder.find(TypeEntity)` for an `@implementedByAll` reference), where a part is never a
    // sensible answer — see the framework's TypeEntityClient.
    //
    // `SharedPart` is NOT included, exactly as `isPartType` excludes it: a SharedPart has several owners
    // and stands alone, so it is a legitimate thing to pick.
    //
    // KEPT in legacy mode rather than hidden through `simplifyDiffTables`: hiding it would mean the column
    // does not exist against a Signum database, and the server-side filter is precisely what would then
    // break. So a Southwind sync scripts one ADD COLUMN — the same call `package` already makes.
    //
    // Signum now DECLARES the column too (`public bool? IsPart`, Signum/Basics/Type.cs) and, exactly as
    // for `package`, neither fills it nor copies it on a merge — so the two tables converge and altea’s
    // values survive a Signum sync untouched. It stays NON-nullable in the model, because altea derives it
    // for every row it writes; against a legacy database the COLUMN keeps Signum's nullable declaration.
    @legacyForceNullable
    isPart: boolean;

    // Signum's TypeEntity.ToString => CleanName. altea originally left the inherited default (which renders
    // "Type <id>", e.g. "Type 8"); give it the clean name so references/lites display meaningfully (e.g. the
    // ColorPalette.type field). @quoted so it also lowers to SQL for the ToStr column / order-by.
    @quoted
    toString(): string {
        return this.cleanName;
    }
}

// The type table's own UI vocabulary. NEW here — Signum has no counterpart, because it has no such
// filter: `isPart` is altea's column (see above), so the label that switches it off is altea's too. A
// container of its own rather than a member on `SearchMessage`, which is the generic search vocabulary
// where this is about one table.
export const TypeEntityMessage = {
    /** The pinned filter that shows `@part` rows in a type picker — see the framework's TypeEntityClient. */
    IncludePartEntities: msg("Include Part entities"),
};

// The framework's own entities in this data/ folder (TypeEntity, OperationSymbol, QueryEntity,
// ExceptionEntity, OperationLogEntity — Signum's Signum.Basics) live in a "basics" DB schema, keeping the
// framework's tables out of the app's default schema. FOLDER-scoped to @altea/altea/data (the transformer
// stamps the __fileInfo), and declared HERE because SchemaBuilder imports typeEntity.ts, so the scope is
// registered before any table is included in any app/test. Enum tables are exempt — they resolve to the
// schema of the package the ENUM is defined in (SchemaSettings.schemaForType), not to this folder.
setDefaultDatabaseSchema("basics");
