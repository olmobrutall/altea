import { Entity } from './entity';
import { reflect } from './reflection';
import { entity, EntityKind, EntityData } from './decorators';

// Port of Signum's TypeEntity (Signum/Basics/Type.cs): the system table that maps
// every persistent entity type to a stable int id. That id is the discriminator
// stored by `@implementedByAll` (the type column) and resolved back to a
// constructor when materialising a polymorphic reference — replacing the earlier
// interim clean-name-string discriminator.
//
// Differences vs Signum (all because altea has no schema Synchronizer yet):
//  - the PK is **non-identity**; ids are assigned deterministically in memory by
//    `TypeLogic.start` and seeded with explicit values at generation (like enum
//    side-tables), so the in-memory caches and the DB rows always agree without a
//    read-back. (Signum lets the DB assign identity ids and loads them back.)
//  - no `ticks` column (Signum's `[TicksColumn(false)]`); the SchemaBuilder
//    special-cases this table alongside enum tables.
//  - `toString()` is left as the inherited default rather than `CleanName`
//    (no test depends on a TypeEntity display string), so there is no `ToStr`
//    column.
@reflect
@entity(EntityKind.SystemString, EntityData.Master)
export class TypeEntity extends Entity {
    // The physical table name of the type (e.g. "Artist" / "note_with_date").
    tableName: string;

    // The clean type name (Signum's Reflector.CleanTypeName, e.g. "Artist") — the
    // human-facing discriminator; UNIQUE in Signum (no unique-index support yet).
    cleanName: string;

    // The type's namespace (always "" in altea — TS has no namespaces) and the
    // unqualified class name. Kept for parity with Signum's TypeEntity columns.
    namespace: string;
    className: string;
}
