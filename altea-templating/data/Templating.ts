import { reflect } from "@altea/altea/data/reflection";
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
//  - `TemplateApplicableEval` (Signum's EvalEmbedded<ITemplateApplicable> — a C# script compiled with
//    Roslyn) is NOT ported: altea has no Signum.Eval counterpart, and compiling user-supplied source at
//    runtime is not something the port wants to introduce. Its FEATURE — "is this template applicable to
//    this entity?" — is preserved by `TemplateApplicableSymbol`: the app declares a symbol and registers
//    the predicate in code (TemplatingLogic.registerApplicable), exactly the shape SimpleTaskSymbol uses
//    for scheduler tasks. A template then points at the symbol instead of carrying a script.
//  - `QueryModel` keeps Signum's shape but its `queryKey` is a plain string (altea has no `object
//    QueryName` boxing) and its filters/orders/pagination are the isomorphic request DTOs, so the
//    client's SearchControl can fill them and the server can run them unchanged.
//  - `TemplateMessage.CopyToClipboard` / the `TemplateTokenMessage` set are message containers (altea's
//    `msg()`), not C# enums.

/** Signum's ITemplateApplicable — the predicate behind a TemplateApplicableSymbol. */
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

// altea-only (see the header): the named, code-registered "is this template applicable" predicate that
// replaces Signum's compiled TemplateApplicableEval script.
@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class TemplateApplicableSymbol extends Symbol {
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
