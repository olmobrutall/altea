import { reflect } from "@altea/altea/data/reflection";
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

// Port of Signum.Templating's isomorphic surface: MultiEntityModel.cs + QueryModel.cs +
// ModelConverterSymbol.cs + TemplateApplicable.cs + TemplateTokenMessage.cs (and their generated
// client twin Signum.Templating.ts).
//
// The MODULE is the text-template engine shared by every report kind: a template is text with
// `@[token]` / `@if[…]` / `@foreach[…]` markers, resolved against a QUERY (the row set) and/or a
// MODEL (an in-memory object). The parser, the value providers and the renderer are server-only
// (server/), so this file holds only what both tiers need.
//
// altea divergences, documented inline:
//  - `TemplateApplicableEval` is Signum's, and works the same way — a script stored on the template,
//    compiled on first use — except the script is TYPESCRIPT rather than C# and the compiler is
//    @altea/altea-eval's rather than Roslyn's. The parameter is typed from the owning template's QUERY (its
//    single entity implementation), which is why the eval reads its owner: see `compile()` below and
//    @altea/altea-eval's data/Eval.ts for how the owner is bound.
//  - `QueryModel` keeps Signum's shape but its `queryKey` is a plain string (altea has no `object
//    QueryName` boxing) and its filters/orders/pagination are the isomorphic request DTOs, so the
//    client's SearchControl can fill them and the server can run them unchanged.
//  - `TemplateMessage.CopyToClipboard` / the `TemplateTokenMessage` set are message containers (altea's
//    `msg()`), not C# enums.

/** Signum's ITemplateApplicable — what a TemplateApplicableEval compiles to. */
export type ITemplateApplicable = (entity: Entity | null) => boolean;

/** Signum's IContainsQuery — a template that is defined over a registered query. */
export interface IContainsQuery extends Entity {
    query: QueryEntity | null;
}

// Signum's ModelConverterSymbol — a named, code-registered conversion from one model/entity to another
// (used by a scheduled send: "take this target entity and turn it into the model the template wants").
@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class ModelConverterSymbol extends Symbol {
}

/**
 * Signum's TemplateApplicableEval — "is this template applicable to this entity?", as a stored script.
 *
 * The parameter's TYPE comes from the owning template's query: a template declared over a query whose root
 * has one entity implementation types `e` as that entity, and anything else falls back to `Entity` (Signum
 * does exactly this, through `QueryEntity.GetEntityImplementations(query).Types.Only()`).
 */
@reflect
export class TemplateApplicableEval extends EvalEmbedded<ITemplateApplicable> {
    protected override compile(): CompilationResult<ITemplateApplicable> {
        // Signum: `QueryEntity.GetEntityImplementations(query).Types.Only()`. altea's query KEY for an
        // entity query IS the clean type name, and `resolveType` is isomorphic — so the ctor (and with it the
        // class name the generated import needs) comes straight off the registry, with no server call.
        const owner = this.owner<IContainsQuery>();
        const entityCtor = owner.query == null ? undefined : resolveType(owner.query.key);
        const entityTypeName = entityCtor?.name ?? "Entity";

        return this.wrap({
            importTypes: [entityTypeName],
            parameters: `e: ${entityTypeName} | null`,
            returnType: "boolean",
        });
    }
}

// Signum's MultiEntityModel — the model behind "send one report for this SET of entities".
@reflect
export class MultiEntityModel extends ModelEntity {
    @implementedByAll
    @noRepeatValidator()
    entities: Lite<Entity>[];

    toString(): string {
        return this.entities.map(e => e.toString()).join(", ");
    }
}

// Signum's QueryModel — the model behind "send one report for the RESULT of this query". Signum marks
// every member `[InTypeScript(false)]` and declares the client twin by hand (the members are engine
// types); altea's request DTOs are isomorphic, so the one declaration serves both tiers.
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

/** The wire shape of GET /api/templating/getGlobalVariables (Signum's GlobalVariableTS): the `@[g:Key]`
 *  variables a template may read, with the type name each yields. */
export interface GlobalVariableTS {
    key: string;
    typeName: string;
    isCollection: boolean;
}

// Re-exported so a caller needing to build a QueryModel does not have to reach into altea core.
export type { FilterRequest, OrderRequest, Pagination };
