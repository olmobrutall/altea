import { Entity } from './entity';
import { reflect } from './reflection';
import { entity, quoted } from './decorators';

// Port of Signum's `QueryEntity` (Signum/Basics/QueryEntity.cs): the system table with one row per
// registered query (keyed by the query's string key). Mirrors the TypeEntity pattern (see
// [[operations-symbol-port]] / typeEntity.ts).
//
// TODO(phase4): DB generation + synchronization of the rows (Signum's Schema_Generating /
// SynchronizeQueries) and the QueryNameToEntity cache are NOT wired yet — see queryLogic.ts.
@reflect
@entity("SystemString", "Master")
export class QueryEntity extends Entity {
    // The query's stable string key (Signum's QueryUtils.GetKey — the clean type name for an
    // entity-ctor query). UNIQUE in Signum (unique-index generation deferred, as for TypeEntity).
    key: string;

    // Signum's `[AutoExpressionField] ToString() => Key`. @quoted so it ALSO lowers to SQL: this table has no
    // stored ToStr column, so without it a `Lite<QueryEntity>` read from a FK arrives with an EMPTY toStr —
    // and every consumer that recovers the query key from a lite (a toolbar element's content, a UserQuery's
    // `query`) silently sees "". Same treatment as TypeEntity.toString.
    @quoted
    toString(): string {
        return this.key;
    }
}
