import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/fluentOperations";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Schema } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { cleanTypeName, getLocation, enumNameOf } from "@altea/altea/data/registration";
import { isEnumEntityType, getBoundEnum } from "@altea/altea/data/enumEntity";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { getKey as getQueryKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { SubTokensOptions } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { FileTypeLogic } from "@altea/altea-files/server/FileTypeLogic.server";
import type { IFileTypeAlgorithm } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import {
    AppendixHelpEntity, AppendixHelpOperation,
    NamespaceHelpEntity, NamespaceHelpOperation,
    QueryHelpEntity, QueryHelpEntity_Column, QueryHelpOperation,
    TypeHelpEntity, TypeHelpEntity_Operation, TypeHelpEntity_Property, TypeHelpOperation,
    HelpImageEntity, HelpImageFileType,
    type IHelpEntity,
} from "../data/Help";
import { HelpGenerator } from "./HelpGenerator.server";
import { InlineImagesLogic } from "./InlineImagesLogic.server";

// Port of Signum.Help's HelpLogic.cs — the module's registrations plus the per-culture caches the pages
// read. What a page shows is a MERGE of two things: the reflection-generated prose (HelpGenerator, free)
// and the stored rows (this file's four tables, optional). The caches hold the merge, per culture, and are
// dropped whenever a help row changes.
//
// altea divergences:
//  - **`Namespace` is a PACKAGE + FOLDER** (see data/Help.ts). `allTypes()` groups by it, which is also
//    what @altea/altea-map's schema map colours by.
//  - **`PropertyRouteEntity` does not exist**, so `publicRoutes(type)` yields PropertyRoutes and the
//    stored rows key on `propertyString()`. `ReflectionServer.InTypeScript(pr)` — Signum's "is this route
//    visible to the client" gate — has no counterpart: altea ships the whole reflected model, so the
//    filter is simply "is it a reflected field" (which `generateRoutes` already guarantees).
//  - **the caches are ResetLazy-of-Map**, Signum's `GlobalLazy<ConcurrentDictionary<CultureInfo, …>>`
//    one for one, except that filling an entry is ASYNC here — so each per-culture load is memoised as an
//    in-flight PROMISE, which is what keeps two concurrent first requests from both querying.
//  - **`EntityCache(ForceNew)` has no counterpart** (altea has no ambient entity cache — see CLAUDE.md on
//    altea-workflow); `Transaction.forceNew` + `ExecutionMode.global` are kept, because a cache must
//    reflect COMMITTED state and must not be filtered by the reading user's row-level rules.
//  - **`Schema.ForceCultureInfo` is gone**: the culture is resolved from the request's own UI culture
//    against the CultureInfoEntity table, falling back to the DEFAULT culture row rather than to a schema
//    setting altea does not have.
export namespace HelpLogic {

    // ---- applicability hooks (Signum's four `IsApplicable*` Funcs) --------------------------------
    // A host with several help variants per culture (per tenant, per role) narrows here.
    export let isApplicableAppendix: (e: AppendixHelpEntity) => boolean = () => true;
    export let isApplicableNamespace: (e: NamespaceHelpEntity) => boolean = () => true;
    export let isApplicableTypeHelp: (e: TypeHelpEntity) => boolean = () => true;
    export let isApplicableQueryHelp: (e: QueryHelpEntity) => boolean = () => true;

    let started = false;

    // The four caches. Each lazy holds a Map keyed by CULTURE NAME; `reset()` (fired by the entity's
    // save/delete through globalLazy's invalidateWith) drops every culture at once, as Signum's does.
    let typesLazy: ResetLazy<Map<string, Map<string, TypeHelp>>>;
    let namespacesLazy: ResetLazy<Map<string, Map<string, NamespaceHelp>>>;
    let appendicesLazy: ResetLazy<Map<string, Map<string, AppendixHelpEntity>>>;
    let queriesLazy: ResetLazy<Map<string, Map<string, QueryHelp>>>;

    export function isStarted(): boolean {
        return started;
    }

    export function start(sb: SchemaBuilder, helpImagesAlgorithm: IFileTypeAlgorithm): void {
        if (started)
            return;
        started = true;

        sb.include(TypeHelpEntity)
            .withUniqueIndex(e => [e.type, e.culture])
            .withSave(TypeHelpOperation.Save, { execute: async t => { await InlineImagesLogic.synchronizeInlineImages(t); } })
            .withDelete(TypeHelpOperation.Delete)
            .withQuery();

        // Signum's `WithUniqueIndexMList(e => e.Properties, mle => new { mle.Parent, mle.Element.Property })`
        // — on the child TABLE here, because a `@part` collection IS a table.
        sb.include(TypeHelpEntity_Property).withUniqueIndex(e => [e.typeHelp, e.propertyRoute]);
        sb.include(TypeHelpEntity_Operation).withUniqueIndex(e => [e.typeHelp, e.operation]);

        sb.include(NamespaceHelpEntity)
            .withUniqueIndex(e => [e.name, e.culture])
            .withSave(NamespaceHelpOperation.Save, { execute: async n => { await InlineImagesLogic.synchronizeInlineImages(n); } })
            .withDelete(NamespaceHelpOperation.Delete)
            .withQuery();

        sb.include(AppendixHelpEntity)
            .withUniqueIndex(e => [e.uniqueName, e.culture])
            .withSave(AppendixHelpOperation.Save, { execute: async a => { await InlineImagesLogic.synchronizeInlineImages(a); } })
            .withDelete(AppendixHelpOperation.Delete)
            .withQuery();

        sb.include(QueryHelpEntity)
            .withUniqueIndex(e => [e.query, e.culture])
            .withSave(QueryHelpOperation.Save, { execute: async q => { await InlineImagesLogic.synchronizeInlineImages(q); } })
            .withDelete(QueryHelpOperation.Delete)
            .withQuery();

        sb.include(QueryHelpEntity_Column).withUniqueIndex(e => [e.queryHelp, e.columnName]);

        sb.include(HelpImageEntity)
            .withQuery();

        FileTypeLogic.register(HelpImageFileType.Image, helpImagesAlgorithm);

        // Signum's `WithCascadeDeleteBy(i => i.Target.Entity)`: deleting a help entity takes its images
        // with it. altea has no such fluent helper, so each owner registers the set-based delete itself
        // (`preUnsafeDelete` receives the QUERY being deleted, which is exactly what the sub-select needs).
        registerImageCascade(AppendixHelpEntity);
        registerImageCascade(NamespaceHelpEntity);
        registerImageCascade(QueryHelpEntity);
        registerImageCascade(TypeHelpEntity);

        typesLazy = sb.globalLazy(async () => new Map<string, Map<string, TypeHelp>>(),
            { invalidateWith: [TypeHelpEntity, TypeHelpEntity_Property, TypeHelpEntity_Operation], name: "HelpLogic.types" });

        namespacesLazy = sb.globalLazy(async () => new Map<string, Map<string, NamespaceHelp>>(),
            { invalidateWith: [NamespaceHelpEntity], name: "HelpLogic.namespaces" });

        appendicesLazy = sb.globalLazy(async () => new Map<string, Map<string, AppendixHelpEntity>>(),
            { invalidateWith: [AppendixHelpEntity], name: "HelpLogic.appendices" });

        queriesLazy = sb.globalLazy(async () => new Map<string, Map<string, QueryHelp>>(),
            { invalidateWith: [QueryHelpEntity, QueryHelpEntity_Column], name: "HelpLogic.queries" });

    }

    function registerImageCascade<T extends IHelpEntity>(type: Type<T>): void {
        Schema.current.entityEvents(type).preUnsafeDelete.push(async query => {
            const ids = await query.map(e => e.id).toArray();
            if (ids.length === 0)
                return;
            // ALTEA: `Lite.entityType` is a CONSTRUCTOR, not a clean-name string (see CLAUDE.md on the
            // no-compat-accessors rule), so the polymorphic target is narrowed by the ctor itself.
            await table(HelpImageEntity)
                .filter(i => ids.includes(i.target.id) && i.target.entityType == type)
                .executeDelete();
        });
    }

    // ---- operations ------------------------------------------------------------------------------
    // All four help types register their Save / Delete through the fluent `withSave` / `withDelete` on
    // their include above (TypeHelp's and QueryHelp's Save also runs the inline-image extraction). There
    // used to be two extra `graph(AppendixHelpEntity, () => { })` / `graph(NamespaceHelpEntity, …)`
    // declarations here, kept "for symmetry with Signum" — but an EMPTY graph registers nothing, so both
    // were dead code with a `register()` call behind them. Removed with the graph builder.

    // ---- culture ---------------------------------------------------------------------------------

    /**
     * Signum's `GetCulture` — the culture whose help rows this request should read. Falls back from a
     * specific culture to its language ("es-ES" → "es"), which is the same fallback
     * `CultureInfoLogic`/`Localization` use, then to the schema's DEFAULT culture row.
     *
     * ALTEA: `Schema.ForceCultureInfo` has no counterpart, so the last resort is the CultureInfoEntity
     * marked as the default (or, failing that, the first row) — a value the database actually has.
     */
    export async function getCulture(): Promise<CultureInfoEntity> {
        const available = CultureInfoLogic.applicationCultures()
            .map(name => CultureInfoLogic.tryGetCulture(name))
            .filter(c => c != undefined) as CultureInfoEntity[];
        if (available.length === 0)
            throw new Error("HelpLogic: no CultureInfoEntity rows — the help content is keyed by culture.");

        const requested = CultureInfo.currentUICulture();

        const exact = available.find(c => c.name === requested);
        if (exact != null)
            return exact;

        const language = requested.tryBefore("-") ?? requested;
        const byLanguage = available.find(c => c.name === language);
        if (byLanguage != null)
            return byLanguage;

        // ALTEA: there is no "default culture" flag on the row and no Schema.ForceCultureInfo, so the
        // last resort is the first supported culture — a value the database certainly has.
        return available[0];
    }

    // ---- the type / namespace / appendix / query caches -------------------------------------------

    /** Signum's `AllTypes` — every mapped entity type except the generated enum tables. */
    export function allTypes(): Type<Entity>[] {
        return [...Schema.current.tables.entries()]
            .filter(([ctor, t]) => !t.isView && !isEnumEntityType(ctor))
            .map(([ctor]) => ctor) as Type<Entity>[];
    }

    /** Signum's `AllQueries`. */
    export function allQueries(): QueryName[] {
        return allTypes().flatMap(t => QueryLogic.getTypeQueries(t)).distinct();
    }

    /**
     * The grouping level Signum calls a namespace: the owning package + the declaring folder. Identical to
     * @altea/altea-map's `namespaceOf`, deliberately — the map and the help index must agree on what a
     * module is.
     */
    export function namespaceOf(ctor: Function): string {
        const boundEnum = getBoundEnum(ctor);
        const registeredName = boundEnum != null ? enumNameOf(boundEnum) : ctor.name;
        const location = registeredName == null ? undefined : getLocation(registeredName);
        if (location == null)
            return "";
        const slash = location.fileName.lastIndexOf("/");
        const folder = slash < 0 ? "" : location.fileName.substring(0, slash);
        return folder === "" ? location.packageName : `${location.packageName}/${folder}`;
    }

    /** The PACKAGE half of a namespace — the index page's first grouping level (Signum's "module"). */
    export function moduleOf(namespace: string): string | undefined {
        if (namespace === "")
            return undefined;
        // "@scope/pkg/folder" → "@scope/pkg";  "app/folder" → "app".
        const parts = namespace.split("/");
        return namespace.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    }

    /** Signum's `PublicRoutes(type)` — every route a help page may document. */
    export function publicRoutes(type: Type<Entity>): PropertyRoute[] {
        return PropertyRoute.generateRoutes(type);
    }

    // A per-culture async memo over one of the lazies. The IN-FLIGHT promise is stored, not just the
    // resolved value, so two concurrent first requests for the same culture share one database read.
    const inFlight = new Map<string, Promise<unknown>>();

    async function cached<V>(
        lazy: ResetLazy<Map<string, V>>,
        culture: CultureInfoEntity,
        build: () => Promise<V>,
        tag: string,
    ): Promise<V> {
        const map = await lazy.value();
        const hit = map.get(culture.name);
        if (hit != undefined)
            return hit;

        const key = `${tag}|${culture.name}`;
        let pending = inFlight.get(key) as Promise<V> | undefined;
        if (pending == undefined) {
            pending = (async () => {
                try {
                    // A cache reflects COMMITTED state and must see every row: an independent transaction
                    // in global execution mode (Signum's Transaction.ForceNew + ExecutionMode.Global).
                    const value = await Transaction.forceNew(() => ExecutionMode.global(build));
                    (await lazy.value()).set(culture.name, value);
                    return value;
                } finally {
                    inFlight.delete(key);
                }
            })();
            inFlight.set(key, pending);
        }
        return await pending;
    }

    // ---- namespaces ------------------------------------------------------------------------------

    /** Signum's `NamespaceHelp` — one namespace's merged help (stored row + the types it contains). */
    export interface NamespaceHelp {
        namespace: string;
        module?: string;
        title: string;
        description: string | null;
        types: Type<Entity>[];
        dbEntity: NamespaceHelpEntity | undefined;
        culture: CultureInfoEntity;
    }

    export async function cachedNamespacesHelp(): Promise<Map<string, NamespaceHelp>> {
        const culture = await getCulture();
        return await cached(namespacesLazy, culture, async () => {
            const byNamespace = allTypes().groupToObject(t => namespaceOf(t));

            const rows = await table(NamespaceHelpEntity).filter(n => n.culture.is(culture)).toArray();
            const rowsByName = rows.groupToObject(r => r.name);

            const result = new Map<string, NamespaceHelp>();
            for (const [ns, types] of Object.entries(byNamespace)) {
                const row = (rowsByName[ns] ?? []).find(r => isApplicableNamespace(r));
                result.set(ns, buildNamespaceHelp(ns, culture, row, types));
            }
            return result;
        }, "namespaces");
    }

    function buildNamespaceHelp(
        namespace: string,
        culture: CultureInfoEntity,
        row: NamespaceHelpEntity | undefined,
        types: Type<Entity>[],
    ): NamespaceHelp {
        return {
            namespace,
            module: moduleOf(namespace),
            // Signum: the stored title, else the namespace's LAST segment ("Signum.Authorization" → "Authorization").
            title: (row?.title || null) ?? (namespace.tryAfterLast("/") ?? namespace),
            description: row?.description ?? null,
            types,
            dbEntity: row,
            culture,
        };
    }

    export async function getNamespaceHelp(namespace: string): Promise<NamespaceHelp> {
        const cache = await cachedNamespacesHelp();
        const hit = cache.get(namespace);
        if (hit != undefined)
            return hit;

        // Signum falls back to an EMPTY NamespaceHelp rather than throwing, so a namespace whose types
        // are all hidden still renders a page.
        return buildNamespaceHelp(namespace, await getCulture(), undefined,
            allTypes().filter(t => namespaceOf(t) === namespace));
    }

    export async function getNamespaceHelps(): Promise<NamespaceHelp[]> {
        const cache = await cachedNamespacesHelp();
        return [...cache.values()];
    }

    /** The NamespaceHelpEntity a page edits — the stored row, or a fresh one carrying the key. */
    export function namespaceEntity(nh: NamespaceHelp): NamespaceHelpEntity {
        if (nh.dbEntity != null)
            return nh.dbEntity;

        return NamespaceHelpEntity.create({ culture: nh.culture, name: nh.namespace });
    }

    // ---- appendices ------------------------------------------------------------------------------

    export async function cachedAppendicesHelp(): Promise<Map<string, AppendixHelpEntity>> {
        const culture = await getCulture();
        return await cached(appendicesLazy, culture, async () => {
            const rows = await table(AppendixHelpEntity).filter(a => a.culture.is(culture)).toArray();
            const result = new Map<string, AppendixHelpEntity>();
            for (const row of rows)
                if (isApplicableAppendix(row))
                    result.set(row.uniqueName, row);
            return result;
        }, "appendices");
    }

    export async function getAppendixHelp(uniqueName: string): Promise<AppendixHelpEntity> {
        const hit = (await cachedAppendicesHelp()).get(uniqueName);
        if (hit != undefined)
            return hit;

        return AppendixHelpEntity.create({ culture: await getCulture(), uniqueName, title: uniqueName });
    }

    export async function getAppendixHelps(): Promise<AppendixHelpEntity[]> {
        return [...(await cachedAppendicesHelp()).values()];
    }

    // ---- types -----------------------------------------------------------------------------------

    /** Signum's `TypeHelp` — one type's merged help. */
    export interface TypeHelp {
        type: Type<Entity>;
        culture: CultureInfoEntity;
        info: string;
        dbEntity: TypeHelpEntity | undefined;
        properties: PropertyHelp[];
        operations: OperationHelp[];
        queries: QueryHelp[];
    }

    export interface PropertyHelp {
        propertyRoute: PropertyRoute;
        info: string;
        userDescription: string | null;
    }

    export interface OperationHelp {
        operation: import("@altea/altea/data/operations").OperationSymbol;
        info: string;
        userDescription: string | null;
    }

    export async function cachedEntityHelp(): Promise<Map<string, TypeHelp>> {
        const culture = await getCulture();
        return await cached(typesLazy, culture, async () => {
            const rows = await table(TypeHelpEntity).filter(t => t.culture.is(culture)).toArray();
            const rowsByType = rows.groupToObject(r => r.type.cleanName);

            const queries = await cachedQueriesHelpFor(culture);

            const result = new Map<string, TypeHelp>();
            for (const type of allTypes()) {
                const clean = cleanTypeName(type);
                const row = (rowsByType[clean] ?? []).find(r => isApplicableTypeHelp(r));
                result.set(clean, buildTypeHelp(type, culture, row, queries));
            }
            return result;
        }, "types");
    }

    function buildTypeHelp(
        type: Type<Entity>,
        culture: CultureInfoEntity,
        row: TypeHelpEntity | undefined,
        queries: Map<string, QueryHelp>,
    ): TypeHelp {
        const storedProps = new Map((row?.properties ?? []).map(p => [p.propertyRoute, p.description]));
        const storedOpers = new Map((row?.operations ?? []).map(o => [o.operation.key, o.description]));

        return {
            type,
            culture,
            info: HelpGenerator.getEntityHelp(type),
            dbEntity: row,
            properties: publicRoutes(type).map(pr => ({
                propertyRoute: pr,
                info: HelpGenerator.getPropertyHelp(pr),
                userDescription: storedProps.get(pr.propertyString()) ?? null,
            })),
            operations: OperationLogic.operationsForType(type).map(symbol => ({
                operation: symbol,
                info: HelpGenerator.getOperationHelp(type, symbol),
                userDescription: storedOpers.get(symbol.key) ?? null,
            })),
            queries: QueryLogic.getTypeQueries(type)
                .map(qn => queries.get(getQueryKey(qn)))
                .filter(q => q != undefined) as QueryHelp[],
        };
    }

    export async function getTypeHelp(type: Type<Entity>): Promise<TypeHelp> {
        const hit = (await cachedEntityHelp()).get(cleanTypeName(type));
        if (hit != undefined)
            return hit;

        const culture = await getCulture();
        return buildTypeHelp(type, culture, undefined, await cachedQueriesHelpFor(culture));
    }

    export async function getEntityHelps(): Promise<TypeHelp[]> {
        return [...(await cachedEntityHelp()).values()];
    }

    /** The TypeHelpEntity a page edits: the stored row, or a fresh one with the generated info filled in. */
    export function typeEntity(th: TypeHelp): TypeHelpEntity {
        const result = th.dbEntity ?? TypeHelpEntity.create({
            culture: th.culture,
            type: th.type.toTypeEntity(),
        });

        result.info = th.info;
        result.namespace = namespaceOf(th.type);

        // Signum's `GetEntity()` re-materialises EVERY documentable route/operation (not only the stored
        // ones), so the page can offer an editor for each; the ones with no description are dropped again
        // on save (see HelpServer.saveType).
        const storedProps = new Map(result.properties.map(p => [p.propertyRoute, p]));
        result.properties = th.properties
            .filter(ph => ph.propertyRoute.isAllowed() == null)
            .map(ph => {
                const existing = storedProps.get(ph.propertyRoute.propertyString());
                const row = existing ?? TypeHelpEntity_Property.create({
                    typeHelp: result,
                    propertyRoute: ph.propertyRoute.propertyString(),
                });
                row.info = ph.info;
                return row;
            });

        const storedOpers = new Map(result.operations.map(o => [o.operation.key, o]));
        result.operations = th.operations.map(oh => {
            const existing = storedOpers.get(oh.operation.key);
            const row = existing ?? TypeHelpEntity_Operation.create({ typeHelp: result, operation: oh.operation });
            row.info = oh.info;
            return row;
        });

        result.queries = th.queries.map(qh => queryEntity(qh));

        return result;
    }

    // ---- queries ---------------------------------------------------------------------------------

    /** Signum's `QueryHelp` — one query's merged help. */
    export interface QueryHelp {
        queryName: QueryName;
        culture: CultureInfoEntity;
        info: string;
        dbEntity: QueryHelpEntity | undefined;
        userDescription: string | null;
        columns: QueryColumnHelp[];
    }

    export interface QueryColumnHelp {
        /** The rootless token key (see data/Help.ts on `columnName`). */
        columnName: string;
        niceName: string;
        info: string;
        userDescription: string | null;
        isAllowed: string | null;
    }

    async function cachedQueriesHelpFor(culture: CultureInfoEntity): Promise<Map<string, QueryHelp>> {
        return await cached(queriesLazy, culture, async () => {
            const rows = await table(QueryHelpEntity).filter(q => q.culture.is(culture)).toArray();
            const rowsByKey = rows.groupToObject(r => r.query.key);

            const result = new Map<string, QueryHelp>();
            for (const qn of allQueries()) {
                const key = getQueryKey(qn);
                const row = (rowsByKey[key] ?? []).find(r => isApplicableQueryHelp(r));
                result.set(key, buildQueryHelp(qn, culture, row));
            }
            return result;
        }, "queries");
    }

    export async function cachedQueriesHelp(): Promise<Map<string, QueryHelp>> {
        return await cachedQueriesHelpFor(await getCulture());
    }

    /**
     * The columns a query's help may document. ALTEA: Signum reads
     * `IDynamicQueryCore.StaticColumns`; altea has no static column list, so this is the root token's
     * IMMEDIATE sub-tokens — which is what a user sees at the first level of the column chooser, and the
     * closest thing altea has to "the columns of this query".
     */
    export function queryColumnTokens(queryName: QueryName): QueryToken[] {
        const root = QueryLogic.tryGetRootToken(queryName);
        if (root == undefined)
            return [];
        return root.subTokens(SubTokensOptions.CanElement);
    }

    function buildQueryHelp(queryName: QueryName, culture: CultureInfoEntity, row: QueryHelpEntity | undefined): QueryHelp {
        const stored = new Map((row?.columns ?? []).map(c => [c.columnName, c.description]));

        return {
            queryName,
            culture,
            info: HelpGenerator.getQueryHelp(queryName),
            dbEntity: row,
            userDescription: row?.description ?? null,
            columns: queryColumnTokens(queryName).map(token => ({
                columnName: token.fullKey(),
                niceName: token.niceName(),
                info: HelpGenerator.getQueryColumnHelp(token),
                userDescription: stored.get(token.fullKey()) ?? null,
                isAllowed: token.isAllowed(),
            })),
        };
    }

    export async function getQueryHelp(queryName: QueryName): Promise<QueryHelp> {
        const hit = (await cachedQueriesHelp()).get(getQueryKey(queryName));
        if (hit != undefined)
            return hit;

        return buildQueryHelp(queryName, await getCulture(), undefined);
    }

    /** The QueryHelpEntity a page edits (Signum's `QueryHelp.GetEntity`). */
    export function queryEntity(qh: QueryHelp): QueryHelpEntity {
        const result = qh.dbEntity ?? QueryHelpEntity.create({
            culture: qh.culture,
            query: QueryLogic.getQueryEntity(qh.queryName),
        });

        result.info = qh.info;

        const stored = new Map(result.columns.map(c => [c.columnName, c]));
        result.columns = qh.columns
            .filter(c => c.isAllowed == null)
            .map(c => {
                const row = stored.get(c.columnName)
                    ?? QueryHelpEntity_Column.create({ queryHelp: result, columnName: c.columnName });
                row.niceName = c.niceName;
                row.info = c.info;
                return row;
            });

        return result;
    }

    // ---- misc ------------------------------------------------------------------------------------

    /** Every stored help row of every kind — the "export everything" path and the search's corpus. */
    export async function allStoredHelp(): Promise<IHelpEntity[]> {
        return await ExecutionMode.global(async () => [
            ...await table(AppendixHelpEntity).toArray(),
            ...await table(NamespaceHelpEntity).toArray(),
            ...await table(TypeHelpEntity).toArray(),
            ...await table(QueryHelpEntity).toArray(),
        ] as IHelpEntity[]);
    }

    /** Drop every cached culture (the import path, which writes rows behind the operations' back). */
    export function invalidate(): void {
        typesLazy?.reset();
        namespacesLazy?.reset();
        appendicesLazy?.reset();
        queriesLazy?.reset();
        inFlight.clear();
    }

    /** A lite of any help entity — used by the export route's `retrieveList`. */
    export type AnyHelpLite = Lite<Entity>;
}
