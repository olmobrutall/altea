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
import { insertSqlSyncGenerated, updateSqlSync, deleteSqlSync, copyRowFields } from "@altea/altea/server/save";
import { existsTable } from "@altea/altea/server/sync/syncTableRead";
import { Administrator } from "@altea/altea/server/Administrator";
import { Synchronizer, Replacements } from "@altea/altea/server/sync/synchronizer";
import { SqlPreCommand, Spacing } from "@altea/altea/server/sync/sqlPreCommand";
import {
    FilterCondition, FilterGroup, FilterOperationKeys, FilterGroupOperationKeys, Order, OrderTypeKeys, Pagination,
    type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import "@altea/altea/data/globals"; // Array.prototype.toMap
import { joinRelaxed } from "@altea/altea/data/globals/joinRelaxed";
import type { FilterRequest, OrderRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import { EmailModelEntity, type EmailOwnerRecipientData, type EmailOwnerData } from "../data/Email";
import { EmailTemplateEntity, EmailTemplateOperation } from "../data/EmailTemplate";
import { EmailMasterTemplateLogic } from "./EmailMasterTemplateLogic";
import { modelClassName } from "@altea/altea-templating/server/ValueProviders";

// Port of Signum.Mailing's EmailModelLogic.cs — the MODEL side: a code-declared object a template renders
// against (instead of / alongside a query row), its registry table, and the default template it can generate.
//
// altea divergences, documented inline:
//  - `EmailModel<T>` is an abstract base class, as in Signum (IEmailModel folds into it). A model is a plain
//    SERVER class: `@[m:…]` chains read the live instance, and an unreflected step is accepted as written
//    (see TemplateSync), so it needs no reflection or type registration.
//  - the registry key is altea's CLEAN TYPE NAME (`cleanTypeName(ctor)`), the stable identity altea already
//    uses for a type on the wire — and **Signum has converged on it**. It keyed by `Type.FullName` in a
//    `FullClassName` column; it now stores `type.Name` in a `ClassName` one, which is the same string altea
//    was already writing under the old name. So this stopped being a divergence and became a RENAME: the
//    member follows Signum's, and a Southwind database's rows (`UserLockedMail`, not
//    `Signum.Authorization.ResetPassword.UserLockedMail`) match without a single row moving.
//  - `Schema_Generating` / `Schema_Synchronizing` ARE ported (see the bottom of this file): the registry rows
//    go through the schema pipeline, so a RENAMED model class keeps its row — and its id, which every
//    EmailTemplate.model FK targets — via the "EmailModel" Replacements bucket.
//  - `RequiresExtraParameters` / `GetEntityConstructor` (C# reflection over the model's constructors) become
//    the registration's own `construct` callback — present ⇒ the model can be built from an entity.

/**
 * Signum's `EmailModel<T>` (and its IEmailModel contract): the object a template renders against. One subclass
 * per model; the CLASS is the registration key (its clean name is the `email_model.class_name` row), so an
 * instance needs no pointer to what it is. Its own fields and methods are what `@[m:…]` tokens read.
 */
export abstract class EmailModel<T extends BaseEntity | null = Entity> {
    constructor(readonly entity: T) { }

    /** The entity this model is ABOUT (Signum's UntypedEntity) — becomes the message's `target`. Null for a
     *  model over a non-entity (MultiEntityEmail, QueryEmail). */
    get untypedEntity(): Entity | null {
        return this.entity instanceof Entity ? this.entity : null;
    }

    /** Extra recipients the model itself supplies. */
    getRecipients(): EmailOwnerRecipientData[] {
        return [];
    }

    /** A From the model itself supplies (else the template's / the configuration's default). */
    getFrom(): EmailOwnerData | null {
        return null;
    }

    /** The filters the template's query runs with — Signum's default: the query's Entity column is THIS entity. */
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
export type EmailModelType = abstract new (...args: never[]) => EmailModel<BaseEntity | null>;

/** Signum's MultiEntityEmail — one mail for a SET of entities. */
export class MultiEntityEmail extends EmailModel<MultiEntityModel> {
    override getFilters(queryName: QueryName): Filter[] {
        return [new FilterCondition(rootToken(queryName), FilterOperationKeys.IsIn, this.entity.entities)];
    }
}

/** Signum's QueryEmail — one mail for the RESULT of a query the user configured. */
export class QueryEmail extends EmailModel<QueryModel> {
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
interface EmailModelInfo {
    /** The model's registered class (its clean name is the registry key). */
    modelType: EmailModelType;
    queryName: QueryName;
    /** Build the model from a target entity (Signum's single-parameter constructor). */
    construct: ((entity: Entity | null) => EmailModel<BaseEntity | null>) | undefined;
    /** Signum's DefaultTemplateConstructor — the template generated when none exists. */
    defaultTemplateConstructor: (() => EmailTemplateEntity | Promise<EmailTemplateEntity>) | undefined;
}

export namespace EmailModelLogic {

    const registeredModels = new Map<string, EmailModelInfo>();

    /** Signum's `TypeToEntity` / `EntityToType`, folded into ONE cache keyed by the registry key (the model's
     *  clean type name). Built with `joinRelaxed`, exactly as Signum builds TypeToEntity — so a registered
     *  model with no row, or a row whose model is gone, is REPORTED (see StartParameters) rather than
     *  silently dropped. */
    export let emailModelsLazy: ResetLazy<Map<string, EmailModelEntity>> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(EmailModelEntity).withQuery();

        emailModelsLazy = sb.globalLazy(async () => new Map(joinRelaxed(
            await readEmailModelRows(),
            registeredModels.keys(),
            row => row.className,
            key => key,
            (row, key) => [key, row] as [string, EmailModelEntity],
            "caching " + EmailModelEntity.name,
        )), { invalidateWith: [EmailModelEntity] });

        new Graph.ConstructFrom(EmailModelEntity, EmailTemplateOperation.CreateEmailTemplateFromModel, {
            construct: (se: EmailModelEntity) => createDefaultTemplateInternal(se),
        }).register();

        // The registry rows are code-declared, so they are maintained by the SCHEMA pipeline, exactly as
        // Signum does it (`sb.Schema.Generating += Schema_Generating; sb.Schema.Synchronizing +=
        // Schema_Synchronizing`) — NOT by an `initializing` hook that inserts what is missing.
        //
        // The difference matters: a RENAMED model class must keep its existing row (and therefore its id),
        // because every EmailTemplate.model FK points at it. A blind "insert what's missing" would add a row
        // under the new name and leave every template pointing at the old one. Going through
        // `synchronizing` means the rename is asked through Replacements (the "EmailModel" bucket) and the
        // matched row is UPDATEd in place.
        sb.schema.generating.push(schema => generateEmailModels(schema));
        sb.schema.synchronizing.push(synchronizeEmailModels);

        // Signum's `sb.Schema.Initializing += () => TypeToEntity.Load()` — warm the cache from the DB once the
        // schema is ready, so the synchronous lookups below never race. No try/catch: a not-yet-created TABLE
        // reads as no rows (readEmailModelRows), and a key MISMATCH is reported by joinRelaxed through
        // StartParameters — which throws "Consider Synchronize" in development and can be collected instead
        // for a deployment whose schema legitimately trails the code.
        sb.schema.initializing.push(async () => { await emailModelsLazy.value(); });
    }

    /** The DECLARED registry rows, by their registry key (Signum's GenerateEmailModelEntities). Exported for
     *  the schema-pipeline functions below. */
    export function shouldRowsForSync(): Map<string, EmailModelEntity> {
        return new Map([...registeredModels.values()]
            .map(info => modelClassName(info.modelType))
            .sort()
            .map(name => [name, EmailModelEntity.create({ className: name })]));
    }

    /** Signum's RegisterEmailModel. Call BEFORE start (the registry table is seeded from these keys). */
    export function registerEmailModel(options: {
        modelType: EmailModelType;
        queryName: QueryName;
        construct?: (entity: Entity | null) => EmailModel<BaseEntity | null>;
        defaultTemplateConstructor?: () => EmailTemplateEntity | Promise<EmailTemplateEntity>;
    }): void {
        registeredModels.set(modelClassName(options.modelType), {
            modelType: options.modelType,
            queryName: options.queryName,
            construct: options.construct,
            defaultTemplateConstructor: options.defaultTemplateConstructor,
        });
    }

    function info(modelEntity: EmailModelEntity): EmailModelInfo {
        const found = registeredModels.get(modelEntity.className);
        if (found == null)
            throw new Error(`The EmailModel '${modelEntity.className}' was not registered`);
        return found;
    }

    /** Signum's `ToEmailModelEntity(type)`. */
    export async function toEmailModelEntity(modelType: EmailModelType): Promise<EmailModelEntity> {
        return await getEmailModelEntity(modelClassName(modelType));
    }

    /** Signum's `GetEmailModelEntity(className)`. */
    export async function getEmailModelEntity(className: string): Promise<EmailModelEntity> {
        const found = (await emailModelsLazy.value()).get(className);
        if (found == null)
            throw new Error(`The EmailModel '${className}' has no registry row — was it registered before EmailLogic.start, and has the database been synchronized?`);
        return found;
    }

    /** Every registry row that matched a registered model (Signum's `TypeToEntity.Value.Values`). */
    export async function allEmailModelEntities(): Promise<EmailModelEntity[]> {
        return [...(await emailModelsLazy.value()).values()];
    }

    /** Signum's `modelEntity.ToType()`. */
    export function toType(modelEntity: EmailModelEntity): EmailModelType {
        return info(modelEntity).modelType;
    }

    /** Signum's `GetEntityType(model)` — the entity a model is built FROM (its query's shape). */
    export function getQueryName(modelEntity: EmailModelEntity): QueryName {
        return info(modelEntity).queryName;
    }

    /** Signum's RequiresExtraParameters — a model with no single-entity constructor needs the caller to
     *  build it (the client's `createFromTemplate` hook). */
    export function requiresExtraParameters(modelEntity: EmailModelEntity): boolean {
        return info(modelEntity).construct == undefined;
    }

    /** Signum's HasDefaultTemplateConstructor. */
    export function hasDefaultTemplateConstructor(modelEntity: EmailModelEntity): boolean {
        return info(modelEntity).defaultTemplateConstructor != undefined;
    }

    /** Signum's CreateModel. */
    export function createModel(modelEntity: EmailModelEntity, entity: Entity | null): EmailModel<BaseEntity | null> {
        const construct = info(modelEntity).construct;
        if (construct == undefined)
            throw new Error(`The EmailModel '${modelEntity.className}' cannot be built from an entity alone`);
        return construct(entity);
    }

    /** Signum's CreateDefaultTemplateInternal — the template an unconfigured model gets. */
    export async function createDefaultTemplateInternal(modelEntity: EmailModelEntity): Promise<EmailTemplateEntity> {
        const i = info(modelEntity);
        if (i.defaultTemplateConstructor == undefined)
            throw new Error(`No EmailTemplate for '${modelEntity.className}' found and defaultTemplateConstructor is not set`);

        const template = await i.defaultTemplateConstructor();
        template.masterTemplate ??= (await EmailMasterTemplateLogic.getDefaultMasterTemplate())?.toLite() ?? null;
        template.name ||= modelEntity.className;
        template.model = modelEntity;
        template.query = QueryLogic.queries.tryGetCore(i.queryName) != undefined
            ? await QueryLogic.getQueryEntity(i.queryName)
            : null;

        return template;
    }

    /** Every registered model type (the terminal's "generate all templates" helper reads it). */
    export function registeredModelTypes(): EmailModelType[] {
        return [...registeredModels.values()].map(i => i.modelType);
    }
}

// ---- the registry table's schema pipeline (Signum's Schema_Generating / Schema_Synchronizing) ----------
//
// Signum's `EmailModelReplacementKey = "EmailModel"` — the rename bucket a removed ClassName is matched
// through, so a renamed model class keeps its row (and its id, which every EmailTemplate.model FK targets).

const emailModelReplacementKey = "EmailModel";

/** Signum's EmailModelLogic.Schema_Generating — INSERT one row per declared model on a FRESH database, in
 *  sorted-key order so the DB-assigned ids are reproducible (the shape SymbolLogic.generateSymbols uses). */
function generateEmailModels(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(EmailModelEntity);
    if (table == null)
        return undefined;

    const should = [...EmailModelLogic.shouldRowsForSync().values()];
    if (should.length === 0)
        return undefined;

    return SqlPreCommand.combine(Spacing.Simple,
        ...should.map(e => insertSqlSyncGenerated(table, e)));
}

/** Signum's EmailModelLogic.Schema_Synchronizing — diff the DECLARED models against the live rows BY
 *  ClassName. A new one is INSERTed, a removed one DELETEd, and a RENAME (asked through Replacements)
 *  lands in mergeBoth, which keeps the persisted id and only UPDATEs the name. */
async function synchronizeEmailModels(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const table = connector.schema.tryTable(EmailModelEntity);
    if (table == null)
        return undefined;

    // Ordinary LINQ read (Signum's Administrator.TryRetrieveAll): the in-memory Table is temporarily
    // pointed at the name the database still uses when the table itself was renamed this run, and a
    // not-yet-created table yields no rows — so every model becomes an INSERT after the CREATE emitted
    // earlier in the same script.
    // The retrieved ENTITIES are the `current` dictionary: each carries its persisted id and the clean
    // snapshot the Retriever took, so mergeBoth below compares the ENTITY, not a record restating its columns.
    const current = (await Administrator.tryRetrieveAll(EmailModelEntity, replacements)).toMap(row => row.className);

    return Synchronizer.synchronizeScriptReplacing<EmailModelEntity, EmailModelEntity>(
        replacements,
        emailModelReplacementKey,
        Spacing.Double,
        EmailModelLogic.shouldRowsForSync(),
        current,
        (_k, e) => insertSqlSyncGenerated(table, e), // new model: DB assigns the id
        (_k, c) => deleteSqlSync(table, c, m => m.className == c.className),
        (_k, e, c) => {
            const oldClassName = c.className;
            // Matched (possibly through a RENAME): write the declared name onto the RETRIEVED row, which
            // keeps its persisted id — every EmailTemplate.model FK points at it. updateSqlSync returns
            // undefined unless the row actually drifted.
            copyRowFields(c, e);
            return updateSqlSync(table, c, m => m.className == oldClassName);
        },
    );
}

/** Every persisted registry row, or EMPTY when the table does not exist yet (a fresh database before
 *  `terminal create` / `sync`) — the same existsTable guard SymbolLogic's row read uses. A MISSING TABLE is
 *  not a mismatch to report: there is nothing to compare against yet. */
async function readEmailModelRows(): Promise<EmailModelEntity[]> {
    const table = Connector.current().schema.tryTable(EmailModelEntity);
    if (table == null)
        return [];

    try {
        if (!await existsTable(table.name))
            return [];
    } catch {
        return []; // no connector / offline — generation seeds from the declared set, not from the cache
    }

    return await ExecutionMode.global(() => tableQuery(EmailModelEntity).toArray()) as EmailModelEntity[];
}

// ---- request-DTO → engine conversions (the QueryModel path) --------------------------------------------
//
// A QueryModel carries the isomorphic request DTOs the client's SearchControl produced (string tokens,
// member-name operations). The engine wants parsed QueryTokens, so convert here — the same job
// queryServer's `parseQueryRequest` does for an HTTP request, over the stored shape instead.

function rootToken(queryName: QueryName): ReturnType<typeof QueryLogic.getToken> {
    return QueryLogic.getToken(queryName, "", SubTokensOptionsAll);
}

function entityFilter(queryName: QueryName, entity: Entity): Filter {
    return new FilterCondition(rootToken(queryName), FilterOperationKeys.EqualTo, entity.toLite());
}

export function parseFilter(queryName: QueryName, f: FilterRequest): Filter {
    if ("filters" in f)
        return new FilterGroup(
            f.groupOperation as FilterGroupOperationKeys,
            f.token != undefined ? QueryLogic.getToken(queryName, f.token, SubTokensOptionsAll) : undefined,
            f.filters.map(sub => parseFilter(queryName, sub)));

    return new FilterCondition(
        QueryLogic.getToken(queryName, f.token, SubTokensOptionsAll),
        f.operation as FilterOperationKeys,
        f.value);
}

export function parseOrder(queryName: QueryName, o: OrderRequest): Order {
    return new Order(QueryLogic.getToken(queryName, o.token, SubTokensOptionsAll), o.orderType as OrderTypeKeys);
}

export function parsePagination(p: { mode?: string; elementsPerPage?: number | null; currentPage?: number | null } | undefined): Pagination {
    switch (p?.mode) {
        case "Firsts": return new Pagination.Firsts(p.elementsPerPage ?? 20);
        case "Paginate": return new Pagination.Paginate(p.elementsPerPage ?? 20, p.currentPage ?? 1);
        default: return new Pagination.All();
    }
}

/** Re-exported so an app's model registration does not have to reach into altea core for a Type. */
export type { Type };
