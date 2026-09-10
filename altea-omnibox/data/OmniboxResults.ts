import type { PrimaryKey } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type { FilterOperationKeys } from "@altea/altea/data/dynamicQueries";

// The omnibox WIRE model — see docs/port/Omnibox.md.
//
// What `POST /api/omnibox` returns, one entry per suggestion. Declared ONCE, in the isomorphic DATA layer,
// so the server generators and the client providers cannot drift; field names and casing match Signum's
// JSON exactly, which is what lets the ported providers read unchanged.
//
// `resultTypeName` is the DISCRIMINATOR, and the client's provider registry is keyed by it.

export interface OmniboxResult {
    resultTypeName: string;
    /** Lower sorts first. */
    distance: number;
}

// The matched display text plus a same-length mask where '#' marks a character the pattern hit (rendered
// bold). The server-only resolved VALUE is paired with it in server/OmniboxUtils, not carried here.
export interface OmniboxMatch {
    distance: number;
    text: string;
    boldMask: string;
}

// Emitted for the EMPTY query (the syntax guide). `referencedTypeName` is the result-type name of the
// provider whose icon should precede the line, `isMainTitle` the header row.
export interface HelpOmniboxResult extends OmniboxResult {
    text: string;
    referencedTypeName?: string;
    isMainTitle?: boolean;
}

// "<Type> <id>" or "<Type> '<toStr>'". `lite` is undefined when the id
// doesn't exist (or the autocomplete found nothing) — the provider then renders "[Not found]".
export interface EntityOmniboxResult extends OmniboxResult {
    typeMatch: OmniboxMatch;
    id?: PrimaryKey;
    toStr?: string;
    toStrMatch?: OmniboxMatch;
    lite?: Lite<Entity>;
}

// A query plus a (possibly partial) list of filters.
export interface DynamicQueryOmniboxResult extends OmniboxResult {
    /** The query KEY. */
    queryName: string;
    queryNameMatch: OmniboxMatch;
    filters: OmniboxFilterResult[];
}

export interface OmniboxFilterResult {
    distance: number;
    syntax?: FilterSyntax;
    /** Only the token's fullKey travels — tokens are resolved client-side, and the fullKey is the one
     *  thing the provider ever reads (to build the FindOptions filter). */
    queryToken: string;
    /** The token path in omnibox-pascal form, e.g. "Customer.Name". */
    queryTokenOmniboxPascal: string;
    queryTokenMatches?: OmniboxMatch[];
    operation?: FilterOperationKeys;
    operationToString?: string;
    value?: unknown;
    valueToString?: string;
    valueMatch?: OmniboxMatch;
    /** Non-empty when the token can't be filtered (rendered red). */
    canFilter?: string;
}

export interface FilterSyntax {
    index: number;
    tokenLength: number;
    length: number;
    completion: FilterSyntaxCompletionKeys;
}

// A numeric enum plus a string union whose RUNTIME / wire value is the member NAME — so a bare literal
// ("Complete") is the comparison form.
export enum FilterSyntaxCompletion {
    Token,
    Operation,
    Complete,
}
export type FilterSyntaxCompletionKeys = keyof typeof FilterSyntaxCompletion;

// A "!Action" client-side command.
export interface SpecialOmniboxResult extends OmniboxResult {
    match: OmniboxMatch;
    key: string;
}

// The sentinel the generator puts in
// `value` when the typed value can't be parsed; the provider renders it as a red "Unknown".
export const UnknownOmniboxValue = "??UNKNOWN??";

// The result-type discriminators, so neither tier spells the strings inline.
export const OmniboxResultTypeName = {
    Help: "HelpOmniboxResult",
    Entity: "EntityOmniboxResult",
    DynamicQuery: "DynamicQueryOmniboxResult",
    Special: "SpecialOmniboxResult",
} as const;

// The POST body of `/api/omnibox`. `specialActions` are the keys the CLIENT has registered and considers
// allowed — the special-action catalogue lives in the browser, since they are client-side commands, so the
// server can only match against what it is told.
export interface OmniboxRequest {
    query: string;
    specialActions: string[];
}
