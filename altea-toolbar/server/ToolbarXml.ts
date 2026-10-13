import { table } from "@altea/altea/server/table";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { UserAssetsImporter, syncRows, rowGuid, referencedGuid } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import { str, bool, toEnum, arr, A } from "@altea/altea-user-assets/server/XmlUtils";
import {
    readAttributeWithTranslations, writeAttributeWithTranslations,
} from "@altea/altea-user-assets/server/TranslationXml";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { type int } from "@altea/altea/data/basics";
import {
    ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity, ToolbarEntity_Element, ToolbarMenuEntity_Element,
    ToolbarSwitcherEntity_Option, ToolbarElementType, ToolbarLocation, ShowCount,
    type ToolbarElementBaseEntity,
} from "../data/Toolbar";

// Port of the ToXml / FromXml halves of Signum.Toolbar's Toolbar.cs + ToolbarSwitcher.cs — see
// port/Toolbar.md.
//
// XML stays OFF the isomorphic entities: the three roots register a (de)serializer with UserAssetsImporter,
// as UserQuery and Dashboard do. Element and attribute names are preserved so a Signum-exported file
// round-trips.
//
// The `Guid` attribute of each ROOT is its `id` — the uuid primary key, which IS the asset's portable
// identity — and `ctx.include(x)` returns the reference to it (`UserQuery;<guid>`). The ELEMENT rows keep their own `guid` attribute,
// which is likewise their primary key, and `syncRows` matches them BY IT rather than by position.
//
// The `Content` attribute is POLYMORPHIC: a QUERY key, a PERMISSION key, or a reference to an included user
// asset (`UserQuery;<guid>`, or the bare guid older files hold). Read in that order: asset, query, permission.

export function registerToolbarXml(): void {

    UserAssetsImporter.register<ToolbarEntity>({
        elementName: "Toolbar",
        create: () => ToolbarEntity.create({}),
        load: async guid => (await table(ToolbarEntity).filter(t => t.id == guid).toArray() as ToolbarEntity[])[0],
        save: async tb => { await tb.save(); },
        toXml: async (tb, ctx) => {
            const o: Record<string, unknown> = {};
            o[A + "Guid"] = String(tb.id);
            writeAttributeWithTranslations(o, "Name", tb, t => t.name, ctx);
            o[A + "Location"] = Enum.toName(ToolbarLocation, tb.location);
            if (tb.owner != null) o[A + "Owner"] = tb.owner.key();
            if (tb.priority != null) o[A + "Priority"] = String(tb.priority);
            o["Elements"] = { ToolbarElement: await Promise.all((tb.elements ?? []).map(e => elementXml(e, ctx))) };
            return o;
        },
        fromXml: (tb, xml, ctx) => {
            tb.name = readAttributeWithTranslations(xml, "Name", tb, t => t.name, ctx) ?? "";
            tb.location = toEnum(ToolbarLocation, str(xml[A + "Location"]) ?? "Side");
            tb.owner = parseOwner(xml, ctx);
            tb.priority = xml[A + "Priority"] != null ? (Number(xml[A + "Priority"]) as int) : null;
            tb.elements = syncRows(tb.elements ?? [], arr(xml["Elements"], "ToolbarElement"),
                () => new ToolbarEntity_Element(), (e, x) => { elementFromXml(e, x, ctx); });
        },
    });

    UserAssetsImporter.register<ToolbarMenuEntity>({
        elementName: "ToolbarMenu",
        create: () => ToolbarMenuEntity.create({}),
        load: async guid => (await table(ToolbarMenuEntity).filter(t => t.id == guid).toArray() as ToolbarMenuEntity[])[0],
        save: async tm => { await tm.save(); },
        toXml: async (tm, ctx) => {
            const o: Record<string, unknown> = {};
            o[A + "Guid"] = String(tm.id);
            writeAttributeWithTranslations(o, "Name", tm, t => t.name, ctx);
            if (tm.entityType != null) o[A + "EntityType"] = (await ctx.retrieveLite(tm.entityType)).cleanName;
            if (tm.owner != null) o[A + "Owner"] = tm.owner.key();
            o["Elements"] = { ToolbarElement: await Promise.all((tm.elements ?? []).map(e => menuElementXml(e, ctx))) };
            return o;
        },
        fromXml: (tm, xml, ctx) => {
            tm.name = readAttributeWithTranslations(xml, "Name", tm, t => t.name, ctx) ?? "";
            const entityType = str(xml[A + "EntityType"]);
            tm.entityType = entityType == null ? null : ctx.getType(entityType);
            tm.owner = parseOwner(xml, ctx);
            tm.elements = syncRows(tm.elements ?? [], arr(xml["Elements"], "ToolbarElement"),
                () => new ToolbarMenuEntity_Element(), (e, x) => { menuElementFromXml(e, x, ctx); });
        },
    });

    UserAssetsImporter.register<ToolbarSwitcherEntity>({
        elementName: "ToolbarSwitcher",
        create: () => ToolbarSwitcherEntity.create({}),
        load: async guid => (await table(ToolbarSwitcherEntity).filter(t => t.id == guid).toArray() as ToolbarSwitcherEntity[])[0],
        save: async ts => { await ts.save(); },
        toXml: async (ts, ctx) => {
            const o: Record<string, unknown> = {};
            o[A + "Guid"] = String(ts.id);
            writeAttributeWithTranslations(o, "Name", ts, t => t.name, ctx);
            if (ts.owner != null) o[A + "Owner"] = ts.owner.key();
            o["Options"] = { ToolbarSwitcherOption: await Promise.all((ts.options ?? []).map(op => optionXml(op, ctx))) };
            return o;
        },
        fromXml: (ts, xml, ctx) => {
            ts.name = readAttributeWithTranslations(xml, "Name", ts, t => t.name, ctx) ?? "";
            ts.owner = parseOwner(xml, ctx);
            ts.options = arr(xml["Options"], "ToolbarSwitcherOption").map(x => optionFromXml(x, ctx));
        },
    });
}

// ---- Elements ------------------------------------------------------------------------------------------

async function elementXml(e: ToolbarElementBaseEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x: Record<string, unknown> = { ...rowGuid(e) };
    x[A + "Type"] = Enum.toName(ToolbarElementType, e.type);
    if (e.label) writeAttributeWithTranslations(x, "Label", e, r => r.label, ctx);
    if (e.iconName) x[A + "IconName"] = e.iconName;
    if (e.iconColor) x[A + "IconColor"] = e.iconColor;
    if (e.showCount != null) x[A + "ShowCount"] = Enum.toName(ShowCount, e.showCount);
    if (e.openInPopup) x[A + "OpenInPopup"] = true;
    if (e.autoRefreshPeriod != null) x[A + "AutoRefreshPeriod"] = String(e.autoRefreshPeriod);
    if (e.content != null) x[A + "Content"] = await contentXml(e.content, ctx);
    if (e.url) x[A + "Url"] = e.url;
    return x;
}

// A menu element: the base attributes plus the two extra ones.
async function menuElementXml(e: ToolbarMenuEntity_Element, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x = await elementXml(e, ctx);
    if (e.withEntity) x[A + "WithEntity"] = true;
    if (e.autoSelect) x[A + "AutoSelect"] = true;
    return x;
}

/** The polymorphic `Content` attribute: a query's KEY, a permission's KEY, or a reference to an included
 *  user asset (the asset is exported alongside — `ctx.include`). */
async function contentXml(content: Lite<Entity>, ctx: IToXmlContext): Promise<string> {
    if (content.entityType === QueryEntity)
        return (await ctx.retrieveLite(content as Lite<QueryEntity>)).key;

    if (content.entityType === PermissionSymbol)
        return (await ctx.retrieveLite(content as Lite<PermissionSymbol>)).key;

    return ctx.include(await ctx.retrieveLite(content) as IUserAssetEntity);
}

function elementFromXml<T extends ToolbarElementBaseEntity>(e: T, x: Record<string, unknown>, ctx: IFromXmlContext): T {
    e.type = toEnum(ToolbarElementType, str(x[A + "Type"]) ?? "Item");
    e.label = readAttributeWithTranslations(x, "Label", e, r => r.label, ctx);
    const showCount = str(x[A + "ShowCount"]);
    e.showCount = showCount == null ? null : toEnum(ShowCount, showCount);
    e.iconName = str(x[A + "IconName"]) ?? null;
    e.iconColor = str(x[A + "IconColor"]) ?? null;
    e.openInPopup = bool(x[A + "OpenInPopup"]);
    e.autoRefreshPeriod = x[A + "AutoRefreshPeriod"] != null ? (Number(x[A + "AutoRefreshPeriod"]) as int) : null;
    e.content = contentFromXml(str(x[A + "Content"]), ctx);
    e.url = str(x[A + "Url"]) ?? null;
    return e;
}

function menuElementFromXml(e: ToolbarMenuEntity_Element, x: Record<string, unknown>, ctx: IFromXmlContext): void {
    elementFromXml(e, x, ctx);
    e.withEntity = bool(x[A + "WithEntity"]);
    e.autoSelect = bool(x[A + "AutoSelect"]);
}

/** The inverse of `contentXml`: try an asset reference, then a query, then a permission. */
function contentFromXml(content: string | undefined, ctx: IFromXmlContext): Lite<Entity> | null {
    if (!content)
        return null;

    if (referencedGuid(content) != undefined)
        return ctx.getEntity(content).toLite() as Lite<Entity>;

    const query = ctx.tryGetQuery(content);
    if (query != null)
        return query.toLite() as Lite<Entity>;

    const permission = ctx.symbols.tryToSymbol(PermissionSymbol, content);
    if (permission != null)
        return permission.toLite() as Lite<Entity>;

    throw new Error(`Content '${content}' not found`);
}

// ---- Switcher options ----------------------------------------------------------------------------------

async function optionXml(op: ToolbarSwitcherEntity_Option, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x: Record<string, unknown> = {};
    // The referenced menu rides along in the same file. The FULL entity is needed: the exporter recurses into it.
    x[A + "ToolbarMenu"] = ctx.include(await ctx.retrieveLite(op.toolbarMenu));
    if (op.iconName) x[A + "IconName"] = op.iconName;
    if (op.iconColor) x[A + "IconColor"] = op.iconColor;
    return x;
}

function optionFromXml(x: Record<string, unknown>, ctx: IFromXmlContext): ToolbarSwitcherEntity_Option {
    const op = ToolbarSwitcherEntity_Option.create({
        iconName: str(x[A + "IconName"]) ?? null,
        iconColor: str(x[A + "IconColor"]) ?? null,
    });
    op.toolbarMenu = ctx.getEntity(str(x[A + "ToolbarMenu"])!).toLite() as Lite<ToolbarMenuEntity>;
    return op;
}

// ---- small helpers -------------------------------------------------------------------------------------

/** The `Owner` attribute is a lite KEY ("User;3"), parsed back with `ctx.parseLite`. */
function parseOwner(xml: Record<string, unknown>, ctx: IFromXmlContext): Lite<Entity> | null {
    const owner = str(xml[A + "Owner"]);
    return owner == null ? null : (ctx.parseLite(owner) ?? null);
}

