import { table } from "@altea/altea/server/table";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { Enum } from "@altea/altea/data/enum";
import { toInt } from "@altea/altea/data/basics";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TourTriggerSymbol } from "@altea/altea/data/tourTrigger";
import { UserAssetsImporter } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import {
    TourEntity, TourStepEntity, CssStepEmbedded, CssStepType, ClickTrigger, PopoverAlign, PopoverSide,
} from "../data/Tour";

// Port of Signum.Tour's `TourEntity.ToXml/FromXml` + `TourStepEntity` + `CssStepEmbedded` (Tour.cs).
// altea keeps XML off the isomorphic entity — the (de)serializer registers with UserAssetsImporter, as
// every other altea user asset does — and the element/attribute names are preserved so a Signum-exported
// Tour file round-trips.
//
// altea divergences:
//  - **`Guid` is the row's uuid PK** (see data/Tour.ts), so the `Guid` attribute the importer keys on is
//    written from `id` and read back into it by the shared importer, not by this file.
//  - **`Property` is a route STRING**, not a `PropertyRouteEntity` reference — Signum resolves the trigger
//    to a TypeEntity and calls `ctx.GetPropertyRoute(typeEntity, path)`; here the path IS the value, so
//    both directions are a plain copy. (Which also means a Signum file imports unchanged.)
//  - a `ToolbarContent` pointing at a PermissionSymbol is not supported: altea's `CssStepEmbedded`
//    declares `@implementedBy(QueryEntity)` only, matching what the tour editor can actually pick.

const A = "@_"; // fast-xml-parser attribute prefix

export namespace TourXml {

    export function start(): void {
        UserAssetsImporter.register<TourEntity>({
            elementName: "Tour",
            create: () => new TourEntity(),
            load: async guid => (await table(TourEntity).filter(t => t.id == guid).toArray())[0],
            save: async t => { await (t as unknown as { save(): Promise<void> }).save(); },
            toXml,
            fromXml,
        });
    }
}

async function toXml(tour: TourEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const o: Record<string, unknown> = {};
    o[A + "Trigger"] = await triggerToXml(tour.trigger, ctx);
    o[A + "ShowProgress"] = tour.showProgress;
    o[A + "Animate"] = tour.animate;
    o[A + "ShowCloseButton"] = tour.showCloseButton;

    const steps: Record<string, unknown>[] = [];
    for (const s of tour.steps)
        steps.push(await stepToXml(s, ctx));
    if (steps.length)
        o["TourStep"] = steps;

    return o;
}

// Signum's `triggerValue` ladder: a TypeEntity is its CleanName, a symbol its Key, another user asset
// "CleanType|guid" — so the file is readable and portable across databases.
async function triggerToXml(trigger: Lite<Entity>, ctx: IToXmlContext): Promise<string> {
    if (trigger.entityType === TypeEntity)
        return (await ctx.retrieveLite(trigger as Lite<TypeEntity>)).cleanName;
    if (trigger.entityType === TourTriggerSymbol)
        return (await ctx.retrieveLite(trigger as Lite<TourTriggerSymbol>)).key;
    const cleanName = trigger.entityType.name.replace(/Entity$/, "");
    return `${cleanName}|${trigger.id}`;
}

async function stepToXml(s: TourStepEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const o: Record<string, unknown> = {};
    if (s.title != null) o[A + "Title"] = s.title;
    if (s.side != null) o[A + "Side"] = Enum.toName(PopoverSide, s.side);
    if (s.align != null) o[A + "Align"] = Enum.toName(PopoverAlign, s.align);
    if (s.click != null) o[A + "Click"] = Enum.toName(ClickTrigger, s.click);
    if (s.description != null) o["Description"] = s.description;

    const cssSteps: Record<string, unknown>[] = [];
    for (const cs of s.cssSteps)
        cssSteps.push(await cssStepToXml(cs, ctx));
    if (cssSteps.length)
        o["CssStep"] = cssSteps;

    return o;
}

async function cssStepToXml(cs: CssStepEmbedded, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const o: Record<string, unknown> = {};
    o[A + "Type"] = Enum.toName(CssStepType, cs.type);
    if (cs.cssSelector != null) o[A + "CssSelector"] = cs.cssSelector;
    if (cs.property != null) o[A + "Property"] = cs.property;
    if (cs.toolbarContent != null) o[A + "ToolbarContent"] = await toolbarContentToXml(cs.toolbarContent, ctx);
    if (cs.dashboardPart != null) o[A + "DashboardPart"] = cs.dashboardPart;
    if (cs.tableColumn != null) o[A + "TableColumn"] = cs.tableColumn;
    return o;
}

async function toolbarContentToXml(lite: Lite<Entity>, ctx: IToXmlContext): Promise<string> {
    if (lite.entityType === QueryEntity)
        return (await ctx.retrieveLite(lite as Lite<QueryEntity>)).key;
    const cleanName = lite.entityType.name.replace(/Entity$/, "");
    return `${cleanName}|${lite.id}`;
}

function fromXml(tour: TourEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): void {
    tour.trigger = triggerFromXml(String(xml[A + "Trigger"]), ctx);
    tour.showProgress = xml[A + "ShowProgress"] === true || xml[A + "ShowProgress"] === "true";
    tour.animate = xml[A + "Animate"] == null || xml[A + "Animate"] === true || xml[A + "Animate"] === "true";
    tour.showCloseButton = xml[A + "ShowCloseButton"] == null || xml[A + "ShowCloseButton"] === true || xml[A + "ShowCloseButton"] === "true";

    tour.steps = asArray(xml["TourStep"]).map((sx, i) => {
        const s = new TourStepEntity();
        s.order = toInt(i);
        s.title = String(sx[A + "Title"] ?? "");
        s.side = sx[A + "Side"] == null ? null : Enum.toValue(PopoverSide, String(sx[A + "Side"]) as never);
        s.align = sx[A + "Align"] == null ? null : Enum.toValue(PopoverAlign, String(sx[A + "Align"]) as never);
        s.click = sx[A + "Click"] == null ? null : Enum.toValue(ClickTrigger, String(sx[A + "Click"]) as never);
        s.description = String(sx["Description"] ?? "");
        s.cssSteps = asArray(sx["CssStep"]).map((cx, j) => cssStepFromXml(cx, j, ctx));
        return s;
    });
}

function cssStepFromXml(cx: Record<string, unknown>, order: number, ctx: IFromXmlContext): CssStepEmbedded {
    const cs = new CssStepEmbedded();
    cs.order = toInt(order);
    cs.type = Enum.toValue(CssStepType, String(cx[A + "Type"]) as never);
    cs.cssSelector = cx[A + "CssSelector"] == null ? null : String(cx[A + "CssSelector"]);
    cs.property = cx[A + "Property"] == null ? null : String(cx[A + "Property"]);
    cs.dashboardPart = cx[A + "DashboardPart"] == null ? null : String(cx[A + "DashboardPart"]);
    cs.tableColumn = cx[A + "TableColumn"] == null ? null : String(cx[A + "TableColumn"]);

    const content = cx[A + "ToolbarContent"] == null ? null : String(cx[A + "ToolbarContent"]);
    cs.toolbarContent = content == null ? null
        : content.includes("|") ? ctx.getEntity(content.substring(content.indexOf("|") + 1)).toLite()
            : ctx.getQuery(content).toLite();

    return cs;
}

function triggerFromXml(value: string, ctx: IFromXmlContext): Lite<Entity> {
    if (value.includes("|")) {
        // "CleanType|guid" — another user asset in (or already imported from) the same file.
        const guid = value.substring(value.indexOf("|") + 1);
        return ctx.getEntity(guid).toLite();
    }

    const type = ctx.tryGetType(value);
    if (type != null)
        return type as Lite<Entity>;

    const symbol = SymbolLogic.tryToSymbol(TourTriggerSymbol, value);
    if (symbol != null)
        return symbol.toLite();

    throw new Error(`Trigger '${value}' not found`);
}

function asArray(value: unknown): Record<string, unknown>[] {
    if (value == null) return [];
    return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
}
