import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentOperations } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { retrieve, deleteList } from "@altea/altea/server/Database";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import type { Entity, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { Enum } from "@altea/altea/data/enum";
import { UserAssetLogic } from "@altea/altea-user-assets/server/UserAssetLogic.server";
import { UserAssetOwnerAuth } from "@altea/altea-user-assets/server/UserAssetOwnerAuth.server";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import {
    DashboardEntity, DashboardOperation, DashboardEntity_Part, DashboardEmbedededInEntityEnum, type IPartEntity,
} from "../data/Dashboard";
import { registerDashboardXml, registerBasePartsXml } from "./DashboardXml.server";
import { DashboardServer } from "./DashboardServer.server";
import { ToolbarLogic } from "@altea/altea-toolbar/server/ToolbarLogic.server";

// Port of Signum's DashboardLogic.Start (Signum.Dashboard/DashboardLogic.cs). Registers the Dashboard
// entity + its Save/Delete/Clone operations + query, the in-memory cache (Signum's ResetLazy GlobalLazy),
// the XML (de)serializer, the part registry other modules extend, and — when a web host is present — the
// HTTP surface.
//
// altea divergences, documented inline:
//  - Signum's `Polymorphic<Func<IPartEntity, …, CachedQueryDefinition>>` + CachedQueryEntity +
//    RegenerateCachedQueries + the SchedulerLogic task are DEFERRED (they need Signum.Files' FilePathEmbedded
//    and Signum.Scheduler, neither ported). The dashboard always queries LIVE.
//  - Signum's `PartNames` dictionary (XML element name → part type) becomes a richer PART REGISTRY here:
//    each part type registers its XML (de)serializer AND its clone, because altea keeps `IPartEntity.Clone/
//    ToXml/FromXml` off the isomorphic entity. Other modules register their parts from their own Logic.start
//    (Signum did it inside `sb.Schema.WhenIncluded<DashboardEntity>`).
//  - Signum's server `ParseData` on Retrieved / AfterDeserialization is dropped: altea resolves query tokens
//    CLIENT-side, so the server never materialises a QueryToken from the stored tokenString.
//  - Owner scoping IS ported (registerUserTypeCondition / registerRoleTypeCondition below + the in-memory
//    visibility filter every lookup applies), but altea needs no per-part mirroring of the conditions: a Part
//    inherits its owner's rules structurally — see @altea/altea-user-assets' UserAssetOwnerAuth.
//  - Omnibox wiring is omitted; the "a client just looked at this dashboard" scopes Signum reports through
//    ViewLogLogic.LogView go through the CORE seam (ExecutionMode.apiRetrievedScope), so this module needs
//    no dependency on @altea/altea-view-log. The TOOLBAR content config IS
//    registered (a Dashboard can be a toolbar element).

// ---- The part registry (Signum's DashboardLogic.PartNames + the per-entity Clone/ToXml/FromXml) ---------

export interface DashboardPartConfig<T extends IPartEntity = IPartEntity> {
    /** The part's entity ctor (Signum's `typeof(TextPartEntity)` in PartNames). */
    type: Type<T>;
    /** The XML element name Signum's ToXml wrote ("TextPart", "UserQueryPart", …). */
    elementName: string;
    /** Signum's `IPartEntity.Clone()` — a fresh, unsaved copy (used by the Clone operation). */
    clone(part: T): T;
    /** Signum's `IPartEntity.ToXml(ctx)`. */
    toXml(part: T, ctx: IToXmlContext): Record<string, unknown> | Promise<Record<string, unknown>>;
    /** Signum's `IPartEntity.FromXml(element, ctx)`; `part` is a fresh instance of `type`. */
    fromXml(part: T, xml: Record<string, unknown>, ctx: IFromXmlContext): void | Promise<void>;
}

const partRegistry = new Map<string /*elementName*/, DashboardPartConfig>();

export namespace DashboardLogic {

    // Signum's `ResetLazy<FrozenDictionary<Lite<DashboardEntity>, DashboardEntity>> Dashboards`.
    export let dashboardsLazy: ResetLazy<DashboardEntity[]> = null!;

    /** Signum's `DashboardLogic.PartNames.AddRange(…)` + the part's ToXml/FromXml/Clone, in one call.
     *  A module registers its parts from its own `XxxLogic.start` (see altea-user-queries / altea-chart). */
    export function registerPart<T extends IPartEntity>(config: DashboardPartConfig<T>): void {
        partRegistry.set(config.elementName, config as unknown as DashboardPartConfig);
    }

    /** Signum's `DashboardLogic.GetPart` lookup half: the config for an XML element name. */
    export function partConfigForElement(elementName: string): DashboardPartConfig {
        const c = partRegistry.get(elementName);
        if (c == null)
            throw new Error(`Dashboard: no part registered for XML element '${elementName}'`);
        return c;
    }

    /** The config for a live part entity (used by ToXml + the Clone operation). */
    export function partConfigForEntity(part: IPartEntity): DashboardPartConfig {
        for (const c of partRegistry.values())
            if (part instanceof (c.type as unknown as Function))
                return c;
        throw new Error(`Dashboard: part type '${part.constructor.name}' is not registered (DashboardLogic.registerPart)`);
    }

    export function registeredParts(): DashboardPartConfig[] {
        return [...partRegistry.values()];
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Shared user-asset infrastructure (permission + import/export HTTP surface).
        UserAssetLogic.start(sb);

        sb.include(DashboardEntity)
            .withOperations(registerDashboardOperations)
            .withQuery();

        // Signum's DashboardGraph: Save / Delete / Clone (RegenerateCachedQueries is deferred).

        // The base parts Signum registers in DashboardLogic.Start's PartNames block.
        registerBasePartsXml();
        // How a DashboardEntity itself is (de)serialized to/from XML (Signum keeps ToXml/FromXml on the
        // entity; altea uses a per-type registry — see UserAssetsImportExport.server).
        registerDashboardXml();

        // The TOOLBAR content config for a Dashboard element (Signum's ToolbarContentConfig inside
        // `WhenIncluded<ToolbarEntity>`). Inert when the toolbar module is not started.
        ToolbarLogic.registerContentConfig(DashboardEntity, {
            defaultLabel: async lite => (await cachedDashboard(lite)).displayName,
            isAuthorized: async lite => await ToolbarLogic.inMemoryFilter(await cachedDashboard(lite)),
        });

        // Signum's GlobalLazy over all dashboards, invalidated on any DashboardEntity change. Retrieved
        // through `retrieve` (not a bare table read) so each dashboard arrives with its parts, part contents
        // and token-equivalence groups — the cache backs the /home + /forEntityType lookups.
        dashboardsLazy = sb.globalLazy(async () => {
            const rows = await table(DashboardEntity).toArray() as DashboardEntity[];
            return await Promise.all(rows.map(d => retrieve(DashboardEntity, d.id)));
        }, { invalidateWith: [DashboardEntity] });

        if (sb.webBuilder)
            DashboardServer.start(sb.webBuilder);
    }

    /** The cached dashboard behind a lite (Signum's `Dashboards.Value.GetOrCreate(lite)`). */
    async function cachedDashboard(lite: Lite<DashboardEntity>): Promise<DashboardEntity> {
        const all = await dashboardsLazy.value();
        const found = all.find(d => String(d.id) === String(lite.id));
        if (found == null)
            throw new Error(`Dashboard '${String(lite.id)}' not found`);
        return found;
    }

    // ---- Owner scoping (Signum's DashboardLogic.RegisterUserTypeCondition / RegisterRoleTypeCondition) --

    /** Signum's `DashboardLogic.RegisterUserTypeCondition(sb, typeCondition)` — this dashboard belongs to the
     *  current USER. altea needs no per-part mirroring: parts inherit the dashboard's conditions structurally
     *  (see @altea/altea-user-assets' UserAssetOwnerAuth for the full note). */
    export function registerUserTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerUserTypeCondition(DashboardEntity, typeCondition);
    }

    /** Signum's `DashboardLogic.RegisterRoleTypeCondition(sb, typeCondition)` — this dashboard is global (no
     *  owner) or owned by one of the current user's roles. */
    export function registerRoleTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerRoleTypeCondition(DashboardEntity, typeCondition);
    }

    // ---- Lookups (Signum's GetHomePageDashboard / GetDashboards / GetEmbeddedDashboards) --------------
    //
    // Every lookup below serves from `dashboardsLazy`, whose factory runs in ExecutionMode.global — so the
    // row-level query filter never saw those reads and each lookup must apply the in-memory visibility filter
    // itself, exactly as Signum's `Schema.Current.GetInMemoryFilter<DashboardEntity>(userInterface: false)`.

    /** Signum's GetDashboardDefault / GetHomePageDashboard: the highest-priority standalone dashboard the
     *  current role may read (optionally matched by `key`). */
    export async function getHomePageDashboard(key?: string): Promise<DashboardEntity | undefined> {
        const all = await dashboardsLazy.value();
        const candidates = all
            .filter(d => (!key || d.key === key) && d.entityType == null && d.dashboardPriority != null)
            .sort((a, b) => (b.dashboardPriority as number) - (a.dashboardPriority as number));

        const result = (await UserAssetOwnerAuth.filterVisible(candidates))[0];
        if (result == null)
            return undefined;

        // Signum's `using (ViewLogLogic.LogView(result.ToLite(), "GetHomePageDashboard"))`.
        const after = await ExecutionMode.apiRetrievedScope(result.toLite(), "GetHomePageDashboard");
        await after?.();
        return result;
    }

    /** Signum's GetDashboards(): every standalone dashboard the current role may read, as lites (the
     *  DashboardLite carries the display name + hideQuickLink — see data/Dashboard.ts). */
    export async function getDashboards(): Promise<Lite<DashboardEntity>[]> {
        const all = await dashboardsLazy.value();
        const visible = await UserAssetOwnerAuth.filterVisible(all.filter(d => d.entityType == null));
        return visible.map(d => d.toLite() as Lite<DashboardEntity>);
    }

    /** Signum's GetDashboards(Type entityType) / GetDashboardsModel: the dashboards scoped to (and offered
     *  as quick-links of) one entity type. altea matches by the TypeEntity's clean name. */
    export async function getDashboardsForEntityType(typeCleanName: string): Promise<Lite<DashboardEntity>[]> {
        return (await getDashboardsEntity(typeCleanName)).map(d => d.toLite() as Lite<DashboardEntity>);
    }

    /** Signum's GetEmbeddedDashboards(Type): the entity-scoped dashboards that render INSIDE the entity's
     *  own view (Top / Bottom / Tab), highest priority first. */
    export async function getEmbeddedDashboards(typeCleanName: string): Promise<DashboardEntity[]> {
        return (await getDashboardsEntity(typeCleanName))
            .filter(d => d.embeddedInEntity != null
                && Enum.toName(DashboardEmbedededInEntityEnum, d.embeddedInEntity) !== "None")
            .sort((a, b) => ((b.dashboardPriority ?? 0) as number) - ((a.dashboardPriority ?? 0) as number));
    }

    /** altea-only (see DashboardServer's `/embeddedTypes`): the clean names of the entity types that have at
     *  least one dashboard embedded in their own view — the client needs it BEFORE any entity is opened. Only
     *  dashboards the current role may read count, so a user with no embedded dashboard of their own gets no
     *  widget at all. */
    export async function getEmbeddedDashboardTypeNames(): Promise<string[]> {
        const all = await dashboardsLazy.value();
        const embedded = await UserAssetOwnerAuth.filterVisible(all
            .filter(d => d.entityType != null && d.embeddedInEntity != null
                && Enum.toName(DashboardEmbedededInEntityEnum, d.embeddedInEntity) !== "None"));

        const typeIds = new Set(embedded.map(d => String(d.entityType!.id)));
        if (typeIds.size === 0)
            return [];

        const types = await table(TypeEntity).toArray() as TypeEntity[];
        return types.filter(t => typeIds.has(String(t.id))).map(t => t.cleanName);
    }

    /** Signum's GetDashboardsEntity(Type) — entity-type-scoped dashboards the current role may read. */
    export async function getDashboardsEntity(typeCleanName: string): Promise<DashboardEntity[]> {
        const typeRows = await table(TypeEntity).filter(t => t.cleanName == typeCleanName).toArray() as TypeEntity[];
        const typeId = typeRows[0]?.id;
        if (typeId == null)
            return [];

        const all = await dashboardsLazy.value();
        return await UserAssetOwnerAuth.filterVisible(
            all.filter(d => d.entityType != null && String(d.entityType.id) === String(typeId)));
    }

    /** Signum's RetrieveDashboard(lite): the full dashboard graph the page route serves — undefined when the
     *  current role may not read it (Signum threw EntityNotFoundException; the route answers 404). */
    export async function retrieveDashboard(id: string): Promise<DashboardEntity | undefined> {
        const all = await dashboardsLazy.value();
        const cached = all.find(d => String(d.id) === String(id));
        if (cached == null)
            return undefined;

        if (!await UserAssetOwnerAuth.isVisible(cached))
            return undefined;

        // Signum's `using (ViewLogLogic.LogView(dashboard, "Dashboard"))` — reported through the CORE seam
        // here, so this module needs no dependency on the (optional) view-log one.
        const after = await ExecutionMode.apiRetrievedScope(cached.toLite(), "Dashboard");
        await after?.();
        return cached;
    }

    // ---- Clone (Signum's DashboardEntity.Clone + PanelPartEmbedded.Clone + IPartEntity.Clone) --------

    export function cloneDashboard(db: DashboardEntity): DashboardEntity {
        const clone = new DashboardEntity();
        clone.entityType = db.entityType;
        clone.embeddedInEntity = db.embeddedInEntity;
        clone.owner = db.owner;
        clone.dashboardPriority = db.dashboardPriority;
        clone.autoRefreshPeriod = db.autoRefreshPeriod;
        clone.displayName = `Clone ${db.displayName}`;
        clone.hideDisplayName = db.hideDisplayName;
        clone.combineSimilarRows = db.combineSimilarRows;
        clone.key = db.key;
        clone.iconName = db.iconName;
        clone.iconColor = db.iconColor;
        clone.titleColor = db.titleColor;
        clone.parts = (db.parts ?? []).map(clonePart);
        // Signum's Clone() does NOT copy TokenEquivalencesGroups (a virtual MList) — matched here.
        clone.tokenEquivalencesGroups = [];
        return clone;
    }

    function clonePart(part: DashboardEntity_Part): DashboardEntity_Part {
        const p = new DashboardEntity_Part();
        p.title = part.title;
        p.hideTitle = part.hideTitle;
        p.tooltip = part.tooltip;
        p.row = part.row;
        p.startColumn = part.startColumn;
        p.columns = part.columns;
        p.interactionGroup = part.interactionGroup;
        p.iconName = part.iconName;
        p.iconColor = part.iconColor;
        p.titleColor = part.titleColor;
        p.customColor = part.customColor;
        p.order = part.order;
        // `guid` is intentionally left fresh (Signum's comment: a clone is a new instance).
        p.content = partConfigForEntity(part.content).clone(part.content);
        return p;
    }
}

// ---- DashboardEntity's operations (Signum's DashboardLogic.DashboardGraph) ----------------------------

function registerDashboardOperations(op: FluentOperations<DashboardEntity>): void {
    op.withExecute(DashboardOperation.Save, {
        canBeNew: true,
        canBeModified: true,
        // Signum: save, then delete the part CONTENT entities that are no longer referenced. The part ROWS
        // themselves are an owned @part collection, so the save cascade already deletes those; their content
        // is a polymorphic REFERENCE, so it needs the explicit sweep (Signum's WithCascadeDeleteMListBy).
        execute: async db => {
            const oldContents = db.isNew ? [] : (await retrieve(DashboardEntity, db.id)).parts
                ?.map(p => p.content).filter(c => c != null) ?? [];

            await db.save();

            const newContents = (db.parts ?? []).map(p => p.content).filter(c => c != null);
            const toDelete = oldContents.filter(oc =>
                !newContents.some(nc => nc.constructor === oc.constructor && String(nc.id) === String(oc.id)));

            await deleteList(toDelete as Entity[]);
        },
    });

    op.withDelete(DashboardOperation.Delete, {
        delete: async db => {
            const contents = (db.parts ?? []).map(p => p.content).filter(c => c != null);
            await db.delete();
            await deleteList(contents as Entity[]);
        },
    });

    op.withConstructFrom(DashboardEntity, DashboardOperation.Clone, {
        construct: db => DashboardLogic.cloneDashboard(db),
    });
}
