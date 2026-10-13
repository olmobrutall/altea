import { table } from "@altea/altea/server/table";
import { type int, type uuid, toInt } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import { UserAssetsImporter, syncRows, rowGuid } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import { str, bool, integer, toEnum, first, list, arr, token, A } from "@altea/altea-user-assets/server/XmlUtils";
import { newGuid } from "@altea/altea-user-assets/data/UserAssets";
import {
    DashboardEntity, DashboardEntity_Part, DashboardEntity_TokenEquivalenceGroup, DashboardEntity_TokenEquivalenceGroup_Query,
    InteractionGroup, DashboardEmbedededInEntity, CacheQueryConfigurationEmbedded, type IPartEntity,
} from "../data/Dashboard";
import {
    TextPartEntity, ImagePartEntity, SeparatorPartEntity, HealthCheckPartEntity,
    HealthCheckPartEntity_Item, CustomPartEntity, TextPartType, ToolbarMenuPartEntity,
} from "../data/Parts";
import { ToolbarMenuEntity } from "@altea/altea-toolbar/data/Toolbar";
import { DashboardLogic } from "./DashboardLogic";

// Port of Signum's DashboardEntity.ToXml / FromXml + PanelPartEmbedded.ToXml / FromXml + each base part's
// ToXml / FromXml (DashboardEntity.cs / PanelPart.cs / CustomPart.cs). altea keeps all of this OFF the
// isomorphic entities (System.Xml is server-only) — a DashboardEntity (de)serializer is registered with
// UserAssetsImporter, and each part type registers with DashboardLogic's part registry. The XML shape
// (element / attribute names) is preserved for round-trip compatibility with Signum's AuthRules-style files.
//
// altea divergence: the `Guid` attribute of the dashboard itself is written by the exporter (the uuid PK IS
// the identity).

export function registerDashboardXml(): void {
    UserAssetsImporter.register<DashboardEntity>({
        elementName: "Dashboard",
        create: () => new DashboardEntity(),
        load: async guid => (await table(DashboardEntity).filter(d => d.id == guid).toArray() as DashboardEntity[])[0],
        save: async db => { await db.save(); },
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
    if (db.embeddedInEntity != null) o[A + "EmbeddedInEntity"] = Enum.toName(DashboardEmbedededInEntity, db.embeddedInEntity);
    o[A + "CombineSimilarRows"] = db.combineSimilarRows;
    if (db.iconName != null) o[A + "IconName"] = db.iconName;
    if (db.iconColor != null) o[A + "IconColor"] = db.iconColor;
    if (db.titleColor != null) o[A + "TitleColor"] = db.titleColor;
    if (db.key != null) o[A + "Key"] = db.key;
    if (db.hideQuickLink) o[A + "HideQuickLink"] = true;
    if (db.showTitleAsBreadcrumb) o[A + "ShowTitleAsBreadcrumb"] = true;
    if (db.autoRefreshPeriod != null) o[A + "AutoRefreshPeriod"] = db.autoRefreshPeriod;

    const cqc = db.cacheQueryConfiguration;
    if (cqc != null) {
        const c: Record<string, unknown> = { [A + "TimeoutForQueries"]: cqc.timeoutForQueries, [A + "MaxRows"]: cqc.maxRows };
        if (cqc.autoRegenerateWhenOlderThan != null) c[A + "AutoRegenerateWhenOlderThan"] = cqc.autoRegenerateWhenOlderThan;
        o["CacheQueryConfiguration"] = [c];
    }

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
async function partToXml(p: DashboardEntity_Part, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const x: Record<string, unknown> = { ...rowGuid(p) };
    x[A + "Row"] = p.row;
    x[A + "StartColumn"] = p.startColumn;
    x[A + "Columns"] = p.columns;
    if (p.title != null) x[A + "Title"] = p.title;
    if (p.hideTitle) x[A + "HideTitle"] = true;
    if (p.tooltip != null) x[A + "Tooltip"] = p.tooltip;
    if (p.iconName != null) x[A + "IconName"] = p.iconName;
    if (p.iconColor != null) x[A + "IconColor"] = p.iconColor;
    if (p.titleColor != null) x[A + "TitleColor"] = p.titleColor;
    if (p.interactionGroup != null) x[A + "InteractionGroup"] = Enum.toName(InteractionGroup, p.interactionGroup);
    if (p.customColor) x[A + "CustomColor"] = p.customColor;
    // NOT in Signum, which added DefaultOpen to the entity and forgot the XML, so an exported dashboard
    // came back with every panel open again. An attribute Signum does not read is simply ignored there,
    // so writing it costs that direction nothing.
    if (p.defaultOpen != null) x[A + "DefaultOpen"] = p.defaultOpen;

    const config = DashboardLogic.partConfigForEntity(p.content);
    x[config.elementName] = [await config.toXml(p.content, ctx)];
    return x;
}

function tokenEquivalenceGroupToXml(gr: DashboardEntity_TokenEquivalenceGroup): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    if (gr.interactionGroup != null) x[A + "InteractionGroup"] = Enum.toName(InteractionGroup, gr.interactionGroup);
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
    db.dashboardPriority = integer(xml[A + "DashboardPriority"]);
    const embeddedInEntity = str(xml[A + "EmbeddedInEntity"]);
    db.embeddedInEntity = embeddedInEntity == null ? null : toEnum(DashboardEmbedededInEntity, embeddedInEntity);
    db.combineSimilarRows = bool(xml[A + "CombineSimilarRows"]);
    db.iconName = str(xml[A + "IconName"]) ?? null;
    db.iconColor = str(xml[A + "IconColor"]) ?? null;
    db.titleColor = str(xml[A + "TitleColor"]) ?? null;
    db.key = str(xml[A + "Key"]) ?? null;
    db.hideQuickLink = bool(xml[A + "HideQuickLink"]);
    db.showTitleAsBreadcrumb = bool(xml[A + "ShowTitleAsBreadcrumb"]);
    db.autoRefreshPeriod = integer(xml[A + "AutoRefreshPeriod"]);
    db.cacheQueryConfiguration = cacheQueryConfigurationFromXml(db.cacheQueryConfiguration, xml["CacheQueryConfiguration"]);

    db.parts = syncRows(db.parts ?? [], arr(xml["Parts"], "Part"), () => new DashboardEntity_Part(),
        (p, x) => fillPart(p, x, ctx));
    db.tokenEquivalencesGroups = arr(xml["TokenEquivalencesGroups"], "TokenEquivalenceGroup")
        .map(x => tokenEquivalenceGroupFromXml(x, ctx));
}

// Signum's CacheQueryConfigurationEmbedded.FromXml via CreateOrAssignEmbedded: an existing embedded is
// updated in place, and a missing element clears it.
function cacheQueryConfigurationFromXml(current: CacheQueryConfigurationEmbedded | null, element: unknown): CacheQueryConfigurationEmbedded | null {
    if (element == null)
        return null;

    const x = first(element)!;
    const cqc = current ?? new CacheQueryConfigurationEmbedded();
    cqc.timeoutForQueries = integer(x[A + "TimeoutForQueries"]) ?? toInt(5 * 60);
    cqc.maxRows = integer(x[A + "MaxRows"]) ?? toInt(1000 * 1000);
    cqc.autoRegenerateWhenOlderThan = integer(x[A + "AutoRegenerateWhenOlderThan"]);
    return cqc;
}

// Signum's PanelPartEmbedded.FromXml (+ DashboardLogic.GetPart for the content element).
function fillPart(p: DashboardEntity_Part, x: Record<string, unknown>, ctx: IFromXmlContext): void {
    p.row = (integer(x[A + "Row"]) ?? 0) as int;
    p.startColumn = (integer(x[A + "StartColumn"]) ?? 0) as int;
    p.columns = (integer(x[A + "Columns"]) ?? 12) as int;
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
    p.interactionGroup = interactionGroup == null ? null : toEnum(InteractionGroup, interactionGroup);
    p.customColor = str(x[A + "CustomColor"]) ?? null;
    p.defaultOpen = x[A + "DefaultOpen"] == null ? null : bool(x[A + "DefaultOpen"]);

    // The ONE child element that is not an attribute names the part type (Signum's PartNames lookup).
    const contentEntry = Object.entries(x).find(([k]) => !k.startsWith(A) && k !== "#text");
    if (contentEntry == null)
        throw new Error(`Dashboard import: part '${String(p.id)}' has no content element`);

    // The existing content is reused when the part keeps its type, so an unchanged part is not a change.
    const config = DashboardLogic.partConfigForElement(contentEntry[0]);
    const content = p.content instanceof config.type ? p.content : new (config.type as new () => IPartEntity)();
    config.fromXml(content, first(contentEntry[1])!, ctx);
    if (p.content !== content)
        p.content = content;
}

function tokenEquivalenceGroupFromXml(x: Record<string, unknown>, ctx: IFromXmlContext): DashboardEntity_TokenEquivalenceGroup {
    const gr = new DashboardEntity_TokenEquivalenceGroup();
    const interactionGroup = str(x[A + "InteractionGroup"]);
    gr.interactionGroup = interactionGroup == null ? null : toEnum(InteractionGroup, interactionGroup);
    gr.tokenEquivalences = list(x["TokenEquivalence"]).map(te => {
        const row = DashboardEntity_TokenEquivalenceGroup_Query.create({
            query: ctx.getQuery(str(te[A + "Query"])!),
            token: token(str(te[A + "Token"])!),
        });
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
            const c = TextPartEntity.create({ textContent: p.textContent, textPartType: p.textPartType });
            return c;
        },
        toXml: p => ({
            [A + "TextContent"]: p.textContent ?? "",
            [A + "TextPartType"]: Enum.toName(TextPartType, p.textPartType),
        }),
        fromXml: (p, x) => {
            p.textContent = str(x[A + "TextContent"]) ?? null;
            p.textPartType = toEnum(TextPartType, str(x[A + "TextPartType"]) ?? "Text");
        },
    });

    DashboardLogic.registerPart<ImagePartEntity>({
        type: ImagePartEntity,
        elementName: "ImagePart",
        clone: p => {
            const c = ImagePartEntity.create({
                imageSrcContent: p.imageSrcContent,
                clickActionURL: p.clickActionURL,
                altText: p.altText,
            });
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
            const c = SeparatorPartEntity.create({ title: p.title });
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
                const item = HealthCheckPartEntity_Item.create({
                    title: i.title,
                    checkURL: i.checkURL,
                    navigateURL: i.navigateURL,
                });
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
            p.items = list(x["HealthCheckElement"]).map(i => {
                const item = HealthCheckPartEntity_Item.create({
                    title: str(i[A + "Title"]) ?? "",
                    checkURL: str(i[A + "CheckURL"]) ?? "",
                    navigateURL: str(i[A + "NavigateURL"]) ?? "",
                });
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

    // The element name is Signum's "ToolbarPart", not the type name — Signum's ToolbarMenuPartEntity.ToXml
    // writes `new XElement("ToolbarPart", …)` and its part registry keys on that, so an exported dashboard
    // stays readable by both.
    DashboardLogic.registerPart<ToolbarMenuPartEntity>({
        type: ToolbarMenuPartEntity,
        elementName: "ToolbarPart",
        clone: p => {
            const c = ToolbarMenuPartEntity.create({ toolbarMenu: p.toolbarMenu });
            return c;
        },
        // The field is a LITE (Signum's shape) while `include` takes the entity — so the menu is retrieved
        // first, which is also what makes it travel WITH the dashboard in the export set.
        toXml: async (p, ctx) => ({ [A + "ToolbarMenu"]: ctx.include(await ctx.retrieveLite(p.toolbarMenu)) }),
        fromXml: (p, x, ctx) => {
            p.toolbarMenu = (ctx.getEntity(str(x[A + "ToolbarMenu"])!) as ToolbarMenuEntity).toLite();
        },
    });
}

// ---- small helpers (mirrors UserQueriesXml.server.ts) ---------------------------------------------------
