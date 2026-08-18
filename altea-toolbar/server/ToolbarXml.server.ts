import { table } from "@altea/altea/server/table";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserAssetsImporter } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { type int } from "@altea/altea/data/basics";
import {
    ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarEntity_Elements, ToolbarMenuEntity_Elements,
    ToolbarSwitcherEntity_Options, ToolbarElementTypeEnum, ToolbarLocationEnum, ShowCountEnum,
    type ToolbarElementBase,
} from "../data/Toolbar";

// Port of Signum's ToolbarEntity.ToXml/FromXml + ToolbarElementEmbedded.ToXml/FromXml +
// ToolbarMenuEntity/ToolbarMenuElementEmbedded + ToolbarSwitcherEntity/ToolbarSwitcherOptionEmbedded
// (Toolbar.cs / ToolbarSwitcher.cs). altea keeps this OFF the isomorphic entities (System.Xml is
// server-only) — the three roots register a (de)serializer with UserAssetsImporter, as UserQuery /
// Dashboard do. Element and attribute names are preserved so a Signum-exported file round-trips.
//
// altea divergences:
//  - The `Guid` attribute Signum wrote for each root IS its `id` here (the uuid primary key — the asset's
//    portable identity), so `ctx.include(x)` returns exactly that. The ELEMENT rows keep their own `guid`
//    attribute, as in Signum.
//  - Signum's `Elements.Synchronize(…)` (match-and-update in place) becomes a plain rebuild of the row list:
//    an altea `@part` collection is replaced wholesale on save, and the rows carry no identity of their own
//    beyond `guid`.
//  - Signum's `Content` attribute is polymorphic: a QUERY key, a PERMISSION key, or the GUID of an included
//    user asset. That three-way discrimination is preserved (guid first, then query, then permission).

const A = "@_"; // fast-xml-parser attribute prefix

export function registerToolbarXml(): void {

    UserAssetsImporter.register<ToolbarEntity>({
        elementName: "Toolbar",
        create: () => new ToolbarEntity(),
        load: async guid => (await table(ToolbarEntity).filter(t => t.id == guid).toArray() as ToolbarEntity[])[0],
        save: async tb => { await (tb as unknown as { save(): Promise<void> }).save(); },
        toXml: async (tb, ctx) => {
            const o: Record<string, unknown> = {};
            o[A + "Guid"] = String(tb.id);
            o[A + "Name"] = tb.name;
            o[A + "Location"] = Enum.toName(ToolbarLocationEnum, tb.location);
            if (tb.owner != null) o[A + "Owner"] = tb.owner.key();
            if (tb.priority != null) o[A + "Priority"] = String(tb.priority);
            o["Elements"] = { ToolbarElement: await Promise.all((tb.elements ?? []).map(e => elementXml(e, ctx))) };
            return o;
        },
        fromXml: (tb, xml, ctx) => {
            tb.name = str(xml[A + "Name"]) ?? "";
            tb.location = toEnum(ToolbarLocationEnum, str(xml[A + "Location"]) ?? "Side");
            tb.owner = parseOwner(xml, ctx);
            tb.priority = xml[A + "Priority"] != null ? (Number(xml[A + "Priority"]) as int) : null;
            tb.elements = arr(xml["Elements"], "ToolbarElement").map(x =>
                elementFromXml(new ToolbarEntity_Elements(), x, ctx));
        },
    });

    UserAssetsImporter.register<ToolbarMenuEntity>({
        elementName: "ToolbarMenu",
        create: () => new ToolbarMenuEntity(),
        load: async guid => (await table(ToolbarMenuEntity).filter(t => t.id == guid).toArray() as ToolbarMenuEntity[])[0],
        save: async tm => { await (tm as unknown as { save(): Promise<void> }).save(); },
        toXml: async (tm, ctx) => {
            const o: Record<string, unknown> = {};
            o[A + "Guid"] = String(tm.id);
            o[A + "Name"] = tm.name;
            if (tm.entityType != null) o[A + "EntityType"] = (await ctx.retrieveLite(tm.entityType)).cleanName;
            if (tm.owner != null) o[A + "Owner"] = tm.owner.key();
            o["Elements"] = { ToolbarElement: await Promise.all((tm.elements ?? []).map(e => menuElementXml(e, ctx))) };
            return o;
        },
        fromXml: (tm, xml, ctx) => {
            tm.name = str(xml[A + "Name"]) ?? "";
            const entityType = str(xml[A + "EntityType"]);
            tm.entityType = entityType == null ? null : ctx.getType(entityType);
            tm.owner = parseOwner(xml, ctx);
            tm.elements = arr(xml["Elements"], "ToolbarElement").map(x => menuElementFromXml(x, ctx));
        },
    });

    UserAssetsImporter.register<ToolbarSwitcherEntity>({
        elementName: "ToolbarSwitcher",
        create: () => new ToolbarSwitcherEntity(),
        load: async guid => (await table(ToolbarSwitcherEntity).filter(t => t.id == guid).toArray() as ToolbarSwitcherEntity[])[0],
        save: async ts => { await (ts as unknown as { save(): Promise<void> }).save(); },
        toXml: async (ts, ctx) => {
            const o: Record<string, unknown> = {};
            o[A + "Guid"] = String(ts.id);
            o[A + "Name"] = ts.name;
            if (ts.owner != null) o[A + "Owner"] = ts.owner.key();
            o["Options"] = { ToolbarSwitcherOption: await Promise.all((ts.options ?? []).map(op => optionXml(op, ctx))) };
            return o;
        },
        fromXml: (ts, xml, ctx) => {
            ts.name = str(xml[A + "Name"]) ?? "";
            ts.owner = parseOwner(xml, ctx);
            ts.options = arr(xml["Options"], "ToolbarSwitcherOption").map(x => optionFromXml(x, ctx));
        },
    });
}

// ---- Elements (Signum's ToolbarElementEmbedded.ToXml / FromXml) ----------------------------------------

async function elementXml(e: ToolbarElementBase, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x: Record<string, unknown> = {};
    x[A + "Guid"] = e.guid;
    x[A + "Type"] = Enum.toName(ToolbarElementTypeEnum, e.type);
    if (e.label) x[A + "Label"] = e.label;
    if (e.iconName) x[A + "IconName"] = e.iconName;
    if (e.iconColor) x[A + "IconColor"] = e.iconColor;
    if (e.showCount != null) x[A + "ShowCount"] = Enum.toName(ShowCountEnum, e.showCount);
    if (e.openInPopup) x[A + "OpenInPopup"] = true;
    if (e.autoRefreshPeriod != null) x[A + "AutoRefreshPeriod"] = String(e.autoRefreshPeriod);
    if (e.content != null) x[A + "Content"] = await contentXml(e.content, ctx);
    if (e.url) x[A + "Url"] = e.url;
    return x;
}

// Signum's ToolbarMenuElementEmbedded.ToXml (base + the two extra attributes).
async function menuElementXml(e: ToolbarMenuEntity_Elements, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x = await elementXml(e, ctx);
    if (e.withEntity) x[A + "WithEntity"] = true;
    if (e.autoSelect) x[A + "AutoSelect"] = true;
    return x;
}

/** Signum's polymorphic `Content` attribute: a query's KEY, a permission's KEY, or the GUID of an included
 *  user asset (the asset is exported alongside — `ctx.include`). */
async function contentXml(content: Lite<Entity>, ctx: IToXmlContext): Promise<string> {
    if (content.entityType === QueryEntity)
        return (await ctx.retrieveLite(content as Lite<QueryEntity>)).key;

    if (content.entityType === PermissionSymbol)
        return (await ctx.retrieveLite(content as Lite<PermissionSymbol>)).key;

    return ctx.include(await ctx.retrieveLite(content) as IUserAssetEntity);
}

function elementFromXml<T extends ToolbarElementBase>(e: T, x: Record<string, unknown>, ctx: IFromXmlContext): T {
    e.guid = (str(x[A + "Guid"]) ?? e.guid) as typeof e.guid;
    e.type = toEnum(ToolbarElementTypeEnum, str(x[A + "Type"]) ?? "Item");
    e.label = str(x[A + "Label"]) ?? null;
    const showCount = str(x[A + "ShowCount"]);
    e.showCount = showCount == null ? null : toEnum(ShowCountEnum, showCount);
    e.iconName = str(x[A + "IconName"]) ?? null;
    e.iconColor = str(x[A + "IconColor"]) ?? null;
    e.openInPopup = bool(x[A + "OpenInPopup"]);
    e.autoRefreshPeriod = x[A + "AutoRefreshPeriod"] != null ? (Number(x[A + "AutoRefreshPeriod"]) as int) : null;
    e.content = contentFromXml(str(x[A + "Content"]), ctx);
    e.url = str(x[A + "Url"]) ?? null;
    return e;
}

function menuElementFromXml(x: Record<string, unknown>, ctx: IFromXmlContext): ToolbarMenuEntity_Elements {
    const e = elementFromXml(new ToolbarMenuEntity_Elements(), x, ctx);
    e.withEntity = bool(x[A + "WithEntity"]);
    e.autoSelect = bool(x[A + "AutoSelect"]);
    return e;
}

/** The inverse of `contentXml` (Signum's `Guid.TryParse` → `TryGetQuery` → `TryToSymbol` chain). */
function contentFromXml(content: string | undefined, ctx: IFromXmlContext): Lite<Entity> | null {
    if (!content)
        return null;

    if (isGuid(content))
        return ctx.getEntity(content).toLite() as Lite<Entity>;

    // Signum used `ctx.TryGetQuery(content)`; altea's IFromXmlContext exposes only the throwing
    // `getQuery`, so the "not a query key" case is recovered from the throw before falling through to the
    // permission lookup (and finally to Signum's own "Content not found" error).
    try {
        return ctx.getQuery(content).toLite() as Lite<Entity>;
    } catch {
        // not a registered query key — try a permission below
    }

    const permission = SymbolLogic.tryToSymbol(PermissionSymbol, content);
    if (permission != null)
        return permission.toLite() as Lite<Entity>;

    throw new Error(`Content '${content}' not found`);
}

// ---- Switcher options (Signum's ToolbarSwitcherOptionEmbedded.ToXml / FromXml) --------------------------

async function optionXml(op: ToolbarSwitcherEntity_Options, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x: Record<string, unknown> = {};
    // Signum's `ctx.Include(ToolbarMenu)` — the referenced menu rides along in the same file, keyed by guid
    // (== the menu's uuid id in altea). The FULL entity is needed: the exporter recurses into it.
    x[A + "ToolbarMenu"] = ctx.include(await ctx.retrieveLite(op.toolbarMenu));
    if (op.iconName) x[A + "IconName"] = op.iconName;
    if (op.iconColor) x[A + "IconColor"] = op.iconColor;
    return x;
}

function optionFromXml(x: Record<string, unknown>, ctx: IFromXmlContext): ToolbarSwitcherEntity_Options {
    const op = new ToolbarSwitcherEntity_Options();
    op.iconName = str(x[A + "IconName"]) ?? null;
    op.iconColor = str(x[A + "IconColor"]) ?? null;
    const guid = str(x[A + "ToolbarMenu"])!;
    op.toolbarMenu = ctx.getEntity(guid).toLite() as Lite<ToolbarMenuEntity>;
    return op;
}

// ---- small helpers -------------------------------------------------------------------------------------

/** Signum's `Owner` attribute is a lite KEY ("User;3") parsed back with `ctx.ParseLite`. */
function parseOwner(xml: Record<string, unknown>, ctx: IFromXmlContext): Lite<Entity> | null {
    const owner = str(xml[A + "Owner"]);
    return owner == null ? null : (ctx.parseLite(owner) ?? null);
}

const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isGuid(text: string): boolean {
    return guidRegex.test(text);
}

// Enum.toValue expects the narrow member-NAME union; XML gives a plain string, so widen here (an unknown
// member throws inside Enum.toValue — the right behaviour for a malformed import).
function toEnum<E extends Record<string, string | number>>(e: E, name: string): number {
    return Enum.toValue(e, name as Extract<keyof E, string>);
}

function str(v: unknown): string | undefined {
    return v == null ? undefined : String(v);
}

function bool(v: unknown): boolean {
    return v === true || v === "true" || v === "True";
}

// A parsed element with isArray:()=>true is always an array; take the first.
function firstElem(v: unknown): Record<string, unknown> {
    return (Array.isArray(v) ? v[0] : v) as Record<string, unknown>;
}

// Read the child list `childName` out of a wrapper element (both parsed as arrays).
function arr(wrapper: unknown, childName: string): Record<string, unknown>[] {
    if (wrapper == null) return [];
    const w = firstElem(wrapper);
    const list = w?.[childName];
    return (Array.isArray(list) ? list : list != null ? [list] : []) as Record<string, unknown>[];
}
