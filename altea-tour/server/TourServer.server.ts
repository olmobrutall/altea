import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { TourTriggerLogic } from "@altea/altea/server/tourTriggerLogic";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TourTriggerSymbol } from "@altea/altea/data/tourTrigger";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { Enum } from "@altea/altea/data/enum";
import { DashboardEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import {
    TourEntity, TourStepEntity, ClickTrigger, PopoverAlign, PopoverSide, cssSelector,
} from "../data/Tour";
import { TourLogic } from "./TourLogic.server";

// Port of Signum.Tour's TourController.cs + TourDTO.cs — the four "is there a tour for this?" lookups the
// TourButton calls, and the flattened DTO the driver.js player consumes.
//
// altea divergences:
//  - the routes are namespaced `/api/tour/...` — which is already Signum's shape here.
//  - `GetTriggerType` returns the trigger's CLEAN TYPE NAME rather than a `Lite<TypeEntity>`: the editor
//    only ever uses it to look up property routes, which are keyed by the ctor on the client, and a lite
//    would just cost the client a second fetch to read the name back out.
//  - `ResolveCssSelector` moved to the DATA layer (`cssSelector` in data/Tour.ts) so the editor's live
//    preview and the served DTO cannot drift; the query KEY of a `Lite<QueryEntity>` toolbar target is
//    resolved here (a lookup the isomorphic layer cannot do) and passed in.
//  - the enums travel as their member NAME strings, lower-cased for `side`/`align` as Signum does (they
//    are driver.js's own vocabulary); altea enums are int-FK in memory, hence the `Enum.toName`.
export namespace TourServer {

    /** Signum's TourDTO — what the player needs, with each step's selector already resolved. */
    export interface TourDTO {
        tour: Lite<TourEntity>;
        forEntity: Lite<Entity>;
        steps: TourStepDTO[];
        showProgress: boolean;
        animate: boolean;
        showCloseButton: boolean;
    }

    export interface TourStepDTO {
        cssSelector: string | null;
        title: string;
        description: string;
        side: string | null;
        align: string | null;
        click: string | null;
    }

    export function start(ws: WebBuilder): void {

        ws.get("/api/tour/byEntity/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<TourDTO | null>() },
            async (req, res) => {
                const { typeName } = (req as unknown as { params: { typeName: string } }).params;
                const typeLite = await TourLogic.tryTypeLite(typeName);
                const tour = typeLite == null ? undefined : await TourLogic.tryGetTour(typeLite);
                return res.jsonTyped(tour == null ? null : await toDTO(tour));
            });

        ws.get("/api/tour/bySymbol/:symbolKey",
            { params: CustomType<{ symbolKey: string }>(), res: CustomType<TourDTO | null>() },
            async (req, res) => {
                const { symbolKey } = (req as unknown as { params: { symbolKey: string } }).params;
                const symbol = SymbolLogic.tryToSymbol(TourTriggerSymbol, symbolKey);
                const tour = symbol == null ? undefined : await TourLogic.tryGetTour(symbol.toLite());
                return res.jsonTyped(tour == null ? null : await toDTO(tour));
            });

        ws.get("/api/tour/triggerType",
            { res: CustomType<string | null>() },
            async (req, res) => {
                const lite = Lite.parse((req.query["liteKey"] as string | undefined) ?? "");
                const symbol = SymbolLogic.tryToSymbol(TourTriggerSymbol, lite.toString());
                const type = symbol == null ? undefined : TourTriggerLogic.getTriggerType(symbol);
                return res.jsonTyped(type == null ? null : type.name.replace(/Entity$/, ""));
            });

        // Signum restricts this route to the two asset triggers, so a caller cannot probe an arbitrary
        // lite through it; kept.
        ws.get("/api/tour/byLite",
            { res: CustomType<TourDTO | null>() },
            async (req, res) => {
                const lite = Lite.parse((req.query["liteKey"] as string | undefined) ?? "");
                if (lite.entityType !== DashboardEntity && lite.entityType !== UserQueryEntity)
                    return res.jsonTyped(null);
                const tour = await TourLogic.tryGetTour(lite);
                return res.jsonTyped(tour == null ? null : await toDTO(tour));
            });
    }

    async function toDTO(tour: TourEntity): Promise<TourDTO> {
        const steps: TourStepDTO[] = [];
        for (const s of tour.steps)
            steps.push(await toStepDTO(s));

        return {
            tour: tour.toLite(),
            forEntity: tour.trigger,
            showProgress: tour.showProgress,
            animate: tour.animate,
            showCloseButton: tour.showCloseButton,
            steps,
        };
    }

    async function toStepDTO(s: TourStepEntity): Promise<TourStepDTO> {
        // A toolbar-content step targets a QueryEntity by its KEY; resolve every one this step needs
        // before handing the (synchronous) selector builder its lookup.
        const keys = new Map<string, string>();
        for (const cs of s.cssSteps) {
            const lite = cs.toolbarContent;
            if (lite != null && !keys.has(lite.key()))
                keys.set(lite.key(), await queryKeyOf(lite));
        }

        const selector = cssSelector(s, lite => keys.get(lite.key()) ?? lite.key());

        return {
            cssSelector: selector === "" ? null : selector,
            title: s.title,
            description: s.description,
            side: s.side == null ? null : Enum.toName(PopoverSide, s.side).toLowerCase(),
            align: s.align == null ? null : Enum.toName(PopoverAlign, s.align).toLowerCase(),
            click: s.click == null ? null : Enum.toName(ClickTrigger, s.click),
        };
    }

    async function queryKeyOf(lite: Lite<Entity>): Promise<string> {
        if (lite.entityType === QueryEntity) {
            const id = lite.id;
            const q = await table(QueryEntity).filter(a => a.id == id).singleOrNull();
            if (q != null)
                return q.key;
        }
        return lite.key();
    }
}
