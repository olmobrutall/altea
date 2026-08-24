import "@altea/altea/server"; // installs save()/toLite()
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
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { DashboardEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { TourEntity, CssStepEmbedded, CssStepType, TourOperation } from "../data/Tour";
import { TourServer } from "./TourServer.server";
import { TourXml } from "./TourXml.server";

// Port of Signum.Tour's TourLogic.cs — the module starter: the Tour table + its query, the trigger symbol
// table, the by-trigger lazy the lookup routes read, the `hasTour` entity-pack flag, XML import/export,
// and the two cascades that keep a tour from outliving what it explains.
//
// altea divergences:
//  - **`WithVirtualMList(a => a.Steps, s => s.Tour)` has no counterpart, and needs none**: altea's
//    `@part` collection IS Signum's virtual MList — `sb.include(TourEntity)` already builds the
//    TourStepEntity child table off the `@backReference` (and CssStepEmbedded's off that, in turn).
//  - **the PropertyRouteEntity cascade is gone with the table** (see data/Tour.ts): Signum drops
//    CssStep rows whose PropertyRouteEntity is being deleted by a synchronization; altea stores the route
//    as a string, so there is no row to cascade from.
//  - `EntityPackTS.AddExtension` → core's `registerEntityPackExtension` (added for this module).
//  - Signum's dashboard cascades use `Database.MListQuery(...).UnsafeDeleteMList()`; here the CssStep rows
//    are an ordinary table, so it is `table(CssStepEmbedded).filter(...).executeDelete()`.
export namespace TourLogic {

    /** Signum's `ToursByTrigger` — every tour, keyed by its trigger's lite key. */
    export let toursByTrigger: ResetLazy<Map<string, TourEntity>> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(TourEntity)
            .withSave(TourOperation.Save)
            .withDelete(TourOperation.Delete)
            .withQuery();

        SymbolLogic.start(sb, TourTriggerSymbol, () => TourTriggerLogic.registeredTourTriggers());

        toursByTrigger = sb.globalLazy(async () => {
            const tours = await table(TourEntity).toArray();
            return new Map(tours.map(t => [t.trigger.key(), t]));
        }, { invalidateWith: [TourEntity] });

        // Signum's `EntityPackTS.AddExtension`: the frame's tour widget must decide whether to render
        // WITHOUT a round-trip of its own, so the pack says whether a tour exists for the entity's TYPE.
        registerEntityPackExtension(async pack => {
            const typeLite = await tryTypeLite(pack.entity.constructor.name);
            setEntityPackExtension(pack, "hasTour",
                typeLite != null && (await toursByTrigger.value()).has(typeLite.key()));
        });

        TourXml.start();

        // Signum's two `PreUnsafeDelete` cascades: a tour whose dashboard or user query is deleted has
        // nothing left to explain, so it goes with it. (A `@part` collection cascades from the tour.)
        sb.schema.entityEvents(DashboardEntity).preUnsafeDelete.push(async query => {
            const lites = (await query.map(d => d.toLite()).toArray()) as Lite<Entity>[];
            await deleteToursFor(lites);
        });

        sb.schema.entityEvents(UserQueryEntity).preUnsafeDelete.push(async query => {
            const lites = (await query.map(uq => uq.toLite()).toArray()) as Lite<Entity>[];
            await deleteToursFor(lites);
        });

        // Signum's `EntityEvents<DashboardEntity>.Saved`: a DashboardPart step points at a part by its
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

    /** The TypeEntity lite for a clean type name, or undefined when the type is not in the registry. */
    export async function tryTypeLite(cleanName: string): Promise<Lite<TypeEntity> | undefined> {
        const name = cleanName.replace(/Entity$/, "");
        const te = await table(TypeEntity).filter(t => t.cleanName == name).singleOrNull();
        return te?.toLite();
    }

    async function deleteToursFor(triggers: Lite<Entity>[]): Promise<void> {
        for (const trigger of triggers) {
            const tour = await table(TourEntity).filter(t => t.trigger.is(trigger)).singleOrNull();
            if (tour != null)
                await tour.delete();
        }
    }

    // Signum expresses this as ONE `UnsafeDeleteMList` with the whole tour → step → dashboard chain in its
    // WHERE. altea cannot: an EXISTS sub-query inside a quoted predicate would have to be a `.some(…)`
    // call, which returns a Promise and so cannot be ANDed into a boolean filter. Since the tour for a
    // dashboard is already a lazy lookup, the chain is walked in two cheap steps instead.
    async function dropStaleDashboardPartSteps(dashboard: DashboardEntity): Promise<void> {
        await ExecutionMode.global(async () => {
            const tour = await tryGetTour(dashboard.toLite());
            if (tour == null)
                return;

            const stepIds = tour.steps.map(s => s.id);
            if (stepIds.length === 0)
                return;

            const validGuids = dashboard.parts.map(p => String(p.id));

            await table(CssStepEmbedded)
                .filter(cs => cs.type == CssStepType.DashboardPart
                    && cs.dashboardPart != null
                    && !validGuids.includes(cs.dashboardPart!)
                    && stepIds.includes(cs.tourStep.id))
                .executeDelete();
        });
    }
}
