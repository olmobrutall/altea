import { Entity } from './entity';
import { reflect, setDefaultDatabaseSchema } from './reflection';
import { entity, quoted, uniqueIndex } from './decorators';

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
//  - `toString()` is left as the inherited default rather than `CleanName`
//    (no test depends on a TypeEntity display string), so there is no `ToStr`
//    column.
@reflect
@entity("SystemString", "Master")
export class TypeEntity extends Entity {
    // The physical table name of the type (e.g. "Artist" / "note_with_date"). Signum: `[UniqueIndex]`.
    @uniqueIndex
    tableName: string;

    // The clean type name (Signum's Reflector.CleanTypeName, e.g. "Artist") — the
    // human-facing discriminator. Signum: `[UniqueIndex]` (Type.cs).
    @uniqueIndex
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
    package: string | null;
    className: string;

    // Signum's `Namespace` — the C# namespace, which TypeScript has no counterpart for, so altea
    // never writes one. It is declared NULLABLE and kept purely so a database a SIGNUM application
    // generated is not asked to drop the column (and its values) the first time altea syncs it; the
    // type synchronizer therefore CARRIES IT OVER on a merge rather than overwriting it with null.
    // `package` is what altea groups by, and Signum is gaining the same column.
    namespace: string | null;

    // Signum's TypeEntity.ToString => CleanName. altea originally left the inherited default (which renders
    // "Type <id>", e.g. "Type 8"); give it the clean name so references/lites display meaningfully (e.g. the
    // ColorPalette.type field). @quoted so it also lowers to SQL for the ToStr column / order-by.
    @quoted
    toString(): string {
        return this.cleanName;
    }
}

// The framework's own entities in this data/ folder (TypeEntity, OperationSymbol, QueryEntity,
// ExceptionEntity, OperationLogEntity — Signum's Signum.Basics) live in a "basics" DB schema, keeping the
// framework's tables out of the app's default schema. FOLDER-scoped to @altea/altea/data (the transformer
// stamps the __fileInfo), and declared HERE because SchemaBuilder imports typeEntity.ts, so the scope is
// registered before any table is included in any app/test. Enum tables are exempt — they resolve to the
// schema of the package the ENUM is defined in (SchemaSettings.schemaForType), not to this folder.
setDefaultDatabaseSchema("basics");
