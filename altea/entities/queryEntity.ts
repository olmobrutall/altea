import { Entity } from './entity';
import { reflect } from './reflection';
import { entity, EntityKind, EntityData } from './decorators';

// Port of Signum's `QueryEntity` (Signum/Basics/QueryEntity.cs): the system table with one row per
// registered query (keyed by the query's string key). Mirrors the TypeEntity pattern (see
// [[operations-symbol-port]] / typeEntity.ts).
//
// TODO(phase4): DB generation + synchronization of the rows (Signum's Schema_Generating /
// SynchronizeQueries) and the QueryNameToEntity cache are NOT wired yet — see queryLogic.ts.
@reflect
@entity(EntityKind.SystemString, EntityData.Master)
export class QueryEntity extends Entity {
    // The query's stable string key (Signum's QueryUtils.GetKey — the clean type name for an
    // entity-ctor query). UNIQUE in Signum (unique-index generation deferred, as for TypeEntity).
    key: string;

    toString(): string {
        return this.key;
    }
}
