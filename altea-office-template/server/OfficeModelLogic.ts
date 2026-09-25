import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/server/resetLazy";
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
    FilterCondition, FilterOperationKeys, Order, Pagination, type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import "@altea/altea/data/globals"; // Array.prototype.toMap
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import { parseFilter, parseOrder, parsePagination } from "@altea/altea-email/server/EmailModelLogic";
import { OfficeModelEntity, OfficeTemplateEntity, OfficeTemplateOperation, OfficeTemplateMessage } from "../data/OfficeTemplate";
import { modelClassName } from "@altea/altea-templating/server/ValueProviders";

// Port of Signum.Word's WordModelLogic.cs — see port/OfficeTemplate.md.
//
// The MODEL side: a code-declared object a template renders against (instead of, or alongside, a query
// row), its registry table, and the default template it can generate.
//
// Structurally IDENTICAL to @altea/altea-email's EmailModelLogic, deliberately: Signum's two files are
// near-copies of each other, so the ports should be too — and the request-DTO converters are SHARED with
// it rather than duplicated, since they translate the same isomorphic DTOs. A model shapes its query from
// the `queryName` alone.

/**
 * Signum's `WordModel<T>` (and its IWordModel contract): a code-declared object that supplies a template's data
 * instead of (or alongside) a query row, and shapes the query the renderer runs. One subclass per model; the
 * CLASS is the registration key (its clean name is the `office_model.class_name` row). Its own fields and
 * methods are what `@[m:…]` tokens read.
 */
export abstract class OfficeModel<T extends BaseEntity | null = Entity> {
    constructor(readonly entity: T) { }

    /** The entity this model is ABOUT. Null for a model over a non-entity (MultiEntityWord, QueryWord). */
    get untypedEntity(): Entity | null {
        return this.entity instanceof Entity ? this.entity : null;
    }

    /** The filters the template's query runs with — by default, the query's Entity column is THIS entity. */
    getFilters(queryName: QueryName): Filter[] {
        const entity = this.untypedEntity;
        if (entity == null)
            throw new Error(`${this.constructor.name} is not about an entity: override getFilters`);
        return [entityFilter(queryName, entity)];
    }

    getOrders(_queryName: QueryName): Order[] {
        return [];
    }

    getPagination(): Pagination {
        return new Pagination.All();
    }
}

/** A model class, as registered: the registry key and what `template.model` resolves back to. */
export type OfficeModelType = abstract new (...args: never[]) => OfficeModel<BaseEntity | null>;

/** Signum's MultiEntityWord — one report for a SET of entities. */
export class MultiEntityWord extends OfficeModel<MultiEntityModel> {
    override getFilters(queryName: QueryName): Filter[] {
        return [new FilterCondition(rootToken(queryName), FilterOperationKeys.IsIn, this.entity.entities)];
    }
}

/** Signum's QueryWord — one report for the RESULT of a query the user configured. */
export class QueryWord extends OfficeModel<QueryModel> {
    override getFilters(queryName: QueryName): Filter[] {
        return (this.entity.filters ?? []).map(f => parseFilter(queryName, f));
    }

    override getOrders(queryName: QueryName): Order[] {
        return (this.entity.orders ?? []).map(o => parseOrder(queryName, o));
    }

    override getPagination(): Pagination {
        return parsePagination(this.entity.pagination);
    }
}

/** One registered model type: which query it renders against, and how to build it. */
interface OfficeModelInfo {
    /** The REGISTRY name — the `office_model.class_name` column, and this registry's own key. */
    className: string;
    modelType: OfficeModelType;
    /** Signum's GetEntityType — the `T` of `OfficeModel<T>`: what the client builds before it can create a
     *  report from the model (`/api/office/constructorType`). */
    entityType: Type<BaseEntity> | undefined;
    /** The query the model renders against, or undefined when the MODEL is the data (Signum passes
     *  `queryName: null` for MultiEntityWord / QueryWord, and derives it from `T` otherwise). */
    queryName: QueryName | undefined;
    /** Build the model from a target entity. */
    construct: ((entity: Entity | null) => OfficeModel<BaseEntity | null>) | undefined;
    /** The template generated when none exists. */
    defaultTemplateConstructor: (() => OfficeTemplateEntity | Promise<OfficeTemplateEntity>) | undefined;
}

export namespace OfficeModelLogic {
    const registeredModels = new Map<string, OfficeModelInfo>();

    /** Clean name → the persisted registry row. */
    export let officeModelsLazy: ResetLazy<Map<string, OfficeModelEntity>> = null!;

    export function start(sb: SchemaBuilder): void {
        // The framework's own two models, and the reason every Signum database has a `MultiEntityWord` and a
        // `QueryWord` row. Both are registered with NO queryName: the model IS the data — a set of entities, or a
        // query the user configured — so there is nothing to query it against.
        registerOfficeModel({
            modelType: MultiEntityWord, queryName: undefined, entityType: MultiEntityModel,
            construct: e => new MultiEntityWord(e as unknown as MultiEntityModel),
        });
        registerOfficeModel({
            modelType: QueryWord, queryName: undefined, entityType: QueryModel,
            construct: e => new QueryWord(e as unknown as QueryModel),
        });

        sb.include(OfficeModelEntity).withQuery();

        // Registered on the TEMPLATE's graph, from the MODEL: "give this
        // model the template its defaultTemplateConstructor describes". The symbol was declared and
        // never registered here, so the operation did not exist at runtime and a Southwind database's
        // row had no counterpart — both helpers it needs were already here.
        sb.include(OfficeTemplateEntity)
            .withConstructFrom(OfficeModelEntity, OfficeTemplateOperation.CreateOfficeTemplateFromOfficeModel, {
                canConstruct: (m: OfficeModelEntity) => hasDefaultTemplateConstructor(m) ? null
                    : OfficeTemplateMessage.NoDefaultTemplateDefined.niceToString(),
                construct: (m: OfficeModelEntity) => createDefaultTemplateInternal(m),
            });

        officeModelsLazy = sb.globalLazy(async () => {
            const rows = await ExecutionMode.global(() => tableQuery(OfficeModelEntity).toArray());
            return new Map(rows.map(r => [r.className, r]));
        }, { invalidateWith: [OfficeModelEntity] });

        // Deleting a model must take its templates with it.
        sb.schema.entityEvents(OfficeModelEntity).preDeleteSqlSync.push(e => deleteTemplatesOfModel(sb.schema, e));

        sb.schema.generating.push(schemaGenerating);
        sb.schema.synchronizing.push(synchronizeOfficeModels);
    }

    /** The rows that SHOULD exist, keyed by clean name — the seed for generation and the sync diff. */
    export function shouldRowsForSync(): Map<string, OfficeModelEntity> {
        return new Map([...registeredModels.values()]
            .map(info => info.className)
            .sort()
            .map(name => [name, OfficeModelEntity.create({ className: name })]));
    }

    /**
     * Call BEFORE start — the registry table is seeded from these keys (the model class's clean name).
     * `entityType` defaults to `queryName`, as Signum's queryName defaults to the model's `T`.
     */
    export function registerOfficeModel(options: {
        modelType: OfficeModelType;
        queryName: QueryName | undefined;
        entityType?: Type<BaseEntity>;
        construct?: (entity: Entity | null) => OfficeModel<BaseEntity | null>;
        defaultTemplateConstructor?: () => OfficeTemplateEntity | Promise<OfficeTemplateEntity>;
    }): void {
        const className = modelClassName(options.modelType);
        registeredModels.set(className, {
            className,
            modelType: options.modelType,
            queryName: options.queryName,
            entityType: options.entityType ?? options.queryName,
            construct: options.construct,
            defaultTemplateConstructor: options.defaultTemplateConstructor,
        });
    }

    function info(modelEntity: OfficeModelEntity): OfficeModelInfo {
        const found = registeredModels.get(modelEntity.className);
        if (found == null)
            throw new Error(`The OfficeModel '${modelEntity.className}' was not registered`);
        return found;
    }

    export async function toOfficeModelEntity(modelType: OfficeModelType): Promise<OfficeModelEntity> {
        return await getOfficeModelEntity(modelClassName(modelType));
    }

    export async function getOfficeModelEntity(className: string): Promise<OfficeModelEntity> {
        const found = (await officeModelsLazy.value()).get(className);
        if (found == null)
            throw new Error(
                `The OfficeModel '${className}' has no registry row — was it registered before ` +
                `OfficeTemplateLogic.start, and has the database been synchronized?`);
        return found;
    }

    export async function allOfficeModelEntities(): Promise<OfficeModelEntity[]> {
        return [...(await officeModelsLazy.value()).values()];
    }

    export function toType(modelEntity: OfficeModelEntity): OfficeModelType {
        return info(modelEntity).modelType;
    }

    /** Signum's GetEntityType — what the client must build to create a report from this model. */
    export function getEntityType(modelEntity: OfficeModelEntity): Type<BaseEntity> | undefined {
        return info(modelEntity).entityType;
    }

    /** The query a model renders against. */
    export function getQueryName(modelEntity: OfficeModelEntity): QueryName | undefined {
        return info(modelEntity).queryName;
    }

    /** A model with no single-entity constructor needs the caller to
     *  build it (the client's "create report" dialog collects them). */
    export function requiresExtraParameters(modelEntity: OfficeModelEntity): boolean {
        return info(modelEntity).construct == undefined;
    }

    export function hasDefaultTemplateConstructor(modelEntity: OfficeModelEntity): boolean {
        return info(modelEntity).defaultTemplateConstructor != undefined;
    }

    export function createModel(modelEntity: OfficeModelEntity, entity: Entity | null): OfficeModel<BaseEntity | null> {
        const construct = info(modelEntity).construct;
        if (construct == undefined)
            throw new Error(`The OfficeModel '${modelEntity.className}' cannot be built from an entity alone`);
        return construct(entity);
    }

    /** The template an unconfigured model gets. */
    export async function createDefaultTemplateInternal(modelEntity: OfficeModelEntity): Promise<OfficeTemplateEntity> {
        const i = info(modelEntity);
        if (i.defaultTemplateConstructor == undefined)
            throw new Error(
                `No OfficeTemplate for '${modelEntity.className}' found and defaultTemplateConstructor is not set`);

        const template = await i.defaultTemplateConstructor();
        template.name ||= modelEntity.className;
        template.model = modelEntity;
        template.query = i.queryName != undefined && QueryLogic.queries.tryGetCore(i.queryName) != undefined
            ? await QueryLogic.getQueryEntity(i.queryName)
            : null;

        return template;
    }

    export function registeredModelTypes(): OfficeModelType[] {
        return [...registeredModels.values()].map(i => i.modelType);
    }
}

// ---- schema pipeline -----------------------------------------------------------------------------------

/** INSERT one row per declared model on a FRESH database, in sorted-key order. */
function schemaGenerating(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(OfficeModelEntity);
    if (table == null)
        return undefined;

    const should = [...OfficeModelLogic.shouldRowsForSync().values()];
    if (should.length === 0)
        return undefined;

    return SqlPreCommand.combine(Spacing.Simple,
        ...should.map(e => insertSqlSyncGenerated(table, e)));
}

const officeModelReplacementKey = "OfficeModel";

/** Diff the DECLARED models against the live rows BY ClassName. */
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
    const current = (await Administrator.tryRetrieveAll(OfficeModelEntity, replacements)).toMap(row => row.className);

    return Synchronizer.synchronizeScriptReplacing<OfficeModelEntity, OfficeModelEntity>(
        replacements,
        officeModelReplacementKey,
        Spacing.Double,
        OfficeModelLogic.shouldRowsForSync(),
        current,
        (_k, e) => insertSqlSyncGenerated(table, e), // new model: DB assigns the id
        (_k, c) => deleteSqlSync(table, c, m => m.className == c.className),
        (_k, e, c) => {
            const oldClassName = c.className;
            // Matched (possibly through a RENAME): write the declared name onto the RETRIEVED row, which
            // keeps its persisted id — every OfficeTemplate.model FK points at it. updateSqlSync returns
            // undefined unless the row actually drifted.
            copyRowFields(c, e);
            return updateSqlSync(table, c, m => m.className == oldClassName);
        },
    );
}

/**
 * The pre-delete cascade: a model's templates go with it
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
    return new FilterCondition(rootToken(queryName), FilterOperationKeys.EqualTo, entity.toLite());
}

export { Graph, Order };
