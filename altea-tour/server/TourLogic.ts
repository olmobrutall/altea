import "@altea/altea/server"; // installs save()/toLite()
import { PropertyRouteLogic } from "@altea/altea/server/propertyRouteLogic";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TourTriggerLogic } from "@altea/altea/server/tourTriggerLogic";
import { registerEntityPackExtension, setEntityPackExtension } from "@altea/altea/server/operationServer";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { TourTriggerSymbol } from "@altea/altea/data/tourTrigger";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { PropertyRouteEntity } from "@altea/altea/data/propertyRouteEntity";
import { Connector } from "@altea/altea/server/connection/connector";
import { SqlPreCommandSimple } from "@altea/altea/server/sync/sqlPreCommand";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { DashboardEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { TourEntity, CssStepEntity, CssStepType, TourOperation } from "../data/Tour";
import { TourServer } from "./TourServer";
import { TourXml } from "./TourXml";

// The module starter: the Tour table + its query, the trigger symbol table, the by-trigger lazy the lookup
// routes read, the `hasTour` entity-pack flag, XML import/export, and the two cascades that keep a tour
// from outliving what it explains.
//
// Port of Signum.Tour's TourLogic.cs — see docs/port/Tour.md.
export namespace TourLogic {

    /** Every tour, keyed by its trigger's lite key. */
    export let toursByTrigger: ResetLazy<Map<string, TourEntity>> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // A route reference needs the routes table (idempotent — see the CLAUDE.md rule that a module
        // registers what a module owns).
        PropertyRouteLogic.start(sb);

        sb.include(TourEntity)
            .withSave(TourOperation.Save)
            .withDelete(TourOperation.Delete)
            .withQuery();

        SymbolLogic.start(sb, TourTriggerSymbol, () => TourTriggerLogic.registeredTourTriggers());

        // A route the sync is removing takes
        // the css steps that point at it with it, or the route's DELETE fails on their FK.
        sb.schema.entityEvents(PropertyRouteEntity).preDeleteSqlSync.push(property => {
            const cssTable = sb.schema.tryTable(CssStepEntity);
            if (cssTable == null)
                return undefined;
            const builder = Connector.current().sqlBuilder;
            const column = cssTable.fields["property"]?.field.columns()[0];
            if (column == null)
                return undefined;
            return new SqlPreCommandSimple(
                `DELETE FROM ${builder.objectName(cssTable.name)} WHERE ${builder.sqlEscape(column.name)} = ${property.id};`);
        });

        toursByTrigger = sb.globalLazy(async () => {
            const tours = await table(TourEntity).toArray();
            return new Map(tours.map(t => [t.trigger.key(), t]));
        }, { invalidateWith: [TourEntity] });

        // The frame's tour widget must decide whether to render
        // WITHOUT a round-trip of its own, so the pack says whether a tour exists for the entity's TYPE.
        registerEntityPackExtension(async pack => {
            const typeLite = tryTypeLite(pack.entity.constructor.name);
            setEntityPackExtension(pack, "hasTour",
                typeLite != null && (await toursByTrigger.value()).has(typeLite.key()));
        });

        TourXml.start();

        // A tour whose dashboard or user query is deleted has nothing left to explain, so it goes with it.
        // (A `@part` collection cascades from the tour.)
        sb.schema.entityEvents(DashboardEntity).preUnsafeDelete.push(async query => {
            const lites = (await query.map(d => d.toLite()).toArray()) as Lite<Entity>[];
            await deleteToursFor(lites);
        });

        sb.schema.entityEvents(UserQueryEntity).preUnsafeDelete.push(async query => {
            const lites = (await query.map(uq => uq.toLite()).toArray()) as Lite<Entity>[];
            await deleteToursFor(lites);
        });

        // A DashboardPart step points at a part by its
        // uuid, so parts removed from a saved dashboard leave dangling steps — drop them.
        sb.schema.entityEvents(DashboardEntity).saved.push((dashboard, args) => {
            if (args.wasNew)
                return;
            void dropStaleDashboardPartSteps(dashboard);
        });

        if (sb.webBuilder)
            TourServer.start(sb.webBuilder);
    }

    /** The tour registered for a lite, or undefined. The lookup routes and `hasTour` share this. */
    export async function tryGetTour(trigger: Lite<Entity>): Promise<TourEntity | undefined> {
        return (await toursByTrigger.value()).get(trigger.key());
    }

    /**
     * The TypeEntity lite for a type name (clean or with the `Entity` suffix), or undefined when the
     * name does not resolve to a persistent type.
     *
     * Reads TypeLogic's warm type↔id caches rather than querying the TypeEntity table: this runs from the
     * entity-pack extension, i.e. on EVERY entity open, and a `table(TypeEntity)` round-trip there showed
     * up as an extra query per open in the heavy profiler. The rows it resolves against are the very ones
     * that query would read.
     */
    export function tryTypeLite(typeName: string): Lite<TypeEntity> | undefined {
        const id = TypeLogic.tryTypeToIdByName(typeName);
        return id == null ? undefined : TypeLogic.idToEntity(id)?.toLite();
    }

    async function deleteToursFor(triggers: Lite<Entity>[]): Promise<void> {
        for (const trigger of triggers) {
            const tour = await table(TourEntity).filter(t => t.trigger.is(trigger)).singleOrNull();
            if (tour != null)
                await tour.delete();
        }
    }

    // TWO steps rather than one delete with the whole tour → step → dashboard chain in its WHERE: an
    // EXISTS sub-query inside a quoted predicate would have to be a `.some(…)` call, which returns a
    // Promise and so cannot be ANDed into a boolean filter. The tour for a dashboard is already a lazy
    // lookup, so both steps are cheap.
    async function dropStaleDashboardPartSteps(dashboard: DashboardEntity): Promise<void> {
        await ExecutionMode.global(async () => {
            const tour = await tryGetTour(dashboard.toLite());
            if (tour == null)
                return;

            const stepIds = tour.steps.map(s => s.id);
            if (stepIds.length === 0)
                return;

            const validGuids = dashboard.parts.map(p => String(p.id));

            await table(CssStepEntity)
                .filter(cs => cs.type == CssStepType.DashboardPart
                    && cs.dashboardPart != null
                    && !validGuids.includes(cs.dashboardPart!)
                    && stepIds.includes(cs.tourStep.id))
                .executeDelete();
        });
    }
}
