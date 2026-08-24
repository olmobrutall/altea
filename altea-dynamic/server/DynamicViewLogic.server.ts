import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentOperations } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import * as Database from "@altea/altea/server/Database";
import { Entity } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import {
    DynamicViewEntity, DynamicViewEntity_Prop, DynamicViewOperation,
    DynamicViewOverrideEntity, DynamicViewOverrideOperation,
    DynamicViewSelectorEntity, DynamicViewSelectorOperation,
} from "../data/DynamicView";
import { DynamicViewServer } from "./DynamicViewServer.server";

// Port of Signum.Dynamic's Views/DynamicViewLogic.cs — the three view tables, their operations, and the
// three lazies the routes read.
//
// altea divergences, documented inline:
//  - Signum's `ResetLazy<FrozenDictionary<Type, …>>` keyed by `Type` becomes a lazy over the flat ROW LIST,
//    with the routes indexing by the type's CLEAN NAME. altea has no `TypeEntity.ToType()` on the server
//    outside TypeLogic and the grouping bought nothing: each route looks up exactly one type.
//  - `SelectCatch` (skip a row whose TypeEntity no longer resolves) is unnecessary: nothing is resolved to a
//    runtime Type here — the clean name travels to the client as a string.
//  - Signum's three `EntityEvents<TypeEntity>().PreDeleteSqlSync` handlers cascade-delete the views of a type
//    being removed. altea's counterpart is `preUnsafeDelete` on the TypeEntity include, registered below.
export namespace DynamicViewLogic {

    export let dynamicViewsLazy: ResetLazy<DynamicViewEntity[]>;
    export let dynamicViewSelectorsLazy: ResetLazy<DynamicViewSelectorEntity[]>;
    export let dynamicViewOverridesLazy: ResetLazy<DynamicViewOverrideEntity[]>;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicViewEntity)
            .withOperations(registerDynamicViewOperations)
            .withQuery();

        dynamicViewsLazy = sb.globalLazy(
            () => table(DynamicViewEntity).toArray() as Promise<DynamicViewEntity[]>,
            { invalidateWith: [DynamicViewEntity] });

        sb.include(DynamicViewSelectorEntity)
            .withSave(DynamicViewSelectorOperation.Save)
            .withDelete(DynamicViewSelectorOperation.Delete)
            .withQuery();

        dynamicViewSelectorsLazy = sb.globalLazy(
            () => table(DynamicViewSelectorEntity).toArray() as Promise<DynamicViewSelectorEntity[]>,
            { invalidateWith: [DynamicViewSelectorEntity] });

        sb.include(DynamicViewOverrideEntity)
            .withSave(DynamicViewOverrideOperation.Save)
            .withDelete(DynamicViewOverrideOperation.Delete)
            .withQuery();

        dynamicViewOverridesLazy = sb.globalLazy(
            () => table(DynamicViewOverrideEntity).toArray() as Promise<DynamicViewOverrideEntity[]>,
            { invalidateWith: [DynamicViewOverrideEntity] });

        // Signum's three `PreDeleteSqlSync` handlers on TypeEntity: deleting a type takes its views with it.
        // altea's set-based delete event is `preUnsafeDelete`, and it is also the delete SIGNAL (there is no
        // per-row `deleted` event) — see the globalLazy invalidation note in CLAUDE.md.
        sb.schema.entityEvents(TypeEntity).preUnsafeDelete.push(async query => {
            const doomed = new Set((await query.map(t => t.cleanName).toArray()) as string[]);
            if (doomed.size === 0)
                return;

            const orphans: Entity[] = [
                ...(await dynamicViewsLazy.value()).filter(v => doomed.has(v.entityType.cleanName)),
                ...(await dynamicViewOverridesLazy.value()).filter(v => doomed.has(v.entityType.cleanName)),
                ...(await dynamicViewSelectorsLazy.value()).filter(v => doomed.has(v.entityType.cleanName)),
            ];

            if (orphans.length > 0)
                await Database.deleteList(orphans);
        });

        if (sb.webBuilder)
            DynamicViewServer.start(sb.webBuilder);
    }

    /** Signum's Construct default for `Locals`. */
    export const defaultLocals: string = "{\n"
        + "  const forceUpdate = modules.Hooks.useForceUpdate();\n"
        + "  return { forceUpdate };\n"
        + "}";

    // ---- the lookups the routes use ------------------------------------------------------------------

    export async function tryGetDynamicView(cleanName: string, viewName: string): Promise<DynamicViewEntity | undefined> {
        const all = await dynamicViewsLazy.value();
        return all.find(v => v.entityType.cleanName === cleanName && v.viewName === viewName);
    }

    export async function getDynamicViewNames(cleanName: string): Promise<string[]> {
        const all = await dynamicViewsLazy.value();
        return all.filter(v => v.entityType.cleanName === cleanName).map(v => v.viewName);
    }

    export async function tryGetSelector(cleanName: string): Promise<DynamicViewSelectorEntity | undefined> {
        const all = await dynamicViewSelectorsLazy.value();
        return all.find(s => s.entityType.cleanName === cleanName);
    }

    export async function getOverrides(cleanName: string): Promise<DynamicViewOverrideEntity[]> {
        const all = await dynamicViewOverridesLazy.value();
        return all.filter(o => o.entityType.cleanName === cleanName);
    }

    // ---- suggested find options ----------------------------------------------------------------------

    export interface SuggestedFindOptions {
        queryKey: string;
        parentToken: string;
    }

    /**
     * Signum's `GetSuggestedFindOptions` — "which registered queries have a column pointing AT this type",
     * so the designer can offer a ready-made SearchControl for each of them. Signum walks
     * `Schema.Current.Tables` looking for a column whose `ReferenceTable` is this type's table, then maps
     * the column back to a property route.
     *
     * altea reads the same relation off the REFLECTION metadata instead of off the built table columns:
     * a reference field carries its target type(s) in its `TypeReference` (`typeName` / `typeInfos()`), and
     * `PropertyRoute.generateRoutes` already enumerates every value/embedded route of a type while stopping
     * at entity references — which is exactly the set of columns Signum's recursion reaches. Fewer moving
     * parts, and it works identically for an `@implementedBy` field (Signum needs a separate branch for the
     * FieldImplementedBy case).
     */
    export async function getSuggestedFindOptions(cleanName: string): Promise<SuggestedFindOptions[]> {
        const { QueryLogic } = await import("@altea/altea/server/dynamicQuery/queryLogic");
        const { getKey } = await import("@altea/altea/data/dynamicQuery/queryUtils");
        const { PropertyRoute } = await import("@altea/altea/data/propertyRoute");

        const result: SuggestedFindOptions[] = [];

        for (const queryName of QueryLogic.queries.getQueryNames()) {
            const rootType = QueryLogic.queries.tryGetCore(queryName)?.getRootType();
            if (rootType == undefined)
                continue;

            for (const route of PropertyRoute.generateRoutes(rootType)) {
                const type = route.type;
                if (type.array || !type.is(Entity))
                    continue;

                // A reference matches when THIS type is one of the implementations it may hold — which
                // covers an `@implementedBy` field for free (Signum needs a separate FieldImplementedBy
                // branch, because it is walking COLUMNS and a polymorphic reference has several).
                if (!type.typeInfos().some(ti => ti.ctor != undefined && cleanTypeName(ti.ctor) === cleanName))
                    continue;

                result.push({
                    queryKey: getKey(queryName),
                    // ROOTLESS: altea query tokens have no Signum "Entity." root (CLAUDE.md).
                    parentToken: route.propertyString(),
                });
            }
        }

        return result;
    }

    function registerDynamicViewOperations(op: FluentOperations<DynamicViewEntity>): void {
        op.withSave(DynamicViewOperation.Save);
        op.withDelete(DynamicViewOperation.Delete);

        // Signum's Construct seeds `Locals` with a forceUpdate hook so a brand-new view already has the
        // one local every non-trivial view needs. `viewContent` is left empty: only the CLIENT can build
        // a default node tree, since the node library lives there (see createDefaultDynamicView).
        op.withConstruct(DynamicViewOperation.Create, {
            construct: (): DynamicViewEntity => DynamicViewEntity.create({
                locals: defaultLocals,
            }),
        });

        op.withConstructFrom(DynamicViewEntity, DynamicViewOperation.Clone, {
            construct: (view: DynamicViewEntity): DynamicViewEntity => DynamicViewEntity.create({
                viewName: "",
                entityType: view.entityType,
                viewContent: view.viewContent,
                locals: view.locals,
                props: view.props.map((p: DynamicViewEntity_Prop) =>
                    DynamicViewEntity_Prop.create({ name: p.name, type: p.type })),
            }),
        });
    }
}