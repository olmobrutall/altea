import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Graph } from "@altea/altea/server/graph";
import { table as tableQuery } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Connector } from "@altea/altea/server/connection/connector";
import type { Schema } from "@altea/altea/server/schema/schema";
import { insertSqlSyncGenerated, deleteSqlSync, updateSqlSync, copyRowFields } from "@altea/altea/server/save";
import { Administrator } from "@altea/altea/server/Administrator";
import { Synchronizer, Replacements } from "@altea/altea/server/sync/synchronizer";
import { SqlPreCommand, SqlPreCommandSimple, Spacing } from "@altea/altea/server/sync/sqlPreCommand";
import {
    FilterCondition, FilterOperation, Order, Pagination, type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import "@altea/altea/data/globals"; // Array.prototype.toMap
import { Entity } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import { parseFilter, parseOrder, parsePagination } from "@altea/altea-email/server/EmailModelLogic.server";
import { OfficeModelEntity, OfficeTemplateEntity } from "../data/OfficeTemplate";
import type { IOfficeModel } from "./OfficeTemplateParameters.server";

// Port of Signum.Word's WordModelLogic.cs — the MODEL side: a code-declared object a template renders
// against (instead of / alongside a query row), its registry table, and the default template it can
// generate. Structurally identical to the already-ported @altea/altea-email EmailModelLogic, deliberately:
// Signum's two files are near-copies of each other, so the ports should be too.
//
// altea divergences, documented inline:
//  - Signum's `WordModel<T>` abstract base becomes the `officeModel()` factory below (see IOfficeModel's
//    header for why). `MultiEntityWord` / `QueryWord` become the two factories.
//  - `QueryDescription` is gone; a model shapes its query from the `queryName` alone.
//  - The FilterRequest/OrderRequest/Pagination converters are shared with altea-email rather than
//    duplicated — they translate the same isomorphic request DTOs.

export type { IOfficeModel };

/** Signum's `WordModel<T>` defaults, as a factory: pass what differs, inherit the rest. */
export function officeModel(init: Partial<IOfficeModel> & { untypedEntity: Entity | null }): IOfficeModel {
    return {
        untypedEntity: init.untypedEntity,
        // Signum's default: filter the query's Entity column to THIS entity.
        getFilters: init.getFilters ?? (queryName => [entityFilter(queryName, init.untypedEntity!)]),
        getOrders: init.getOrders ?? (() => []),
        getPagination: init.getPagination ?? (() => new Pagination.All()),
    };
}

/** Signum's MultiEntityWord — one report for a SET of entities. */
export function multiEntityOfficeModel(entity: MultiEntityModel): IOfficeModel {
    return officeModel({
        untypedEntity: null,
        getFilters: queryName => [new FilterCondition(rootToken(queryName), FilterOperation.IsIn, entity.entities)],
    });
}

/** Signum's QueryWord — one report for the RESULT of a query the user configured. */
export function queryOfficeModel(entity: QueryModel): IOfficeModel {
    return officeModel({
        untypedEntity: null,
        getFilters: queryName => (entity.filters ?? []).map(f => parseFilter(queryName, f)),
        getOrders: queryName => (entity.orders ?? []).map(o => parseOrder(queryName, o)),
        getPagination: () => parsePagination(entity.pagination),
    });
}

/** One registered model type: which query it renders against, and how to build it. */
interface OfficeModelInfo {
    modelType: Function;
    queryName: QueryName;
    /** Build the model from a target entity (Signum's single-parameter constructor). */
    construct: ((entity: Entity | null) => IOfficeModel) | undefined;
    /** Signum's DefaultTemplateConstructor — the template generated when none exists. */
    defaultTemplateConstructor: (() => OfficeTemplateEntity) | undefined;
}

export namespace OfficeModelLogic {
    const registeredModels = new Map<string, OfficeModelInfo>();

    /** Clean name → the persisted registry row (Signum's WordModelTypeToEntity / WordModelEntityToType). */
    export let officeModelsLazy: ResetLazy<Map<string, OfficeModelEntity>> = null!;

    export function start(sb: SchemaBuilder): void {
        sb.include(OfficeModelEntity).withQuery();

        officeModelsLazy = sb.globalLazy(async () => {
            const rows = await ExecutionMode.global(() => tableQuery(OfficeModelEntity).toArray());
            return new Map(rows.map(r => [r.fullClassName, r]));
        }, { invalidateWith: [OfficeModelEntity] });

        // Deleting a model must take its templates with it (Signum's PreDeleteSqlSync cascade).
        sb.schema.entityEvents(OfficeModelEntity).preDeleteSqlSync.push(e => deleteTemplatesOfModel(sb.schema, e));

        sb.schema.generating.push(schemaGenerating);
        sb.schema.synchronizing.push(synchronizeOfficeModels);
    }

    /** The rows that SHOULD exist, keyed by clean name — the seed for generation and the sync diff. */
    export function shouldRowsForSync(): Map<string, OfficeModelEntity> {
        return new Map([...registeredModels.values()]
            .map(info => cleanTypeName(info.modelType))
            .sort()
            .map(name => [name, OfficeModelEntity.create({ fullClassName: name })]));
    }

    /** Signum's RegisterWordModel. Call BEFORE start (the registry table is seeded from these keys). */
    export function registerOfficeModel(options: {
        modelType: Function;
        queryName: QueryName;
        construct?: (entity: Entity | null) => IOfficeModel;
        defaultTemplateConstructor?: () => OfficeTemplateEntity;
    }): void {
        registeredModels.set(cleanTypeName(options.modelType), {
            modelType: options.modelType,
            queryName: options.queryName,
            construct: options.construct,
            defaultTemplateConstructor: options.defaultTemplateConstructor,
        });
    }

    function info(modelEntity: OfficeModelEntity): OfficeModelInfo {
        const found = registeredModels.get(modelEntity.fullClassName);
        if (found == null)
            throw new Error(`The OfficeModel '${modelEntity.fullClassName}' was not registered`);
        return found;
    }

    /** Signum's `ToWordModelEntity(type)`. */
    export async function toOfficeModelEntity(modelType: Function): Promise<OfficeModelEntity> {
        return await getOfficeModelEntity(cleanTypeName(modelType));
    }

    /** Signum's `GetWordModelEntity(fullClassName)`. */
    export async function getOfficeModelEntity(fullClassName: string): Promise<OfficeModelEntity> {
        const found = (await officeModelsLazy.value()).get(fullClassName);
        if (found == null)
            throw new Error(
                `The OfficeModel '${fullClassName}' has no registry row — was it registered before ` +
                `OfficeTemplateLogic.start, and has the database been synchronized?`);
        return found;
    }

    export async function allOfficeModelEntities(): Promise<OfficeModelEntity[]> {
        return [...(await officeModelsLazy.value()).values()];
    }

    /** Signum's `modelEntity.ToType()`. */
    export function toType(modelEntity: OfficeModelEntity): Function {
        return info(modelEntity).modelType;
    }

    /** The query a model renders against (Signum reads it off the registered type). */
    export function getQueryName(modelEntity: OfficeModelEntity): QueryName {
        return info(modelEntity).queryName;
    }

    /** Signum's RequiresExtraParameters — a model with no single-entity constructor needs the caller to
     *  build it (the client's "create report" dialog collects them). */
    export function requiresExtraParameters(modelEntity: OfficeModelEntity): boolean {
        return info(modelEntity).construct == undefined;
    }

    export function hasDefaultTemplateConstructor(modelEntity: OfficeModelEntity): boolean {
        return info(modelEntity).defaultTemplateConstructor != undefined;
    }

    /** Signum's CreateDefaultWordModel. */
    export function createModel(modelEntity: OfficeModelEntity, entity: Entity | null): IOfficeModel {
        const construct = info(modelEntity).construct;
        if (construct == undefined)
            throw new Error(`The OfficeModel '${modelEntity.fullClassName}' cannot be built from an entity alone`);
        return construct(entity);
    }

    /** Signum's CreateDefaultTemplate — the template an unconfigured model gets. */
    export async function createDefaultTemplateInternal(modelEntity: OfficeModelEntity): Promise<OfficeTemplateEntity> {
        const i = info(modelEntity);
        if (i.defaultTemplateConstructor == undefined)
            throw new Error(
                `No OfficeTemplate for '${modelEntity.fullClassName}' found and defaultTemplateConstructor is not set`);

        const template = i.defaultTemplateConstructor();
        template.name ||= modelEntity.fullClassName;
        template.model = modelEntity;
        template.query = QueryLogic.queries.tryGetCore(i.queryName) != undefined
            ? await QueryLogic.getQueryEntity(i.queryName)
            : null;

        return template;
    }

    export function registeredModelTypes(): Function[] {
        return [...registeredModels.values()].map(i => i.modelType);
    }
}

// ---- schema pipeline -----------------------------------------------------------------------------------

/** Signum's Schema_Generating — INSERT one row per declared model on a FRESH database, in sorted-key order. */
function schemaGenerating(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(OfficeModelEntity);
    if (table == null)
        return undefined;

    const should = [...OfficeModelLogic.shouldRowsForSync().values()];
    if (should.length === 0)
        return undefined;

    return SqlPreCommand.combine(Spacing.Simple,
        ...should.map(e => insertSqlSyncGenerated(table, e as unknown as Entity)));
}

const officeModelReplacementKey = "OfficeModel";

/** Signum's Schema_Synchronizing — diff the DECLARED models against the live rows BY FullClassName. */
async function synchronizeOfficeModels(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const table = connector.schema.tryTable(OfficeModelEntity);
    if (table == null)
        return undefined;

    // Ordinary LINQ read through Administrator.tryRetrieveAll: it scopes the in-memory Table to the name
    // the database still uses when the table was renamed this run, and yields nothing when it does not
    // exist yet — so every model becomes an INSERT after the CREATE emitted earlier in the same script.
    // The retrieved ENTITIES are the `current` dictionary: each carries its persisted id and the clean
    // snapshot the Retriever took, so mergeBoth below compares the ENTITY, not a record restating its columns.
    const current = (await Administrator.tryRetrieveAll(OfficeModelEntity, replacements)).toMap(row => row.fullClassName);

    return Synchronizer.synchronizeScriptReplacing<OfficeModelEntity, OfficeModelEntity>(
        replacements,
        officeModelReplacementKey,
        Spacing.Double,
        OfficeModelLogic.shouldRowsForSync(),
        current,
        (_k, e) => insertSqlSyncGenerated(table, e as unknown as Entity), // new model: DB assigns the id
        (_k, c) => deleteSqlSync(table, c as unknown as Entity),
        (_k, e, c) => {
            // Matched (possibly through a RENAME): write the declared name onto the RETRIEVED row, which
            // keeps its persisted id — every OfficeTemplate.model FK points at it. updateSqlSync returns
            // undefined unless the row actually drifted.
            copyRowFields(c as unknown as Entity, e as unknown as Entity);
            return updateSqlSync(table, c as unknown as Entity);
        },
    );
}

/**
 * Signum's `Administrator.UnsafeDeletePreCommand(Database.Query<WordTemplateEntity>().Where(a => a.Model.Is(e)))`
 * — a SET-BASED delete emitted ahead of the model's own DELETE.
 *
 * The hook is synchronous (it contributes to a script, it does not execute), so this renders the statement
 * rather than reading the rows: the same shape `moveReferences` in the core schema synchronizer uses.
 */
function deleteTemplatesOfModel(schema: Schema, model: OfficeModelEntity): SqlPreCommand | undefined {
    const table = schema.tryTable(OfficeTemplateEntity);
    if (table == null)
        return undefined;

    const modelColumn = table.fields["model"]?.field.columns()[0];
    if (modelColumn == null)
        return undefined;

    const sb = Connector.current().sqlBuilder;
    return new SqlPreCommandSimple(
        `DELETE FROM ${sb.objectName(table.name)} WHERE ${sb.sqlEscape(modelColumn.name)} = ${model.id};`);
}

// ---- helpers -------------------------------------------------------------------------------------------

function rootToken(queryName: QueryName): ReturnType<typeof QueryLogic.getToken> {
    return QueryLogic.getToken(queryName, "", SubTokensOptionsAll);
}

function entityFilter(queryName: QueryName, entity: Entity): Filter {
    return new FilterCondition(rootToken(queryName), FilterOperation.EqualTo, entity.toLite());
}

export { Graph, Order };
