import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/data/globals"; // Array.prototype.groupToMap
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Graph } from "@altea/altea/server/graph";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Connector } from "@altea/altea/server/connection/connector";
import { insertSqlSyncGenerated, updateSqlSync, deleteSqlSync, copyRowFields } from "@altea/altea/server/save";
import { existsTable } from "@altea/altea/server/sync/syncTableRead";
import { Administrator } from "@altea/altea/server/Administrator";
import { Synchronizer, Replacements } from "@altea/altea/server/sync/synchronizer";
import { SqlPreCommand, Spacing } from "@altea/altea/server/sync/sqlPreCommand";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { FilterCondition, FilterOperation, type Filter, type Order, type Pagination } from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { Entity, type Type } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import { joinRelaxed } from "@altea/altea/data/globals/joinRelaxed";
import { SMSModelEntity, SMSTemplateEntity, SMSTemplateOperation } from "../data/SMS";

// Port of Signum.SMS's SMSModelLogic.cs — the MODEL side: a code-declared object a template renders against
// (instead of / alongside a query row), its registry table, and the default template it can generate.
//
// This is the direct sibling of @altea/altea-email's EmailModelLogic and makes the same calls:
//  - Signum's `SMSModel<T>` abstract base becomes a TS INTERFACE (`ISMSModel`): altea has no C#-style
//    protected virtual members to inherit, and a model is just an object with a known shape. `smsModel(...)`
//    below is the factory that supplies Signum's defaults (filter by the entity, no orders, all rows).
//  - `Type.FullName` (the registry key) → altea's CLEAN TYPE NAME, the stable identity altea already uses
//    for a type on the wire. `fullClassName` keeps Signum's column name.
//  - `Schema_Generating` / `Schema_Synchronizing` ARE ported: the registry rows go through the schema
//    pipeline, so a RENAMED model class keeps its row — and its id, which every SMSTemplate.model FK
//    targets — via the "SMSModel" Replacements bucket. A blind "insert what's missing" would add a row under
//    the new name and leave every template pointing at the old one.
//  - `RequiresExtraParameters` / `GetEntityConstructor` (C# reflection over the model's constructors) become
//    the registration's own `construct` callback: present ⇒ the model can be built from one entity.

/** Signum's `ISMSModel` — the object a template renders against. */
export interface ISMSModel {
    /** The entity this model is ABOUT (Signum's UntypedEntity) — becomes the message's `referred`. */
    untypedEntity: Entity | null;
    /**
     * The REGISTERED model type this object stands for (altea only — Signum's model IS a class instance, so
     * its type is its own). Falls back to `untypedEntity.constructor`, which is correct only for a model
     * registered under the entity type itself.
     */
    modelType?: Function;
    getFilters(queryName: QueryName): Filter[];
    getOrders(queryName: QueryName): Order[];
    getPagination(): Pagination | undefined;
}

/**
 * Signum's `SMSModel<T>` defaults, as a factory. Override any member on the result to get what a C# subclass
 * would get by overriding a virtual.
 */
export function smsModel(entity: Entity, overrides?: Partial<ISMSModel>): ISMSModel {
    return {
        untypedEntity: entity,
        getFilters: queryName => [new FilterCondition(
            QueryLogic.getToken(queryName, "", SubTokensOptionsAll), FilterOperation.EqualTo, entity.toLite())],
        getOrders: () => [],
        getPagination: () => undefined,
        ...overrides,
    };
}

interface SMSModelInfo {
    /** Signum's optional `queryName` argument; defaults to the model's own entity type. */
    queryName: QueryName;
    /** Signum's `DefaultTemplateConstructor` — the template generated when none exists yet. */
    defaultTemplateConstructor: () => SMSTemplateEntity;
    /** Signum's `GetEntityConstructor`: present ⇒ this model can be built from one entity. */
    construct?: (entity: Entity | null) => ISMSModel;
}

const SMS_MODEL_REPLACEMENT_KEY = "SMSModel";

export namespace SMSModelLogic {

    /** Keyed by the model's CLEAN TYPE NAME — the registry key AND the persisted `fullClassName`. */
    const registeredModels = new Map<string, SMSModelInfo>();
    const keyToType = new Map<string, Function>();

    export let smsModelsLazy: ResetLazy<Map<string, SMSModelEntity>> = null!;
    let modelToTemplatesLazy: ResetLazy<Map<string, SMSTemplateEntity[]>> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(SMSModelEntity).withQuery();

        smsModelsLazy = sb.globalLazy(async () => new Map(joinRelaxed(
            await readSMSModelRows(),
            registeredModels.keys(),
            row => row.fullClassName,
            key => key,
            (row, key) => [key, row] as [string, SMSModelEntity],
            "caching " + SMSModelEntity.name,
        )), { invalidateWith: [SMSModelEntity] });

        modelToTemplatesLazy = sb.globalLazy(async () => {
            const templates = await table(SMSTemplateEntity).filter(t => t.model != null).toArray() as SMSTemplateEntity[];
            return templates.groupToMap(t => String(t.model!.id));
        }, { invalidateWith: [SMSTemplateEntity, SMSModelEntity] });

        new Graph.ConstructFrom(SMSModelEntity, SMSTemplateOperation.CreateSMSTemplateFromModel, {
            construct: (model: SMSModelEntity) => createDefaultTemplate(model),
        }).register();

        // The registry rows are code-declared, so the SCHEMA pipeline maintains them (Signum's
        // `Schema.Generating` / `Schema.Synchronizing`) — see the header on why not an `initializing` hook.
        sb.schema.generating.push(schema => generateSMSModels(schema));
        sb.schema.synchronizing.push(replacements => synchronizeSMSModels(replacements));
    }

    /** Signum's `RegisterSMSModel<T>(defaultTemplateConstructor, queryName)`. */
    export function register(modelType: Function, info: Omit<SMSModelInfo, "queryName"> & { queryName?: QueryName }): void {
        const key = cleanTypeName(modelType as Type<Entity>);
        keyToType.set(key, modelType);
        registeredModels.set(key, {
            queryName: info.queryName ?? (modelType as QueryName),
            defaultTemplateConstructor: info.defaultTemplateConstructor,
            construct: info.construct,
        });
    }

    export function registeredKeys(): string[] {
        return [...registeredModels.keys()];
    }

    /** Signum's `ToSMSModelEntity(type)`. */
    export async function toSMSModelEntity(modelType: Function): Promise<SMSModelEntity> {
        const key = cleanTypeName(modelType as Type<Entity>);
        const found = (await smsModelsLazy.value()).get(key);
        if (found == null)
            throw new Error(`The SMSModel '${key}' was not registered (SMSModelLogic.register)`);
        return found;
    }

    /** Signum's `ToType(smsModelEntity)` — here the registry KEY, which is what everything else needs. */
    export async function toKey(model: SMSModelEntity): Promise<string> {
        for (const [key, row] of await smsModelsLazy.value())
            if (String(row.id) === String(model.id))
                return key;
        throw new Error(`The SMSModel '${model.fullClassName}' was not registered (SMSModelLogic.register)`);
    }

    /** The registered model's own constructor function, when the host handed one over. */
    export async function toType(model: SMSModelEntity): Promise<Function | undefined> {
        return keyToType.get(await toKey(model));
    }

    /** Signum's `RequiresExtraParameters` — a model with no `construct` needs the caller to build it. */
    export async function requiresExtraParameters(model: SMSModelEntity): Promise<boolean> {
        return registeredModels.get(await toKey(model))?.construct == null;
    }

    /** Signum's `CreateModel(model, entity)`. */
    export async function createModel(model: SMSModelEntity, entity: Entity | null): Promise<ISMSModel> {
        const info = registeredModels.get(await toKey(model));
        if (info?.construct == null)
            throw new Error(`The SMSModel '${model.fullClassName}' cannot be constructed from an entity`);
        return info.construct(entity);
    }

    /** The query a model's template renders against (Signum's `SMSModelInfo.QueryName`). */
    export async function queryName(model: SMSModelEntity): Promise<QueryName> {
        const info = registeredModels.get(await toKey(model));
        if (info == null)
            throw new Error(`The SMSModel '${model.fullClassName}' was not registered`);
        return info.queryName;
    }

    /**
     * Signum's `GetDefaultTemplate(smsModelEntity)`: the model's single ACTIVE template, generating and
     * saving a default one the first time it is asked for.
     */
    export async function getDefaultTemplate(model: SMSModelEntity): Promise<SMSTemplateEntity> {
        const templates = (await modelToTemplatesLazy.value()).get(String(model.id)) ?? [];

        if (templates.length === 0) {
            return await ExecutionMode.global(() => Transaction.forceNew(async () => {
                const template = await createDefaultTemplate(model);
                await template.save();
                return template;
            }));
        }

        const active = templates.filter(t => t.isActive);
        if (active.length !== 1)
            throw new Error(`Expected exactly ONE active SMSTemplate for the SMSModel '${model.fullClassName}', found ${active.length}`);
        return active[0]!;
    }

    /** Signum's `CreateDefaultTemplate(smsModel)`. */
    export async function createDefaultTemplate(model: SMSModelEntity): Promise<SMSTemplateEntity> {
        const key = await toKey(model);
        const info = registeredModels.get(key);
        if (info == null)
            throw new Error(`The SMSModel '${model.fullClassName}' was not registered`);

        const template = info.defaultTemplateConstructor();
        template.name ??= model.fullClassName;
        template.model = model;
        template.query = await QueryLogic.getQueryEntity(info.queryName);
        return template;
    }

    /** Signum's `GenerateAllTemplates` — what a terminal command calls to seed a fresh database. */
    export async function generateAllTemplates(): Promise<void> {
        for (const [key, _info] of registeredModels) {
            const model = (await smsModelsLazy.value()).get(key);
            if (model == null)
                continue;

            const existing = await table(SMSTemplateEntity).filter(t => t.model!.is(model)).toArray();
            if (existing.length > 0)
                continue;

            await ExecutionMode.global(async () => {
                const template = await createDefaultTemplate(model);
                await template.save();
            });
        }
    }

    /** The rows the DECLARED set should produce, keyed by `fullClassName` (the sync's `should`). */
    export function shouldRowsForSync(): Map<string, SMSModelEntity> {
        return new Map([...registeredModels.keys()].sort()
            .map(key => [key, SMSModelEntity.create({ fullClassName: key })]));
    }
}

// ---- the registry table's schema pipeline (Signum's Schema_Generating / Schema_Synchronizing) ----------

/** INSERT one row per declared model on a FRESH database, in sorted-key order so the DB-assigned ids are
 *  reproducible (the shape SymbolLogic.generateSymbols and EmailModelLogic both use). */
function generateSMSModels(schema: Schema): SqlPreCommand | undefined {
    const t = schema.tryTable(SMSModelEntity);
    if (t == null)
        return undefined;

    const should = [...SMSModelLogic.shouldRowsForSync().values()];
    if (should.length === 0)
        return undefined;

    return SqlPreCommand.combine(Spacing.Simple,
        ...should.map(e => insertSqlSyncGenerated(t, e as unknown as Entity)));
}

/** Diff the DECLARED models against the live rows BY `fullClassName`. A new one is INSERTed, a removed one
 *  DELETEd, and a RENAME (asked through Replacements) lands in mergeBoth, which keeps the persisted id — and
 *  therefore every SMSTemplate.model FK — and only UPDATEs the name. */
async function synchronizeSMSModels(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const t = Connector.current().schema.tryTable(SMSModelEntity);
    if (t == null)
        return undefined;

    const current = (await Administrator.tryRetrieveAll(SMSModelEntity, replacements)).toMap(row => row.fullClassName);

    return Synchronizer.synchronizeScriptReplacing<SMSModelEntity, SMSModelEntity>(
        replacements,
        SMS_MODEL_REPLACEMENT_KEY,
        Spacing.Double,
        SMSModelLogic.shouldRowsForSync(),
        current,
        (_k, e) => insertSqlSyncGenerated(t, e as unknown as Entity),
        (_k, c) => deleteSqlSync(t, c as unknown as Entity),
        (_k, e, c) => {
            copyRowFields(c as unknown as Entity, e as unknown as Entity);
            return updateSqlSync(t, c as unknown as Entity);
        },
    );
}

/** Every persisted registry row, or EMPTY when the table does not exist yet (a fresh database before
 *  `terminal create` / `sync`) — the same existsTable guard EmailModelLogic's row read uses. */
async function readSMSModelRows(): Promise<SMSModelEntity[]> {
    const t = Connector.current().schema.tryTable(SMSModelEntity);
    if (t == null)
        return [];

    try {
        if (!await existsTable(t.name))
            return [];
    } catch {
        return [];
    }

    return await table(SMSModelEntity).toArray() as SMSModelEntity[];
}
