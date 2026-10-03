import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { type int, toInt, type long, toLong } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import {
    type EpochProgressRow,
    PredictorEntity, PredictorEntity_Column, PredictorSubQueryEntity, PredictorSubQueryEntity_Column,
    PredictorColumnEncodingSymbol, PredictorColumnNullHandling, PredictorColumnUsage, PredictorEpochProgressEntity,
    PredictorState, toPredictorColumnUsage,
} from "../data/Predictor";

// Port of Signum.MachineLearning's PredictorAlgorithm.cs — the CONTRACT an algorithm implements, and the
// runtime models the pipeline passes around. No entities here: these are the in-memory shapes between
// "read the query" and "fit the network".
//
// The one idea worth naming: a **codification** is one NUMBER the network sees. A predictor's COLUMN is a
// human concept ("the order's state"); a codification is a slot in the input vector. One column becomes
// several codifications when it is one-hot encoded (one slot per distinct value) or when a sub-query
// splits it (one slot per SplitBy key). Everything downstream — the tensors, the model's input shape, the
// prediction's output — is indexed by codification, which is why they are persisted: a prediction made
// months later must use the SAME slot assignment, and the same normalization statistics, as the training.
//
// altea divergences, documented inline:
//  - `CancellationToken` → an `AbortSignal` on the context, which is what Node's cancellation is.
//  - `object?[]` keys become `unknown[]`, compared through `objectArrayKey` (a joined string) rather than
//    Signum's `ObjectArrayComparer`: a Map cannot take a structural comparer in JS, so the key IS the
//    string. Same reason altea-workflow keys its graphs by lite key.
//  - Signum's `PredictorColumnBase.ColumnModel` (a slot for the algorithm's own per-column state) is kept
//    as `columnModel`, because the encodings use it to carry their fitted statistics.

export class EpochProgress {
    constructor(
        public ellapsed: number,
        public trainingExamples: number,
        public epoch: number,
        public lossTraining: number | null,
        public accuracyTraining: number | null,
        public lossValidation: number | null = null,
        public accuracyValidation: number | null = null,
    ) { }

    toRow(): EpochProgressRow {
        return [this.ellapsed, this.trainingExamples, this.epoch,
            this.lossTraining, this.accuracyTraining, this.lossValidation, this.accuracyValidation];
    }

    toEntity(predictor: PredictorEntity): PredictorEpochProgressEntity {
        return PredictorEpochProgressEntity.create({
            predictor: predictor.toLite(),
            creationDate: Clock.now,
            ellapsed: toLong(this.ellapsed),
            trainingExamples: toInt(this.trainingExamples),
            epoch: toInt(this.epoch),
            lossTraining: this.lossTraining,
            accuracyTraining: this.accuracyTraining,
            lossValidation: this.lossValidation,
            accuracyValidation: this.accuracyValidation,
        });
    }
}

// ---- the column model ----------------------------------------------------------------------------------

/**
 * A predictor column as the pipeline sees it, whether it came from the
 * main query or from a sub-query.
 */
export abstract class PredictorColumnBase {
    /** The column's index within its own query's column list. */
    constructor(public readonly predictorColumnIndex: number) { }

    /** The algorithm's own per-column state — where an encoding parks its fitted statistics. */
    columnModel: unknown = null;

    abstract get usage(): PredictorColumnUsage;
    abstract get token(): QueryToken;
    abstract get nullHandling(): PredictorColumnNullHandling;
    abstract get encoding(): PredictorColumnEncodingSymbol;
}

export class PredictorColumnMain extends PredictorColumnBase {
    constructor(
        public readonly predictorColumn: PredictorEntity_Column,
        predictorColumnIndex: number,
        private readonly resolvedToken: QueryToken,
    ) { super(predictorColumnIndex); }

    get usage(): PredictorColumnUsage { return this.predictorColumn.usage; }
    get token(): QueryToken { return this.resolvedToken; }
    get nullHandling(): PredictorColumnNullHandling { return this.predictorColumn.nullHandling; }
    get encoding(): PredictorColumnEncodingSymbol { return this.predictorColumn.encoding; }

    toString(): string { return this.resolvedToken.fullKey(); }
}

export class PredictorColumnSubQuery extends PredictorColumnBase {
    constructor(
        public readonly predictorSubQueryColumn: PredictorSubQueryEntity_Column,
        predictorColumnIndex: number,
        public readonly subQuery: PredictorSubQueryEntity,
        /** The SplitBy values that identify this column's slot. */
        public readonly keys: unknown[],
        private readonly resolvedToken: QueryToken,
    ) { super(predictorColumnIndex); }

    get usage(): PredictorColumnUsage { return toPredictorColumnUsage(this.predictorSubQueryColumn.usage); }
    get token(): QueryToken { return this.resolvedToken; }
    get nullHandling(): PredictorColumnNullHandling {
        return this.predictorSubQueryColumn.nullHandling!;
    }
    get encoding(): PredictorColumnEncodingSymbol { return this.predictorSubQueryColumn.encoding!; }

    toString(): string { return `${this.subQuery.name}.${this.resolvedToken.fullKey()} [${this.keys.join(", ")}]`; }
}

/**
 * ONE number in the input or output vector. See the module header on
 * why this is the unit everything downstream is indexed by.
 */
export class PredictorCodification {
    constructor(public readonly column: PredictorColumnBase) { }

    /** The slot's position in its vector. Assigned once, then PERSISTED. */
    index = 0;

    /** For one-hot: the single value this slot stands for. */
    isValue: unknown = null;

    // The statistics a normalizing encoding fitted on the TRAINING data — kept so a later prediction
    // scales its input the same way. A model fed differently-scaled numbers than it learned on is not
    // slightly worse, it is meaningless.
    average: number | null = null;
    stdDev: number | null = null;
    min: number | null = null;
    max: number | null = null;

    toString(): string {
        return `${this.index} ${this.column}${this.isValue == null ? "" : ` (isValue=${String(this.isValue)})`}`;
    }
}

/** A structural key for a `unknown[]` — see the header on why this is a string rather than a comparer. */
export function objectArrayKey(keys: readonly unknown[]): string {
    return keys.map(keyOfValue).join("\u0001");
}

/**
 * One element's contribution to a structural key.
 *
 * A LITE is keyed by its own KEY, never by its display text: two employees named alike would otherwise
 * land in the same SplitBy slot, and one's values would overwrite the other's. (Signum compares these
 * through `ObjectArrayComparer` over typed values, so the question never arises there.)
 */
export function keyOfValue(value: unknown): string {
    if (value == null)
        return "\u0000null";
    const lite = value as { key?: () => string };
    return typeof lite.key === "function" ? lite.key() : String(value);
}

// ---- the contexts --------------------------------------------------------------------------------------

/** One row of the flattened training table: the main-query row plus its sub-query values. */
export interface TrainingRow {
    /** The entity the row is ABOUT, when the query projects one — used by the result saver. */
    entity: Lite<Entity> | null;
    /** Indexed by codification index. */
    inputs: Float32Array;
    outputs: Float32Array;
}

export class PredictorTrainingContext {
    constructor(
        public readonly predictor: PredictorEntity,
        public readonly signal: AbortSignal,
        /**
         * The algorithm running this training. On the CONTEXT rather than looked up from a registry by
         * every collaborator: a run has exactly one, and passing it here is what keeps the result savers
         * from having to import the logic layer (which would be a cycle).
         */
        public readonly algorithm?: IPredictorAlgorithm,
    ) { }

    /** The trained model, parked here by the algorithm so the savers and the metrics can use it. */
    trainedModel: unknown = null;

    /** Stop EARLY but keep the model, as opposed to cancelling. */
    stopTraining = false;

    message: string | null = null;
    progress: number | null = null;

    codifications: PredictorCodification[] = [];
    inputCodifications: PredictorCodification[] = [];
    outputCodifications: PredictorCodification[] = [];
    /** Codifications grouped by the column they came from, keyed by that column. */
    inputCodificationsByColumn = new Map<PredictorColumnBase, PredictorCodification[]>();
    outputCodificationsByColumn = new Map<PredictorColumnBase, PredictorCodification[]>();

    /** The flattened rows, split by `settings.testPercentage`. */
    training: TrainingRow[] = [];
    validation: TrainingRow[] = [];

    /** Reported through the progress endpoint and persisted every `saveProgressEvery`. */
    readonly epochProgresses: EpochProgress[] = [];

    reportProgress(message: string, progress: number | null = null): void {
        this.message = message;
        this.progress = progress;
    }

    /** Throw if the run has been cancelled. */
    assertNotCancelled(): void {
        if (this.signal.aborted)
            throw new TrainingCancelledError();
    }
}

/** Thrown when training was CANCELLED (as opposed to stopped early) — the state machine reads it. */
export class TrainingCancelledError extends Error {
    constructor() { super("Training cancelled"); }
}

/** What a trained predictor needs to answer a prediction. */
export class PredictorPredictContext {
    constructor(
        public readonly predictor: PredictorEntity,
        public readonly algorithm: IPredictorAlgorithm,
        public readonly codifications: PredictorCodification[],
    ) {
        this.inputCodifications = codifications.filter(c => c.column.usage === PredictorColumnUsage.Input);
        this.outputCodifications = codifications.filter(c => c.column.usage === PredictorColumnUsage.Output);
        this.inputCodificationsByColumn = groupByColumn(this.inputCodifications);
        this.outputCodificationsByColumn = groupByColumn(this.outputCodifications);
    }

    readonly inputCodifications: PredictorCodification[];
    readonly outputCodifications: PredictorCodification[];
    readonly inputCodificationsByColumn: Map<PredictorColumnBase, PredictorCodification[]>;
    readonly outputCodificationsByColumn: Map<PredictorColumnBase, PredictorCodification[]>;

    /** The loaded model — opaque to everything but the algorithm that made it. */
    model: unknown = null;
}

function groupByColumn(list: PredictorCodification[]): Map<PredictorColumnBase, PredictorCodification[]> {
    const map = new Map<PredictorColumnBase, PredictorCodification[]>();
    for (const c of list) {
        const existing = map.get(c.column);
        if (existing != null)
            existing.push(c);
        else
            map.set(c.column, [c]);
    }
    return map;
}

/**
 * The inputs of ONE prediction, and (coming back) its outputs.
 *
 * Keyed by the predictor's own column rows, so a caller names what it is supplying in the predictor's own
 * terms rather than by vector position.
 */
export interface PredictDictionary {
    predictor: PredictorEntity;
    /** The entity being predicted about, when there is one. */
    entity: Lite<Entity> | null;
    /** Main-query column → its value. */
    mainQueryValues: Map<PredictorEntity_Column, unknown>;
    /** Sub-query → (its SplitBy key → (column → value)). */
    subQueryValues: Map<PredictorSubQueryEntity, Map<string, Map<PredictorSubQueryEntity_Column, unknown>>>;

    /**
     * How the OUTPUTS should be decoded.
     *
     * It rides on the inputs rather than on the predict call because that is where the caller composes
     * one prediction: `inputsFromEntity(...)` then "and give me the top 5 alternatives". Typed as
     * `unknown` here to keep this module free of the TensorFlow encodings (the algorithm narrows it).
     */
    options?: unknown;
}

export function emptyPredictDictionary(predictor: PredictorEntity, entity: Lite<Entity> | null = null): PredictDictionary {
    return { predictor, entity, mainQueryValues: new Map(), subQueryValues: new Map() };
}

// ---- the contracts -------------------------------------------------------------------------------------

export interface IPredictorAlgorithm {
    /** Is this encoding legal for this column's type and usage? */
    validateEncodingProperty(
        predictor: PredictorEntity,
        subQuery: PredictorSubQueryEntity | null,
        encoding: PredictorColumnEncodingSymbol,
        usage: PredictorColumnUsage,
        token: QueryToken,
    ): string | null;

    train(ctx: PredictorTrainingContext): Promise<void>;

    loadModel(ctx: PredictorPredictContext): Promise<void>;

    predict(ctx: PredictorPredictContext, input: PredictDictionary): Promise<PredictDictionary>;

    predictMultiple(ctx: PredictorPredictContext, inputs: PredictDictionary[]): Promise<PredictDictionary[]>;

    /**
     * How many slots this column needs, and what each stands for. This
     * is where a one-hot column becomes N codifications.
     */
    generateCodifications(
        encoding: PredictorColumnEncodingSymbol,
        values: readonly unknown[],
        column: PredictorColumnBase,
    ): PredictorCodification[];

    getRegisteredEncodingSymbols(): PredictorColumnEncodingSymbol[];

    /**
     * Write one value into its slots of a vector, through the encoding the column declares.
     *
     * Signum has no such member: its flattening reaches into the TensorFlow encoding registry directly,
     * which only works because there is one algorithm. Putting it on the contract keeps the pipeline
     * algorithm-agnostic — and means a custom encoding an app registered is reached the same way the
     * codifications were generated.
     */
    encodeValue(
        column: PredictorColumnBase,
        codifications: PredictorCodification[],
        value: unknown,
        target: Float32Array,
        offset?: number,
    ): void;
}

export interface IPredictorResultSaver {
    assertValid(predictor: PredictorEntity): void;
    savePredictions(ctx: PredictorTrainingContext): Promise<void>;
}
