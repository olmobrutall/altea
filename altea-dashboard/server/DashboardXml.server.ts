import { table } from "@altea/altea/server/table";
import { type int, type uuid } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import { UserAssetsImporter } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { newGuid } from "@altea/altea-user-assets/data/UserAssets";
import {
    DashboardEntity, PanelPartEmbedded, TokenEquivalenceGroupEntity, TokenEquivalenceEmbedded,
    InteractionGroupEnum, DashboardEmbedededInEntityEnum, type IPartEntity,
} from "../data/Dashboard";
import {
    TextPartEntity, ImagePartEntity, SeparatorPartEntity, HealthCheckPartEntity,
    HealthCheckElementEmbedded, CustomPartEntity, TextPartTypeEnum,
} from "../data/Parts";
import { DashboardLogic } from "./DashboardLogic.server";

// Port of Signum's DashboardEntity.ToXml / FromXml + PanelPartEmbedded.ToXml / FromXml + each base part's
// ToXml / FromXml (DashboardEntity.cs / PanelPart.cs / CustomPart.cs). altea keeps all of this OFF the
// isomorphic entities (System.Xml is server-only) — a DashboardEntity (de)serializer is registered with
// UserAssetsImporter, and each part type registers with DashboardLogic's part registry. The XML shape
// (element / attribute names) is preserved for round-trip compatibility with Signum's AuthRules-style files.
//
// altea divergences: `CacheQueryConfiguration` is not written (deferred with CachedQuery); the `Guid`
// attribute of the dashboard itself is written by the exporter (the uuid PK IS the identity).

const A = "@_"; // fast-xml-parser attribute prefix

export function registerDashboardXml(): void {
    UserAssetsImporter.register<DashboardEntity>({
        elementName: "Dashboard",
        create: () => new DashboardEntity(),
        load: async guid => (await table(DashboardEntity).filter(d => d.id == guid).toArray() as DashboardEntity[])[0],
        save: async db => { await (db as unknown as { save(): Promise<void> }).save(); },
        toXml,
        fromXml,
    });
}

async function toXml(db: DashboardEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const o: Record<string, unknown> = {};
    o[A + "DisplayName"] = db.displayName;
    if (db.entityType != null) o[A + "EntityType"] = (await ctx.retrieveLite(db.entityType)).cleanName;
    if (db.owner != null) o[A + "Owner"] = db.owner.key();
    if (db.hideDisplayName) o[A + "HideDisplayName"] = true;
    if (db.dashboardPriority != null) o[A + "DashboardPriority"] = db.dashboardPriority;
    if (db.embeddedInEntity != null) o[A + "EmbeddedInEntity"] = Enum.toName(DashboardEmbedededInEntityEnum, db.embeddedInEntity);
    o[A + "CombineSimilarRows"] = db.combineSimilarRows;
    if (db.iconName != null) o[A + "IconName"] = db.iconName;
    if (db.iconColor != null) o[A + "IconColor"] = db.iconColor;
    if (db.titleColor != null) o[A + "TitleColor"] = db.titleColor;
    if (db.key != null) o[A + "Key"] = db.key;
    if (db.hideQuickLink) o[A + "HideQuickLink"] = true;
    if (db.showTitleAsBreadcrumb) o[A + "ShowTitleAsBreadcrumb"] = true;
    if (db.autoRefreshPeriod != null) o[A + "AutoRefreshPeriod"] = db.autoRefreshPeriod;

    const parts: Record<string, unknown>[] = [];
    for (const p of db.parts ?? [])
        parts.push(await partToXml(p, ctx));
    o["Parts"] = { Part: parts };

    if (db.tokenEquivalencesGroups?.length)
        o["TokenEquivalencesGroups"] = {
            TokenEquivalenceGroup: db.tokenEquivalencesGroups.map(tokenEquivalenceGroupToXml),
        };

    return o;
}

// Signum's PanelPartEmbedded.ToXml: the geometry + chrome as attributes, the content as the single child
// element (its name identifies the part type — Signum's PartNames).
async function partToXml(p: PanelPartEmbedded, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x: Record<string, unknown> = {};
    x[A + "Guid"] = p.guid;
    x[A + "Row"] = p.row;
    x[A + "StartColumn"] = p.startColumn;
    x[A + "Columns"] = p.columns;
    if (p.title != null) x[A + "Title"] = p.title;
    if (p.hideTitle) x[A + "HideTitle"] = true;
    if (p.tooltip != null) x[A + "Tooltip"] = p.tooltip;
    if (p.iconName != null) x[A + "IconName"] = p.iconName;
    if (p.iconColor != null) x[A + "IconColor"] = p.iconColor;
    if (p.titleColor != null) x[A + "TitleColor"] = p.titleColor;
    if (p.interactionGroup != null) x[A + "InteractionGroup"] = Enum.toName(InteractionGroupEnum, p.interactionGroup);
    if (p.customColor) x[A + "CustomColor"] = p.customColor;

    const config = DashboardLogic.partConfigForEntity(p.content);
    x[config.elementName] = [await config.toXml(p.content, ctx)];
    return x;
}

function tokenEquivalenceGroupToXml(gr: TokenEquivalenceGroupEntity): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    if (gr.interactionGroup != null) x[A + "InteractionGroup"] = Enum.toName(InteractionGroupEnum, gr.interactionGroup);
    x["TokenEquivalence"] = (gr.tokenEquivalences ?? []).map(te => ({
        [A + "Query"]: te.query.key,
        [A + "Token"]: te.token.tokenString,
    }));
    return x;
}

// ---- FromXml -------------------------------------------------------------------------------------------

function fromXml(db: DashboardEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): void {
    db.displayName = str(xml[A + "DisplayName"]) ?? "";
    db.entityType = xml[A + "EntityType"] != null ? ctx.getType(str(xml[A + "EntityType"])!) : null;
    db.owner = xml[A + "Owner"] != null ? (ctx.parseLite(str(xml[A + "Owner"])!) ?? null) : null;
    db.hideDisplayName = bool(xml[A + "HideDisplayName"]);
    db.dashboardPriority = num(xml[A + "DashboardPriority"]);
    const embeddedInEntity = str(xml[A + "EmbeddedInEntity"]);
    db.embeddedInEntity = embeddedInEntity == null ? null : toEnum(DashboardEmbedededInEntityEnum, embeddedInEntity);
    db.combineSimilarRows = bool(xml[A + "CombineSimilarRows"]);
    db.iconName = str(xml[A + "IconName"]) ?? null;
    db.iconColor = str(xml[A + "IconColor"]) ?? null;
    db.titleColor = str(xml[A + "TitleColor"]) ?? null;
    db.key = str(xml[A + "Key"]) ?? null;
    db.hideQuickLink = bool(xml[A + "HideQuickLink"]);
    db.showTitleAsBreadcrumb = bool(xml[A + "ShowTitleAsBreadcrumb"]);
    db.autoRefreshPeriod = num(xml[A + "AutoRefreshPeriod"]);

    db.parts = arr(xml["Parts"], "Part").map((x, i) => partFromXml(x, i, ctx));
    db.tokenEquivalencesGroups = arr(xml["TokenEquivalencesGroups"], "TokenEquivalenceGroup")
        .map((x, i) => tokenEquivalenceGroupFromXml(x, i, ctx));
}

// Signum's PanelPartEmbedded.FromXml (+ DashboardLogic.GetPart for the content element).
function partFromXml(x: Record<string, unknown>, index: number, ctx: IFromXmlContext): PanelPartEmbedded {
    const p = new PanelPartEmbedded();
    p.guid = (str(x[A + "Guid"]) ?? newGuid()) as uuid;
    p.order = index as unknown as int;
    p.row = (num(x[A + "Row"]) ?? 0) as int;
    p.startColumn = (num(x[A + "StartColumn"]) ?? 0) as int;
    p.columns = (num(x[A + "Columns"]) ?? 12) as int;
    p.title = str(x[A + "Title"]) ?? null;
    p.hideTitle = bool(x[A + "HideTitle"]);
    p.tooltip = str(x[A + "Tooltip"]) ?? null;
    p.iconName = str(x[A + "IconName"]) ?? null;
    p.iconColor = str(x[A + "IconColor"]) ?? null;
    // Signum's legacy `UseIconColorForTitle` → TitleColor remap, preserved.
    p.titleColor = x[A + "UseIconColorForTitle"] != null
        ? (bool(x[A + "UseIconColorForTitle"]) ? p.iconColor : null)
        : (str(x[A + "TitleColor"]) ?? null);
    const interactionGroup = str(x[A + "InteractionGroup"]);
    p.interactionGroup = interactionGroup == null ? null : toEnum(InteractionGroupEnum, interactionGroup);
    p.customColor = str(x[A + "CustomColor"]) ?? null;

    // The ONE child element that is not an attribute names the part type (Signum's PartNames lookup).
    const contentEntry = Object.entries(x).find(([k]) => !k.startsWith(A) && k !== "#text");
    if (contentEntry == null)
        throw new Error(`Dashboard import: part '${p.guid}' has no content element`);

    const config = DashboardLogic.partConfigForElement(contentEntry[0]);
    const content = new (config.type as unknown as new () => IPartEntity)();
    config.fromXml(content, firstElem(contentEntry[1]), ctx);
    p.content = content;
    return p;
}

function tokenEquivalenceGroupFromXml(x: Record<string, unknown>, index: number, ctx: IFromXmlContext): TokenEquivalenceGroupEntity {
    const gr = new TokenEquivalenceGroupEntity();
    gr.order = index as unknown as int;
    const interactionGroup = str(x[A + "InteractionGroup"]);
    gr.interactionGroup = interactionGroup == null ? null : toEnum(InteractionGroupEnum, interactionGroup);
    gr.tokenEquivalences = list(x["TokenEquivalence"]).map((te, i) => {
        const row = new TokenEquivalenceEmbedded();
        row.order = i as unknown as int;
        row.query = ctx.getQuery(str(te[A + "Query"])!);
        row.token = token(str(te[A + "Token"])!);
        return row;
    });
    return gr;
}

// ---- The base parts (Signum's per-entity ToXml / FromXml / Clone in PanelPart.cs + CustomPart.cs) -------

export function registerBasePartsXml(): void {

    DashboardLogic.registerPart<TextPartEntity>({
        type: TextPartEntity,
        elementName: "TextPart",
        clone: p => {
            const c = new TextPartEntity();
            c.textContent = p.textContent;
            c.textPartType = p.textPartType;
            return c;
        },
        toXml: p => ({
            [A + "TextContent"]: p.textContent ?? "",
            [A + "TextPartType"]: Enum.toName(TextPartTypeEnum, p.textPartType),
        }),
        fromXml: (p, x) => {
            p.textContent = str(x[A + "TextContent"]) ?? null;
            p.textPartType = toEnum(TextPartTypeEnum, str(x[A + "TextPartType"]) ?? "Text");
        },
    });

    DashboardLogic.registerPart<ImagePartEntity>({
        type: ImagePartEntity,
        elementName: "ImagePart",
        clone: p => {
            const c = new ImagePartEntity();
            c.imageSrcContent = p.imageSrcContent;
            c.clickActionURL = p.clickActionURL;
            c.altText = p.altText;
            return c;
        },
        toXml: p => {
            const x: Record<string, unknown> = { [A + "ImageSrcContent"]: p.imageSrcContent };
            if (p.clickActionURL != null) x[A + "ClickActionURL"] = p.clickActionURL;
            if (p.altText != null) x[A + "AltText"] = p.altText;
            return x;
        },
        fromXml: (p, x) => {
            p.imageSrcContent = str(x[A + "ImageSrcContent"]) ?? "";
            p.clickActionURL = str(x[A + "ClickActionURL"]) ?? null;
            p.altText = str(x[A + "AltText"]) ?? null;
        },
    });

    DashboardLogic.registerPart<SeparatorPartEntity>({
        type: SeparatorPartEntity,
        elementName: "SeparatorPart",
        clone: p => {
            const c = new SeparatorPartEntity();
            c.title = p.title;
            return c;
        },
        toXml: p => p.title == null ? {} : { [A + "Title"]: p.title },
        fromXml: (p, x) => { p.title = str(x[A + "Title"]) ?? null; },
    });

    DashboardLogic.registerPart<HealthCheckPartEntity>({
        type: HealthCheckPartEntity,
        elementName: "HealthCheckPart",
        clone: p => {
            const c = new HealthCheckPartEntity();
            c.items = (p.items ?? []).map(i => {
                const item = new HealthCheckElementEmbedded();
                item.title = i.title;
                item.checkURL = i.checkURL;
                item.navigateURL = i.navigateURL;
                item.order = i.order;
                return item;
            });
            return c;
        },
        toXml: p => ({
            HealthCheckElement: (p.items ?? []).map(i => ({
                [A + "Title"]: i.title,
                [A + "CheckURL"]: i.checkURL,
                [A + "NavigateURL"]: i.navigateURL,
            })),
        }),
        fromXml: (p, x) => {
            p.items = list(x["HealthCheckElement"]).map((i, index) => {
                const item = new HealthCheckElementEmbedded();
                item.order = index as unknown as int;
                item.title = str(i[A + "Title"]) ?? "";
                item.checkURL = str(i[A + "CheckURL"]) ?? "";
                item.navigateURL = str(i[A + "NavigateURL"]) ?? "";
                return item;
            });
        },
    });

    DashboardLogic.registerPart<CustomPartEntity>({
        type: CustomPartEntity,
        elementName: "CustomPart",
        clone: p => {
            const c = new CustomPartEntity();
            // Signum's CustomPartEntity.Clone() returns an EMPTY part (the name is intentionally dropped);
            // altea keeps the name — a clone with no renderer name would fail to render.
            c.customPartName = p.customPartName;
            return c;
        },
        toXml: p => ({ [A + "CustomPartName"]: p.customPartName }),
        fromXml: (p, x) => { p.customPartName = str(x[A + "CustomPartName"]) ?? ""; },
    });
}

// ---- small helpers (mirrors UserQueriesXml.server.ts) ---------------------------------------------------

function token(tokenString: string): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = tokenString;
    return t;
}

function toEnum<E extends Record<string, string | number>>(e: E, name: string): number {
    return Enum.toValue(e, name as Extract<keyof E, string>);
}

function str(v: unknown): string | undefined {
    return v == null ? undefined : String(v);
}
function bool(v: unknown): boolean {
    return v === true || v === "true" || v === "True";
}
function num(v: unknown): int | null {
    return v == null ? null : (Number(v) as int);
}
// A parsed element with isArray:()=>true is always an array; take the first.
function firstElem(v: unknown): Record<string, unknown> {
    return (Array.isArray(v) ? v[0] : v) as Record<string, unknown>;
}
// Read the child list `childName` out of a wrapper element `wrapper` (both parsed as arrays).
function arr(wrapper: unknown, childName: string): Record<string, unknown>[] {
    if (wrapper == null) return [];
    const w = firstElem(wrapper);
    return list(w?.[childName]);
}
function list(v: unknown): Record<string, unknown>[] {
    return (Array.isArray(v) ? v : v != null ? [v] : []) as Record<string, unknown>[];
}
