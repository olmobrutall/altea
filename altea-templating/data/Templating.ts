import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { resolveType } from "@altea/altea/data/registration";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Symbol } from "@altea/altea/data/symbol";
import { entity, implementedByAll } from "@altea/altea/data/decorators";
import { noRepeatValidator } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import type { FilterRequest, OrderRequest, Pagination } from "@altea/altea/data/dynamicQuery/queryRequest";

// Port of Signum.Templating's isomorphic surface — see docs/port/Templating.md.
//
// The MODULE is the text-template engine every report kind shares: a template is text with `@[token]` /
// `@if[…]` / `@foreach[…]` markers, resolved against a QUERY (the row set) and/or a MODEL (an in-memory
// object). The parser, the value providers and the renderer are SERVER-only, so this file holds only what
// both tiers need.
//
// `TemplateApplicableEval` is a script stored on the template and compiled on first use, in TypeScript
// through @altea/altea-eval. Its parameter is typed from the owning template's QUERY (its single entity
// implementation), which is why the eval reads its OWNER — see `compile()` below.

/** What a TemplateApplicableEval compiles to. */
export type ITemplateApplicable = (entity: Entity | null) => boolean;

/** A template that is defined over a registered query. */
export interface IContainsQuery extends Entity {
    query: QueryEntity | null;
}

// A named, code-registered conversion from one model/entity to another
// (used by a scheduled send: "take this target entity and turn it into the model the template wants").
@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class ModelConverterSymbol extends Symbol {
}

/**
 * "is this template applicable to this entity?", as a stored script.
 *
 * The parameter's TYPE comes from the owning template's query: a template declared over a query whose root
 * has one entity implementation types `e` as that entity, and anything else falls back to `Entity`.
 */
@reflect
export class TemplateApplicableEval extends EvalEmbedded<ITemplateApplicable> {
    protected override compile(): CompilationResult<ITemplateApplicable> {
        // The query KEY of an entity query IS the clean type name, and `resolveType` is isomorphic — so
        // the ctor, and with it the class name the generated import needs, comes straight off the
        // registry with no server call.
        const owner = this.owner(Entity) as unknown as IContainsQuery;
        const entityCtor = owner.query == null ? undefined : resolveType(owner.query.key);
        const entityTypeName = entityCtor?.name ?? "Entity";

        return this.wrap({
            importTypes: [entityTypeName],
            parameters: `e: ${entityTypeName} | null`,
            returnType: "boolean",
        });
    }
}

// The model behind "send one report for this SET of entities".
@reflect
export class MultiEntityModel extends ModelEntity {
    @implementedByAll
    @noRepeatValidator()
    entities: Lite<Entity>[];

    toString(): string {
        return this.entities.map(e => e.toString()).join(", ");
    }
}

// The model behind "send one report for the RESULT of this query". The request DTOs are ISOMORPHIC, so
// this one declaration serves both tiers — Signum has to declare its client twin by hand.
@reflect
export class QueryModel extends ModelEntity {
    queryKey: string;

    filters: FilterRequest[];

    orders: OrderRequest[];

    pagination: Pagination;

    toString(): string {
        return this.queryKey ?? "";
    }
}

export const QueryModelMessage = {
    ConfigureYourQueryAndPressSearchBeforeOk: msg("Configure your query and press [Search] before [Ok]"),
};

export const TemplateMessage = {
    Template: msg(),
    CopyToClipboard: msg("Copy to clipboard: Ctrl+C, ESC"),
};

export const TemplateTokenMessage = {
    Insert: msg(),
    NoColumnSelected: msg("No column selected"),
    YouCannotAddIfBlocksOnCollectionFields: msg("You cannot add If blocks on collection fields"),
    YouHaveToAddTheElementTokenToUseForeachOnCollectionFields: msg("You have to add the Element token to use Foreach on collection fields"),
    YouCanOnlyAddForeachBlocksWithCollectionFields: msg("You can only add Foreach blocks with collection fields"),
    YouCannotAddBlocksWithAllOrAny: msg("You cannot add Blocks with All or Any"),
    ImpossibleToAccess0BecauseTheTemplateHAsNo1: msg("Impossible to access {0} because the template has no {1}"),
};

/** The wire shape of GET /api/templating/getGlobalVariables: the `@[g:Key]` variables a template may
 *  read, with the type name each yields. */
export interface GlobalVariableTS {
    key: string;
    typeName: string;
    isCollection: boolean;
}

// Re-exported so a caller needing to build a QueryModel does not have to reach into altea core.
export type { FilterRequest, OrderRequest, Pagination };

// The database schema this package's tables live in. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("templating");
