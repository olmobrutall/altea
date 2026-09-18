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

// One row per "the API handed this entity (or this query's results) to this user", with how long it took
// and, for a query, the SQL it ran.
//
// Port of Signum.ViewLog's ViewLogEntity.cs — see port/ViewLog.md.
@reflect
@entity("System", "Transactional")
export class ViewLogEntity extends Entity {

    /** What was looked at: any entity, or the `QueryEntity` of a search that was run. */
    @implementedByAll
    target: Lite<Entity>;

    @implementedBy(() => [])
    user: Lite<IUserEntity>;

    /**
     * Which code path produced this row. For an entity read it is the route
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
     * For a search: the query url plus the SQL it actually ran (see `ViewLogLogic.getQueryData`). Empty
     * for an entity read.
     */
    data: BigStringEmbedded = new BigStringEmbedded();

    /** `@quoted`, so it is an orderable query column — registered in ViewLogLogic. */
    @legacyPropertyRoute("Duration")
    @quoted durationMilliseconds(): number {
        return this.endDate.since(this.startDate).total({ unit: "milliseconds" });
    }

    // No `toString()`, so the table has no ToStr column: `target` is `@implementedByAll`, and no query can
    // expand an ANY-entity reference's display string inline (the target table is known only per row).
}

export const ViewLogMessage = {
    ViewLogMyLast: msg("My last view log"),
    // The caption of the `Duration` token over durationMilliseconds() (registered in ViewLogLogic).
    // Signum translates it as the entity's `Duration` PROPERTY; a `@quoted` method is not a PropertyRoute
    // here, so it has no <Member> entry to hold a translation — `stub-translations` builds a type's member
    // list from PropertyRoute.memberPaths, i.e. from FIELDS — and a message is the localizable home that
    // leaves. It used to be `nicePropertyName(e => e.durationMilliseconds())`, which silently humanised to
    // "Duration milliseconds" in every culture.
    Duration: msg(),
};

setDefaultDatabaseSchema("viewLog");

// ---- the two query expressions ViewLogLogic registers ----------------------------------------------------
//
// DECLARED here and IMPLEMENTED in server/ViewLogLogic: the declaration is in data/ so the CLIENT can write
// `token(a => a.viewLogs())`, while the body needs `table(...)`, which is server-only. OPTIONAL, because
// only the registered types offer them as tokens.
declare module "@altea/altea/data/entity" {
    interface Entity {
        /** Every view log whose `target` is this entity. */
        viewLogs?(): IQuery<ViewLogEntity>;
        /** …narrowed to the CURRENT user's. */
        viewLogMyLast?(): IQuery<ViewLogEntity>;
    }
}
