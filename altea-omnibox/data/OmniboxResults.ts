import type { PrimaryKey } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type { FilterOperation } from "@altea/altea/data/dynamicQueries";

// The omnibox WIRE model: what `POST /api/omnibox` returns, one entry per suggestion.
//
// Signum declared these twice — as C# classes with JsonConverters (OmniboxParser.cs /
// EntityOmniboxResultGenerator.cs / DynamicQueryOmniboxResultGenerator.cs /
// SpecialOmniboxResultGenerator.cs) and again, by hand, as TS interfaces inside each *OmniboxProvider.tsx.
// altea is one language, so the contract is declared ONCE here in the isomorphic DATA layer: the server
// generators build these shapes and the client providers render them. Field names/casing match Signum's
// JSON exactly, so the ported providers read unchanged.
//
// `resultTypeName` is the discriminator (Signum's `OmniboxResult.ResultTypeName => GetType().Name`); the
// client's provider registry is keyed by it.

export interface OmniboxResult {
    resultTypeName: string;
    /** Signum's `float Distance` — lower sorts first. */
    distance: number;
}

// Signum's `OmniboxMatch` (OmniboxUtils.cs) minus its server-only `Value`: the matched display text plus
// a same-length mask where '#' marks a character the pattern hit (rendered bold).
export interface OmniboxMatch {
    distance: number;
    text: string;
    boldMask: string;
}

// Signum's `HelpOmniboxResult`. Emitted for the EMPTY query (the syntax guide) — `referencedTypeName` is
// the result-type name of the provider whose icon should precede the line, `isMainTitle` the header row.
export interface HelpOmniboxResult extends OmniboxResult {
    text: string;
    referencedTypeName?: string;
    isMainTitle?: boolean;
}

// Signum's `EntityOmniboxResult`: "<Type> <id>" or "<Type> '<toStr>'". `lite` is undefined when the id
// doesn't exist (or the autocomplete found nothing) — the provider then renders "[Not found]".
export interface EntityOmniboxResult extends OmniboxResult {
    typeMatch: OmniboxMatch;
    id?: PrimaryKey;
    toStr?: string;
    toStrMatch?: OmniboxMatch;
    lite?: Lite<Entity>;
}

// Signum's `DynamicQueryOmniboxResult`: a query plus a (possibly partial) list of filters.
export interface DynamicQueryOmniboxResult extends OmniboxResult {
    /** The query KEY (Signum serialized `QueryName` through QueryNameJsonConverter → QueryUtils.GetKey). */
    queryName: string;
    queryNameMatch: OmniboxMatch;
    filters: OmniboxFilterResult[];
}

export interface OmniboxFilterResult {
    distance: number;
    syntax?: FilterSyntax;
    /** ALTEA DIVERGENCE: Signum serialized the whole `QueryTokenTS` DTO here; altea resolves tokens
     *  client-side, so only the token's fullKey travels — the one thing the provider ever read
     *  (`f.queryToken.fullKey`, to build the FindOptions filter). */
    queryToken: string;
    /** The token path rendered in omnibox-pascal form, e.g. "Customer.Name" (Signum's
     *  QueryTokenOmniboxPascal). */
    queryTokenOmniboxPascal: string;
    queryTokenMatches?: OmniboxMatch[];
    operation?: FilterOperation;
    operationToString?: string;
    value?: unknown;
    valueToString?: string;
    valueMatch?: OmniboxMatch;
    /** Signum's `CanFilter` — non-empty when the token can't be filtered (rendered red). */
    canFilter?: string;
}

export interface FilterSyntax {
    index: number;
    tokenLength: number;
    length: number;
    completion: FilterSyntaxCompletion;
}

// Signum's `FilterSyntaxCompletion` enum. altea enums are a numeric `XEnum` + a string union whose
// RUNTIME/wire value is the member NAME — so a bare literal ("Complete") is the comparison form.
export enum FilterSyntaxCompletionEnum {
    Token,
    Operation,
    Complete,
}
export type FilterSyntaxCompletion = keyof typeof FilterSyntaxCompletionEnum;

// Signum's `SpecialOmniboxResult`: a "!Action" client-side command.
export interface SpecialOmniboxResult extends OmniboxResult {
    match: OmniboxMatch;
    key: string;
}

// Signum's `DynamicQueryOmniboxResultGenerator.UnknownValue` — the sentinel the generator puts in
// `value` when the typed value can't be parsed; the provider renders it as a red "Unknown".
export const UnknownOmniboxValue = "??UNKNOWN??";

// The result-type discriminators, so neither tier spells the strings inline.
export const OmniboxResultTypeName = {
    Help: "HelpOmniboxResult",
    Entity: "EntityOmniboxResult",
    DynamicQuery: "DynamicQueryOmniboxResult",
    Special: "SpecialOmniboxResult",
} as const;

// The POST body of `/api/omnibox` (Signum's OmniboxController.OmniboxRequest). `specialActions` are the
// keys the CLIENT has registered and considers allowed — the special-action catalogue lives in the
// browser (they are client-side commands), so the server can only match against what it is told.
export interface OmniboxRequest {
    query: string;
    specialActions: string[];
}
