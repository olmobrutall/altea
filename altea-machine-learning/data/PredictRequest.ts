import type { Lite } from "@altea/altea/data/lite";
import type { PredictorColumnUsage } from "./Predictor";
import type { PredictorEntity, PredictorSubQueryEntity } from "./Predictor";

// Port of Signum.MachineLearning's PredictRequest.cs — the wire shape of an INTERACTIVE prediction.
//
// It is worth its own file because it is not a query result: a prediction the user can PLAY with needs
// the inputs to come back editable, the sub-query rows to come back as a table, and each output to carry
// both what the model said and (when predicting about a real row) what actually happened. That triple is
// what makes the page useful — "the model says 412, the truth was 380" — and none of it fits a
// ResultTable.
//
// Declared in the DATA layer because both tiers need it: the routes answer it, the page reads and posts
// it back. (Same call `TrainingProgress` makes; see the header in Predictor.ts.)
//
// altea divergences, documented inline:
//  - **a token is a STRING here, where Signum ships a `QueryTokenTS`.** altea has no QueryDescription and
//    resolves tokens CLIENT-side (`Finder.parseSingleToken`), so a serialized token DTO would be a second,
//    less capable copy of a model the client already builds. The page resolves each token once.
//  - `PredictorHeaderType` is a plain string UNION, not a reflected enum: it is never a column and never
//    translated, so giving it an enum table for one DTO would be the mistake `IsolationStrategy` avoids.
//  - values are ordinary JSON scalars, and Lites/entities ride through the entity Serializer both ways.

/** Signum's `PredictorHeaderType` — what one column of a sub-query table IS. */
export type PredictorHeaderType = "Key" | "Input" | "Output";

/** Signum's `PredictRequestTS` — one interactive prediction, in flight. */
export interface PredictRequestModel {
    predictor: Lite<PredictorEntity>;

    /**
     * Whether the request was built FROM a real row, and so whether each output carries a
     * {@link PredictOutputTuple} rather than a bare predicted value.
     */
    hasOriginal: boolean;

    /** Non-null asks a classification for its N most likely answers instead of just the winner. */
    alternativesCount: number | null;

    /** The main query's columns, in the predictor's own order — inputs and outputs interleaved. */
    columns: PredictColumnModel[];

    subQueries: PredictSubQueryTableModel[];
}

export interface PredictColumnModel {
    /** The column's query token, as its string key — see the header. */
    token: string;
    usage: PredictorColumnUsage;
    /**
     * An INPUT's value; an OUTPUT's predicted value, a {@link PredictOutputTuple} when `hasOriginal`,
     * or an {@link AlternativePrediction} array when `alternativesCount` was asked for.
     */
    value: unknown;
}

export interface PredictSubQueryTableModel {
    subQuery: Lite<PredictorSubQueryEntity>;
    /** `Key*` then `(Input|Output)*` — the order the rows are laid out in. */
    columnHeaders: PredictSubQueryHeaderModel[];
    /** One row per SplitBy key, each as long as `columnHeaders`. */
    rows: unknown[][];
}

export interface PredictSubQueryHeaderModel {
    token: string;
    headerType: PredictorHeaderType;
}

/** What the model said, beside what actually happened. */
export interface PredictOutputTuple {
    predicted: unknown;
    original: unknown;
}

/** One of a classification's ranked answers. */
export interface AlternativePrediction {
    probability: number;
    value: unknown;
}

/** Whether a value is the original/predicted pair rather than a bare value. */
export function isPredictOutputTuple(value: unknown): value is PredictOutputTuple {
    return value != null && typeof value === "object" && !Array.isArray(value)
        && "predicted" in value && "original" in value;
}
