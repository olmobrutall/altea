import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedByAll, implementedBy, quoted, format, legacyPropertyRoute,
} from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import type { IUserEntity } from "@altea/altea/data/security";
import type { IQuery } from "@altea/altea/data/iquery";

// Port of Signum.ViewLog's ViewLogEntity.cs — one row per "the API handed this entity (or this query's
// results) to this user", with how long it took and, for a query, the SQL it ran.
//
// altea divergences:
//  - **`Duration` is a `@quoted` member plus a registered expression** (see server/ViewLogLogic), so it is
//    an orderable query column, as Signum's `[AutoExpressionField] Duration` is. A plain `number` lowers to
//    `DATEDIFF(millisecond, …)`; the branded `int` the in-memory duration helpers in altea-processes /
//    -scheduler / -migrations return does not — see @altea/altea-rest, which made the same call.
//  - **`user` is NOT nullable, and neither is `target`.** Signum types `Target` / `User` non-nullable too;
//    both are always set, because the logger stands down entirely when there is no current user.
//  - **`@implementedBy(() => [])` on `user`**, widened by the app — core's pattern for a
//    `Lite<IUserEntity>` (an INTERFACE has no runtime constructor), exactly as `ExceptionEntity.user` does.
@reflect
@entity("System", "Transactional")
export class ViewLogEntity extends Entity {

    /** What was looked at: any entity, or the `QueryEntity` of a search that was run. */
    @implementedByAll
    target: Lite<Entity>;

    @implementedBy(() => [])
    user: Lite<IUserEntity>;

    /**
     * Which code path produced this row — Signum's `ViewAction`. For an entity read it is the route
     * ("EntitiesController.GetEntity"); for a search it is "ExecuteQuery"; for a module reporting its own
     * scope it is that module's label ("UserQuery", "Dashboard", …).
     */
    @stringLengthValidator({ min: 3, max: 100 })
    viewAction: string;

    @format("G")
    startDate: Temporal.PlainDateTime = Clock.now;

    @format("G")
    endDate: Temporal.PlainDateTime;

    /**
     * For a search: the query url plus the SQL it actually ran (see `ViewLogLogic.getQueryData`). Empty for
     * an entity read, as in Signum.
     */
    data: BigStringEmbedded = new BigStringEmbedded();

    /** Signum's `[AutoExpressionField, Unit("ms")] Duration`. */
    @legacyPropertyRoute("Duration")
    @quoted durationMilliseconds(): number {
        return this.endDate.since(this.startDate).total({ unit: "milliseconds" });
    }

    // No `toString()`: Signum's ViewLogEntity does not override it either, so its table has no ToStr
    // column. `target` is `@implementedByAll`, and no query can expand an ANY-entity reference's display
    // string inline (the target table is only known per row) — which is exactly why Signum leaves the
    // default here. Keeping "GetEntity Order 10248" would mean materialising a `to_str` Signum has not.
}

export const ViewLogMessage = {
    ViewLogMyLast: msg("My last view log"),
};

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("viewLog")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("viewLog");
