import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import {
    DefaultColumnEncodings, PredictorColumnEncodingSymbol, PredictorColumnUsage, PredictorEntity,
    PredictorMessage, PredictorSubQueryEntity,
} from "../../data/Predictor";
import { NeuralNetworkSettingsEntity, PredictionType } from "../../data/NeuralNetworkSettings";
import { PredictorCodification, keyOfValue, type PredictorColumnBase } from "../PredictorAlgorithm";

// Port of Signum.MachineLearning's TensorFlow/TensorFlowEncoding.cs — how a column's VALUES become the
// numbers a network sees, and how its OUTPUT numbers become a value again.
//
// Each encoding answers three questions, and the third is the one that is easy to get wrong:
//   1. `validateEncodingProperty` — is this encoding legal for this column's type and usage?
//   2. `generateCodifications` — how many slots does the column need, and what does each stand for? This
//      is where a one-hot column becomes N slots and a normalizing one fits its statistics.
//   3. `encodeValue` / `decodeValue` — the round trip. Decoding is NOT the inverse of encoding for a
//      classification: encoding writes a 1 in one slot, decoding reads the ARGMAX across slots.
//
// altea divergences, documented inline:
//  - `float[]` + an offset becomes a `Float32Array` + an offset, unchanged in spirit: the caller owns one
//    flat vector per row and each encoding writes its own slots into it.
//  - `ReflectionTools.ChangeType(value, token.Type)` has no counterpart — altea's token carries a
//    `TypeReference`, so a decoded number is rounded for an integer token and left alone otherwise (see
//    `coerceToToken`). Signum's ChangeType would also parse a string; nothing decodes into one here.
//  - Signum's `column.ColumnModel` memo (the value→slot dictionary, built once per column) is kept, and
//    for the same reason: it is rebuilt per PREDICTION otherwise, which is the hot path.
//  - `PredictionOptions.AlternativeCount` (return the top N with probabilities) is ported; its softmax is
//    computed over the SLOTS, as Signum does.

export interface PredictionOptions {
    /** Consider only these slots — used to predict one output column of several. */
    filteredCodifications?: PredictorCodification[];
    /** Return the top N values with their probabilities instead of just the best. */
    alternativeCount?: number;
}

export interface AlternativePrediction {
    probability: number;
    value: unknown;
}

export interface ITensorFlowEncoding {
    validateEncodingProperty(
        predictor: PredictorEntity,
        subQuery: PredictorSubQueryEntity | null,
        encoding: PredictorColumnEncodingSymbol,
        usage: PredictorColumnUsage,
        token: QueryToken,
    ): string | null;

    generateCodifications(values: readonly unknown[], column: PredictorColumnBase): PredictorCodification[];

    encodeValue(
        value: unknown,
        column: PredictorColumnBase,
        codifications: PredictorCodification[],
        target: Float32Array,
        offset: number,
    ): void;

    decodeValue(
        column: PredictorColumnBase,
        codifications: PredictorCodification[],
        outputs: Float32Array,
        options?: PredictionOptions,
    ): unknown;
}

// ---- helpers -------------------------------------------------------------------------------------------

/** Whether a token's value is a number at all. */
function isNumberToken(token: QueryToken): boolean {
    return token.type.typeName === "Number" || token.type.typeName === "Decimal";
}

/** Whether it is specifically a NON-integer number. */
function isDecimalToken(token: QueryToken): boolean {
    return token.type.typeName === "Decimal"
        || (token.type.typeName === "Number" && token.type.subTypeName !== "int" && token.type.subTypeName !== "long");
}

function toFloat(value: unknown): number {
    if (value == null)
        return 0;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Put a decoded number back in the
 * shape the column's own type has. An integer token must not decode to 3.7000000001.
 */
function coerceToToken(value: number, token: QueryToken): unknown {
    return isDecimalToken(token) ? value : Math.round(value);
}

function neuralSettings(predictor: PredictorEntity): NeuralNetworkSettingsEntity {
    return predictor.algorithmSettings as NeuralNetworkSettingsEntity;
}

function notSupported(encoding: PredictorColumnEncodingSymbol, forWhat: string): string {
    return PredictorMessage._0NotSuportedFor1.niceToString(encoding.niceToString(), forWhat);
}

// ---- None ----------------------------------------------------------------------------------------------

/** The value IS the number. One slot, no transformation. */
export class NoneEncoding implements ITensorFlowEncoding {
    validateEncodingProperty(
        predictor: PredictorEntity, _sq: PredictorSubQueryEntity | null,
        encoding: PredictorColumnEncodingSymbol, _usage: PredictorColumnUsage, token: QueryToken,
    ): string | null {
        if (!isNumberToken(token) && token.type.typeName !== "Boolean")
            return notSupported(encoding, predictor.algorithm.niceToString());
        return null;
    }

    generateCodifications(_values: readonly unknown[], column: PredictorColumnBase): PredictorCodification[] {
        return [new PredictorCodification(column)];
    }

    encodeValue(
        value: unknown, _column: PredictorColumnBase, codifications: PredictorCodification[],
        target: Float32Array, offset: number,
    ): void {
        // A boolean is 1/0 — the one non-numeric type this encoding accepts.
        const n = typeof value === "boolean" ? (value ? 1 : 0) : toFloat(value);
        target[offset + codifications[0]!.index] = n;
    }

    decodeValue(
        column: PredictorColumnBase, codifications: PredictorCodification[], outputs: Float32Array,
    ): unknown {
        const c = single(codifications);
        return coerceToToken(outputs[c.index]!, column.token);
    }
}

// ---- OneHot --------------------------------------------------------------------------------------------

/**
 * One slot per DISTINCT value, and exactly one of them is 1.
 *
 * This is what makes a categorical column learnable: a state whose values are Ordered / Shipped /
 * Cancelled is not 0 / 1 / 2 on a number line, and feeding it as such teaches the model that Cancelled is
 * "more" than Shipped.
 */
export class OneHotEncoding implements ITensorFlowEncoding {
    validateEncodingProperty(
        predictor: PredictorEntity, _sq: PredictorSubQueryEntity | null,
        encoding: PredictorColumnEncodingSymbol, usage: PredictorColumnUsage, token: QueryToken,
    ): string | null {
        // A continuous number has no meaningful distinct-value set.
        if (isDecimalToken(token))
            return notSupported(encoding, predictor.algorithm.niceToString());

        const nn = neuralSettings(predictor);
        if (usage === PredictorColumnUsage.Output
            && (nn.predictionType === PredictionType.Regression || nn.predictionType === PredictionType.MultiRegression))
            return notSupported(encoding, PredictionType[nn.predictionType]);

        return null;
    }

    generateCodifications(values: readonly unknown[], column: PredictorColumnBase): PredictorCodification[] {
        const distinct = new Map<string, unknown>();
        for (const v of values)
            if (v != null)
                distinct.set(valueKey(v), v);

        return [...distinct.values()].map(v => {
            const c = new PredictorCodification(column);
            c.isValue = v;
            return c;
        });
    }

    encodeValue(
        value: unknown, column: PredictorColumnBase, codifications: PredictorCodification[],
        target: Float32Array, offset: number,
    ): void {
        if (value == null)
            return; // an unknown category is all-zeros, which is what Signum writes too

        const index = this.dictionary(column, codifications).get(valueKey(value));
        if (index != null)
            target[offset + index] = 1;
    }

    decodeValue(
        _column: PredictorColumnBase, codifications: PredictorCodification[], outputs: Float32Array,
        options?: PredictionOptions,
    ): unknown {
        const cods = options?.filteredCodifications ?? codifications;

        if (options?.alternativeCount == null) {
            // ARGMAX — the highest-scoring slot's value, not the inverse of encodeValue.
            let best: PredictorCodification | null = null;
            let max = -Infinity;
            for (const c of cods) {
                const v = outputs[c.index]!;
                if (v > max) { max = v; best = c; }
            }
            return best?.isValue ?? null;
        }

        // A softmax over the slots, so the alternatives carry comparable probabilities.
        const sum = cods.reduce((acc, c) => acc + Math.exp(outputs[c.index]!), 0);
        return [...cods]
            .sort((a, b) => outputs[b.index]! - outputs[a.index]!)
            .slice(0, options.alternativeCount)
            .map((c): AlternativePrediction => ({
                probability: Math.exp(outputs[c.index]!) / sum,
                value: c.isValue,
            }));
    }

    /** The value→slot memo on the column (see the module header). */
    private dictionary(column: PredictorColumnBase, codifications: PredictorCodification[]): Map<string, number> {
        if (column.columnModel != null)
            return column.columnModel as Map<string, number>;

        const map = new Map<string, number>(codifications.map(c => [valueKey(c.isValue), c.index]));
        column.columnModel = map;
        return map;
    }
}

/** A stable key for a value used as a CATEGORY — a lite by its key, everything else by its string. */
/**
 * The one-hot dictionary key of a value.
 *
 * It delegates to `keyOfValue` on purpose: the STORED form of a codification's value goes through the
 * same rule (see PredictorCodificationLogic), and having two spellings of "the key of a value" is what
 * made a one-hot column over a Lite silently match nothing.
 */
function valueKey(value: unknown): string {
    return value == null ? "" : keyOfValue(value);
}

// ---- the normalizers -----------------------------------------------------------------------------------

/**
 * One slot, and the value is RESCALED into it.
 *
 * Why it matters: a network's weights start small and its optimizer takes uniform steps, so an input
 * measured in millions and one measured in fractions cannot both be learned at a single learning rate.
 * The statistics are fitted on the training set and PERSISTED with the codification, because a prediction
 * has to rescale its input exactly the same way (see PredictorCodification).
 */
abstract class BaseNormalizeEncoding implements ITensorFlowEncoding {
    validateEncodingProperty(
        predictor: PredictorEntity, _sq: PredictorSubQueryEntity | null,
        encoding: PredictorColumnEncodingSymbol, _usage: PredictorColumnUsage, token: QueryToken,
    ): string | null {
        if (!isNumberToken(token))
            return notSupported(encoding, predictor.algorithm.niceToString());
        return null;
    }

    generateCodifications(values: readonly unknown[], column: PredictorColumnBase): PredictorCodification[] {
        const nums = values.filter(v => v != null).map(toFloat);
        const c = new PredictorCodification(column);

        // The empty-set defaults: a 0 average with a 1 stdDev / 0..1 range is the identity, which is
        // the only safe thing when there is nothing to fit on.
        if (nums.length === 0) {
            c.average = 0; c.stdDev = 1; c.min = 0; c.max = 1;
        } else {
            const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
            c.average = avg;
            c.stdDev = standardDeviation(nums, avg);
            c.min = Math.min(...nums);
            c.max = Math.max(...nums);
        }
        return [c];
    }

    abstract encodeSingle(value: unknown, c: PredictorCodification): number;
    abstract decodeSingle(value: number, c: PredictorCodification): number;

    encodeValue(
        value: unknown, _column: PredictorColumnBase, codifications: PredictorCodification[],
        target: Float32Array, offset: number,
    ): void {
        const c = single(codifications);
        target[offset + c.index] = this.encodeSingle(value, c);
    }

    decodeValue(
        column: PredictorColumnBase, codifications: PredictorCodification[], outputs: Float32Array,
    ): unknown {
        const c = single(codifications);
        return coerceToToken(this.decodeSingle(outputs[c.index]!, c), column.token);
    }
}

/** (v − mean) / stdDev. */
export class NormalizeZScoreEncoding extends BaseNormalizeEncoding {
    encodeSingle(value: unknown, c: PredictorCodification): number {
        // A zero stdDev means every training value was identical; dividing would be NaN, and 0 is the
        // correct z-score for "exactly the mean". Signum divides regardless and produces NaN.
        const sd = c.stdDev!;
        return sd === 0 ? 0 : (toFloat(value) - c.average!) / sd;
    }
    decodeSingle(value: number, c: PredictorCodification): number {
        return c.average! + c.stdDev! * value;
    }
}

/** Into 0..1 across the observed range. */
export class NormalizeMinMaxEncoding extends BaseNormalizeEncoding {
    encodeSingle(value: unknown, c: PredictorCodification): number {
        const range = c.max! - c.min!;
        return range === 0 ? 0 : (toFloat(value) - c.min!) / range;
    }
    decodeSingle(value: number, c: PredictorCodification): number {
        return c.min! + (c.max! - c.min!) * value;
    }
}

/**
 * The log, floored at `minLog`.
 *
 * For a quantity spread over orders of magnitude (an order total, a page count), the log is what makes
 * the difference between 1 and 10 comparable to the difference between 100 and 1000. The floor is what
 * makes zero and negative values representable at all.
 */
export class NormalizeLogEncoding extends BaseNormalizeEncoding {
    minLog = -5;

    encodeSingle(value: unknown): number {
        const d = toFloat(value);
        return d <= 0 ? this.minLog : Math.max(this.minLog, Math.log(d));
    }
    decodeSingle(value: number): number {
        return Math.exp(value);
    }
}

// ---- SplitWords ----------------------------------------------------------------------------------------

/**
 * A bag of words: one slot per distinct WORD across the column, each 1
 * when the value contains that word.
 *
 * Input-only, because there is no sensible way to train a model to emit a set of words through this
 * representation (its decode is a best-effort read-back, for inspection).
 */
export class SplitWordsEncoding implements ITensorFlowEncoding {
    separators = /[.,\s\-()/\\;:]+/;
    maxDecodedWords = 5;
    minDecodedWordValue = 0.1;

    validateEncodingProperty(
        predictor: PredictorEntity, _sq: PredictorSubQueryEntity | null,
        encoding: PredictorColumnEncodingSymbol, usage: PredictorColumnUsage, token: QueryToken,
    ): string | null {
        if (token.type.typeName !== "String")
            return notSupported(encoding, predictor.algorithm.niceToString());
        if (usage === PredictorColumnUsage.Output)
            return notSupported(encoding, PredictorColumnUsage[usage]);
        return null;
    }

    splitWords(str: string): string[] {
        return str.split(this.separators).filter(s => s.length > 0);
    }

    generateCodifications(values: readonly unknown[], column: PredictorColumnBase): PredictorCodification[] {
        // Case-INSENSITIVE, as Signum's StringComparer.CurrentCultureIgnoreCase dictionary is: "Chai" and
        // "chai" are the same word, and treating them as two halves the evidence for each.
        const words = new Map<string, string>();
        for (const v of values) {
            if (typeof v !== "string")
                continue;
            for (const w of this.splitWords(v))
                if (!words.has(w.toLowerCase()))
                    words.set(w.toLowerCase(), w);
        }

        return [...words.values()].map(w => {
            const c = new PredictorCodification(column);
            c.isValue = w;
            return c;
        });
    }

    encodeValue(
        value: unknown, column: PredictorColumnBase, codifications: PredictorCodification[],
        target: Float32Array, offset: number,
    ): void {
        const dic = this.dictionary(column, codifications);
        for (const w of this.splitWords(typeof value === "string" ? value : "")) {
            const index = dic.get(w.toLowerCase());
            if (index != null)
                target[offset + index] = 1;
        }
    }

    decodeValue(
        _column: PredictorColumnBase, codifications: PredictorCodification[], outputs: Float32Array,
    ): unknown {
        return codifications
            .filter(c => outputs[c.index]! > this.minDecodedWordValue)
            .sort((a, b) => outputs[b.index]! - outputs[a.index]!)
            .slice(0, this.maxDecodedWords)
            .map(c => String(c.isValue))
            .join(", ");
    }

    private dictionary(column: PredictorColumnBase, codifications: PredictorCodification[]): Map<string, number> {
        if (column.columnModel != null)
            return column.columnModel as Map<string, number>;

        const map = new Map<string, number>(codifications.map(c => [String(c.isValue).toLowerCase(), c.index]));
        column.columnModel = map;
        return map;
    }
}

// ---- the registry --------------------------------------------------------------------------------------

/** The six encodings the shipped predictor implements, keyed by symbol key. */
export function defaultEncodings(): Map<string, ITensorFlowEncoding> {
    return new Map<string, ITensorFlowEncoding>([
        [DefaultColumnEncodings.None.key, new NoneEncoding()],
        [DefaultColumnEncodings.OneHot.key, new OneHotEncoding()],
        [DefaultColumnEncodings.NormalizeZScore.key, new NormalizeZScoreEncoding()],
        [DefaultColumnEncodings.NormalizeMinMax.key, new NormalizeMinMaxEncoding()],
        [DefaultColumnEncodings.NormalizeLog.key, new NormalizeLogEncoding()],
        [DefaultColumnEncodings.SplitWords.key, new SplitWordsEncoding()],
    ]);
}

function single(codifications: PredictorCodification[]): PredictorCodification {
    if (codifications.length !== 1)
        throw new Error(`Expected exactly one codification, found ${codifications.length}`);
    return codifications[0]!;
}

/** The POPULATION standard deviation, as Signum's `StdDev()` is. */
function standardDeviation(values: number[], average: number): number {
    if (values.length === 0)
        return 1;
    const variance = values.reduce((acc, v) => acc + (v - average) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}
