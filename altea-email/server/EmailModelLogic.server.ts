import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Graph } from "@altea/altea/server/graph";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    FilterCondition, FilterGroup, FilterOperation, FilterGroupOperation, Order, OrderType, Pagination,
    type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { Entity, type Type } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { FilterRequest, OrderRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import { EmailModelEntity, type EmailOwnerRecipientData, type EmailOwnerData } from "../data/Email";
import { EmailTemplateEntity, EmailTemplateOperation } from "../data/EmailTemplate";
import type { EmailMessageEntity } from "../data/EmailMessage";
import { EmailMasterTemplateLogic } from "./EmailMasterTemplateLogic.server";

// Port of Signum.Mailing's EmailModelLogic.cs — the MODEL side: a code-declared object a template renders
// against (instead of / alongside a query row), its registry table, and the default template it can generate.
//
// altea divergences, documented inline:
//  - Signum's `EmailModel<T>` abstract base is a TS INTERFACE (`IEmailModel`) plus the `emailModel()` helper
//    that supplies its defaults: altea has no C#-style protected virtual members to inherit, and a model is
//    just an object with a known shape. `MultiEntityEmail` / `QueryEmail` become the two `emailModel(...)`
//    factories below, byte-for-byte the same behaviour.
//  - `Type.FullName` (the registry key) → altea's CLEAN TYPE NAME (`cleanTypeName(ctor)`), the stable
//    identity altea already uses for a type on the wire. `fullClassName` keeps Signum's column name.
//  - Signum's `Schema_Generating` / `Schema_Synchronizing` (the interactive rename-aware seeding of
//    EmailModelEntity rows) is replaced by the plain SEED on start: the registry is code-declared, so the
//    rows are re-derived rather than reconciled through a Replacements prompt.
//  - `RequiresExtraParameters` / `GetEntityConstructor` (C# reflection over the model's constructors) become
//    the registration's own `construct` callback — present ⇒ the model can be built from an entity.

/** Signum's IEmailModel — the object a template renders against. */
export interface IEmailModel {
    /** The entity this model is ABOUT (Signum's UntypedEntity) — becomes the message's `target`. */
    untypedEntity: Entity | null;
    /** Extra recipients the model itself supplies. */
    getRecipients(): EmailOwnerRecipientData[];
    /** A From the model itself supplies (else the template's / the configuration's default). */
    getFrom(): EmailOwnerData | null;
    /** The filters the template's query should run with. */
    getFilters(queryName: QueryName): Filter[];
    getOrders(queryName: QueryName): Order[];
    getPagination(): Pagination;
}

/** Signum's `EmailModel<T>` defaults, as a factory: pass what differs, inherit the rest. */
export function emailModel(init: Partial<IEmailModel> & { untypedEntity: Entity | null }): IEmailModel {
    return {
        untypedEntity: init.untypedEntity,
        getRecipients: init.getRecipients ?? (() => []),
        getFrom: init.getFrom ?? (() => null),
        // Signum's default: filter the query's Entity column to THIS entity.
        getFilters: init.getFilters ?? (queryName => [entityFilter(queryName, init.untypedEntity!)]),
        getOrders: init.getOrders ?? (() => []),
        getPagination: init.getPagination ?? (() => new Pagination.All()),
    };
}

/** Signum's MultiEntityEmail — one report for a SET of entities. */
export function multiEntityEmailModel(entity: MultiEntityModel): IEmailModel {
    return emailModel({
        untypedEntity: null,
        getFilters: queryName => [new FilterCondition(rootToken(queryName), FilterOperation.IsIn, entity.entities)],
    });
}

/** Signum's QueryEmail — one report for the RESULT of a query the user configured. */
export function queryEmailModel(entity: QueryModel): IEmailModel {
    return emailModel({
        untypedEntity: null,
        getFilters: queryName => (entity.filters ?? []).map(f => parseFilter(queryName, f)),
        getOrders: queryName => (entity.orders ?? []).map(o => parseOrder(queryName, o)),
        getPagination: () => parsePagination(entity.pagination),
    });
}

/** One registered model type: which query it renders against, and how to build it. */
interface EmailModelInfo {
    /** The model's registered type (its clean name is the registry key). */
    modelType: Function;
    queryName: QueryName;
    /** Build the model from a target entity (Signum's single-parameter constructor). */
    construct: ((entity: Entity | null) => IEmailModel) | undefined;
    /** Signum's DefaultTemplateConstructor — the template generated when none exists. */
    defaultTemplateConstructor: (() => EmailTemplateEntity) | undefined;
}

export namespace EmailModelLogic {

    const registeredModels = new Map<string, EmailModelInfo>();

    /** Signum's `TypeToEntity` / `EntityToType`, folded into one cache keyed by the clean type name. */
    export let emailModelsLazy: ResetLazy<EmailModelEntity[]> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(EmailModelEntity).withQuery();

        emailModelsLazy = sb.globalLazy(
            () => table(EmailModelEntity).toArray() as Promise<EmailModelEntity[]>,
            { invalidateWith: [EmailModelEntity] });

        new Graph.ConstructFrom(EmailTemplateOperation.CreateEmailTemplateFromModel, {
            construct: (se: EmailModelEntity) => createDefaultTemplateInternal(se),
        }).register();

        // The registry rows are code-declared, so seed them once the schema exists (Signum reconciles them
        // through an interactive Replacements prompt in `sync`; see the header).
        sb.schema.initializing.push(async () => {
            await Transaction.forceNew(async () => {
                await ExecutionMode.global(async () => {
                    const existing = await table(EmailModelEntity).toArray() as EmailModelEntity[];
                    for (const info of registeredModels.values()) {
                        const name = cleanTypeName(info.modelType);
                        if (existing.some(e => e.fullClassName === name))
                            continue;
                        await EmailModelEntity.create({ fullClassName: name }).save();
                    }
                });
            });
            emailModelsLazy.reset();
        });
    }

    /** Signum's RegisterEmailModel. Call BEFORE start (the registry table is seeded from these keys). */
    export function registerEmailModel(options: {
        modelType: Function;
        queryName: QueryName;
        construct?: (entity: Entity | null) => IEmailModel;
        defaultTemplateConstructor?: () => EmailTemplateEntity;
    }): void {
        registeredModels.set(cleanTypeName(options.modelType), {
            modelType: options.modelType,
            queryName: options.queryName,
            construct: options.construct,
            defaultTemplateConstructor: options.defaultTemplateConstructor,
        });
    }

    function info(modelEntity: EmailModelEntity): EmailModelInfo {
        const found = registeredModels.get(modelEntity.fullClassName);
        if (found == null)
            throw new Error(`The EmailModel '${modelEntity.fullClassName}' was not registered`);
        return found;
    }

    /** Signum's `ToEmailModelEntity(type)`. */
    export async function toEmailModelEntity(modelType: Function): Promise<EmailModelEntity> {
        return await getEmailModelEntity(cleanTypeName(modelType));
    }

    /** Signum's `GetEmailModelEntity(fullClassName)`. */
    export async function getEmailModelEntity(fullClassName: string): Promise<EmailModelEntity> {
        const all = await emailModelsLazy.value();
        const found = all.find(e => e.fullClassName === fullClassName);
        if (found == null)
            throw new Error(`The EmailModel '${fullClassName}' has no registry row — was it registered before EmailLogic.start?`);
        return found;
    }

    /** Signum's `modelEntity.ToType()`. */
    export function toType(modelEntity: EmailModelEntity): Function {
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
    export function createModel(modelEntity: EmailModelEntity, entity: Entity | null): IEmailModel {
        const construct = info(modelEntity).construct;
        if (construct == undefined)
            throw new Error(`The EmailModel '${modelEntity.fullClassName}' cannot be built from an entity alone`);
        return construct(entity);
    }

    /** Signum's CreateDefaultTemplateInternal — the template an unconfigured model gets. */
    export async function createDefaultTemplateInternal(modelEntity: EmailModelEntity): Promise<EmailTemplateEntity> {
        const i = info(modelEntity);
        if (i.defaultTemplateConstructor == undefined)
            throw new Error(`No EmailTemplate for '${modelEntity.fullClassName}' found and defaultTemplateConstructor is not set`);

        const template = i.defaultTemplateConstructor();
        template.masterTemplate ??= (await EmailMasterTemplateLogic.getDefaultMasterTemplate())?.toLite() ?? null;
        template.name ||= modelEntity.fullClassName;
        template.model = modelEntity;
        template.query = QueryLogic.queries.tryGetCore(i.queryName) != undefined
            ? await QueryLogic.getQueryEntity(i.queryName)
            : null;

        return template;
    }

    /** Every registered model type (the terminal's "generate all templates" helper reads it). */
    export function registeredModelTypes(): Function[] {
        return [...registeredModels.values()].map(i => i.modelType);
    }
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
    return new FilterCondition(rootToken(queryName), FilterOperation.EqualTo, entity.toLite());
}

export function parseFilter(queryName: QueryName, f: FilterRequest): Filter {
    if ("filters" in f)
        return new FilterGroup(
            f.groupOperation as FilterGroupOperation,
            f.token != undefined ? QueryLogic.getToken(queryName, f.token, SubTokensOptionsAll) : undefined,
            f.filters.map(sub => parseFilter(queryName, sub)));

    return new FilterCondition(
        QueryLogic.getToken(queryName, f.token, SubTokensOptionsAll),
        f.operation as FilterOperation,
        f.value);
}

export function parseOrder(queryName: QueryName, o: OrderRequest): Order {
    return new Order(QueryLogic.getToken(queryName, o.token, SubTokensOptionsAll), o.orderType as OrderType);
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
