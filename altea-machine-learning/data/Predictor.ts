import { reflect, init, registerEnum, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Symbol } from "@altea/altea/data/symbol";
import {
    entity, backReference, rowOrder, quoted, implementedBy, implementedByAll, column, format, unit,
    stringLengthValidator, fieldValidation, noRepeatValidator, legacyTableName
} from "@altea/altea/data/decorators";
import { Lite } from "@altea/altea/data/lite";
import { type int, toInt, Temporal, type long, toLong } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import type { IUserEntity } from "@altea/altea/data/security";
import type { ExecuteSymbol, ConstructSymbol, From, DeleteSymbol } from "@altea/altea/data/operations";
import { FilePathEmbedded, FileTypeSymbol } from "@altea/altea-files/data/Files";
import { QueryFilterBaseEntity, QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import type { IProcessDataEntity } from "@altea/altea-processes/data/Processes";
import { ProcessAlgorithmSymbol, ProcessEntity } from "@altea/altea-processes/data/Processes";

// Port of Signum.MachineLearning's Predictor.cs — the PREDICTOR: which query the training examples come
// from, which of its columns are inputs and which are outputs, how each is encoded, and (once trained)
// what the resulting model scored.
//
// The shape to hold on to: a predictor is a QUERY plus a column list. Everything else — the codification
// rows, the tensors, the network — is derived from that pair, which is why a rename in the schema breaks a
// predictor the same way it breaks a user query (see @altea/altea-user-assets' token migrations).
//
// altea divergences, documented inline:
//  - every `MList` becomes `@part` rows: the predictor's sub-queries (Signum's virtual MList), its files,
//    its columns, each sub-query's filters and columns, and the hidden layers. That is what turns Signum's
//    19 entity classes into 27 tables, and it is why the sync listed 27.
//  - `[BindParent]` has no counterpart; the two places Signum uses the parent (a hidden layer validating
//    against the predictor's output columns, and `ParseData`) take it as an argument instead.
//  - `IPredictorAlgorithmSettings` is a TS INTERFACE, so `algorithmSettings` is `@implementedBy` over the
//    concrete settings entities — the app widens it, as it does for the mail services.
//  - `StateValidator` (Signum's table-driven per-state required/forbidden matrix) becomes per-field
//    `@fieldValidation`, the translation @altea/altea-email already made for the same construct.
//  - `QueryDescription` is gone, so `ParseData` — which existed to resolve each stored token against it —
//    has no counterpart at all: a token is resolved where it is USED (PredictorLogicQuery), and its
//    staleness is discovered rather than precomputed (the call the token-migration port documents).

setDefaultDatabaseSchema("machine_learning");

// ---- enums ---------------------------------------------------------------------------------------------

export enum PredictorState {
    Draft,
    Training,
    Trained,
    Error,
}
export type PredictorStateKeys = keyof typeof PredictorState;
registerEnum(PredictorState);

export enum PredictorColumnUsage {
    Input,
    Output,
}
export type PredictorColumnUsageKeys = keyof typeof PredictorColumnUsage;
registerEnum(PredictorColumnUsage);

export enum PredictorSubQueryColumnUsage {
    ParentKey,
    SplitBy,
    Input,
    Output,
}
export type PredictorSubQueryColumnUsageKeys = keyof typeof PredictorSubQueryColumnUsage;
registerEnum(PredictorSubQueryColumnUsage);

export enum PredictorColumnNullHandling {
    Zero,
    Error,
    Average,
    Min,
    Max,
}
export type PredictorColumnNullHandlingKeys = keyof typeof PredictorColumnNullHandling;
registerEnum(PredictorColumnNullHandling);

export enum PredictionSet {
    Validation,
    Training,
}
export type PredictionSetKeys = keyof typeof PredictionSet;
registerEnum(PredictionSet);

/** Signum's `PredictorColumnUsageExtensions.ToPredictorColumnUsage`. */
export function toPredictorColumnUsage(usage: PredictorSubQueryColumnUsage): PredictorColumnUsage {
    if (usage === PredictorSubQueryColumnUsage.Input)
        return PredictorColumnUsage.Input;
    if (usage === PredictorSubQueryColumnUsage.Output)
        return PredictorColumnUsage.Output;
    throw new Error("Unexpected PredictorSubQueryColumnUsage " + usage);
}

// ---- symbols -------------------------------------------------------------------------------------------

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class PredictorAlgorithmSymbol extends Symbol { }

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class PredictorResultSaverSymbol extends Symbol { }

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class PredictorPublicationSymbol extends Symbol { }

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class PredictorColumnEncodingSymbol extends Symbol { }

/** Signum's `TensorFlowPredictorAlgorithm` — the one algorithm the module ships. */
export namespace TensorFlowPredictorAlgorithm {
    export const NeuralNetworkGraph: PredictorAlgorithmSymbol = init();
}

/**
 * Signum's `DefaultColumnEncodings` — how a column's values become numbers.
 *
 * These are the six the shipped TensorFlow predictor implements (see server/tensorflow/Encodings); an app
 * may declare more and register an encoding for them.
 */
export namespace DefaultColumnEncodings {
    export const None: PredictorColumnEncodingSymbol = init();
    export const OneHot: PredictorColumnEncodingSymbol = init();
    export const NormalizeZScore: PredictorColumnEncodingSymbol = init();
    export const NormalizeMinMax: PredictorColumnEncodingSymbol = init();
    export const NormalizeLog: PredictorColumnEncodingSymbol = init();
    export const SplitWords: PredictorColumnEncodingSymbol = init();
}

export namespace PredictorSimpleResultSaver {
    export const StatisticsOnly: PredictorResultSaverSymbol = init();
    export const Full: PredictorResultSaverSymbol = init();
}

export namespace PredictorFileType {
    export const PredictorFile: FileTypeSymbol = init();
}

export namespace PredictorProcessAlgorithm {
    export const AutoconfigureNeuralNetwork: ProcessAlgorithmSymbol = init();
}

// ---- the settings interface ----------------------------------------------------------------------------

/**
 * Signum's `IPredictorAlgorithmSettings` — the per-algorithm knobs hanging off a predictor.
 *
 * A TS interface, so `PredictorEntity.algorithmSettings` is `@implementedBy` over the concrete settings
 * types; the app widens that list, the accommodation altea-email's mail services already make.
 */
export interface IPredictorAlgorithmSettings {
    /** Signum's `Clone()` — a predictor clone must not share its settings row. */
    cloneSettings(): IPredictorAlgorithmSettings;
}

// ---- the embedded value objects ------------------------------------------------------------------------

@reflect
export class PredictorSettingsEmbedded extends EmbeddedEntity {
    @format("p")
    testPercentage: number = 0.2;

    seed: int | null;

    clone(): PredictorSettingsEmbedded {
        return PredictorSettingsEmbedded.create({ testPercentage: this.testPercentage, seed: this.seed });
    }
}

@reflect
export class PredictorMetricsEmbedded extends EmbeddedEntity {
    @format("F4") loss: number | null;
    @format("F4") accuracy: number | null;
}

@reflect
export class PredictorClassificationMetricsEmbedded extends EmbeddedEntity {
    totalCount: int;
    missCount: int;

    // Signum computes this in PreSaving; altea has no entity-level hook, so the SAVER fills it (see
    // server/PredictorLogic's preSaving handler) — it is derived, and a stored value that disagreed with
    // its two inputs would be worse than none.
    @format("p2")
    missRate: number | null;
}

@reflect
export class PredictorRegressionMetricsEmbedded extends EmbeddedEntity {
    @format("F4") meanError: number | null;
    @format("F4") @unit("±") meanSquaredError: number | null;
    @format("F4") @unit("±") meanAbsoluteError: number | null;
    @format("F4") @unit("±") rootMeanSquareError: number | null;
    @format("P2") meanPercentageError: number | null;
    @format("P2") @unit("±") meanAbsolutePercentageError: number | null;
}

// ---- the predictor's own column rows -------------------------------------------------------------------

/**
 * Signum's `PredictorColumnEmbedded` — one column of the main query: what it is FOR (input or output),
 * which token it reads, how it is encoded, and what to do when it is null.
 */
@reflect
@entity("Part")
@legacyTableName("PredictorMainQueryColumns")
export class PredictorEntity_Column extends Entity {
    @backReference predictor: Lite<PredictorEntity>;
    @rowOrder order: int;

    usage: PredictorColumnUsage;

    token: QueryTokenEmbedded;

    encoding: PredictorColumnEncodingSymbol;

    nullHandling: PredictorColumnNullHandling;

    clone(): PredictorEntity_Column {
        return PredictorEntity_Column.create({
            usage: this.usage,
            token: QueryTokenEmbedded.create({ tokenString: this.token.tokenString }),
            encoding: this.encoding,
            nullHandling: this.nullHandling,
        });
    }

    /** Signum's `Equals` — a column IS its (token, usage) pair; the encoding is how, not which. */
    equalsColumn(other: PredictorEntity_Column | null): boolean {
        return other != null
            && this.token?.tokenString === other.token?.tokenString
            && this.usage === other.usage;
    }

    toString(): string {
        return `${PredictorColumnUsage[this.usage]} ${this.token?.tokenString ?? ""} ${this.encoding?.key ?? ""}`;
    }
}

/** Signum's `MList<QueryFilterEmbedded> Filters` on the main query — a `@part` row over the shared base. */
@reflect
@entity("Part")
@legacyTableName("PredictorMainQueryFilters")
export class PredictorEntity_Filter extends QueryFilterBaseEntity {
    @backReference predictor: Lite<PredictorEntity>;
}

/** Signum's `MList<FilePathEmbedded> Files` — the trained model's files. */
@reflect
@entity("Part")
@legacyTableName("PredictorFiles")
export class PredictorEntity_File extends Entity {
    @backReference predictor: Lite<PredictorEntity>;
    @rowOrder order: int;

    element: FilePathEmbedded;
}

/**
 * Signum's `PredictorMainQueryEmbedded`.
 *
 * altea divergence: its two MLists (filters and columns) are `@part` rows, and a `@part` row needs a real
 * owner TABLE — which a flattened embedded is not. So the filters and columns hang off the PREDICTOR
 * (see `PredictorEntity.filters` / `.columns`) and this keeps only the scalar pair. Signum's grouping is
 * preserved where it matters — in the UI, which still presents them as one "main query" block.
 */
@reflect
export class PredictorMainQueryEmbedded extends EmbeddedEntity {
    query: QueryEntity;

    groupResults: boolean = false;
}

// ---- the sub-query rows --------------------------------------------------------------------------------

/**
 * Signum's `PredictorSubQueryColumnEmbedded` — one column of a sub-query. Beyond the main query's usages
 * it has two structural ones: `ParentKey` (how a sub-query row joins back to a main-query row) and
 * `SplitBy` (what turns a collection of rows into a fixed set of columns).
 */
@reflect
@entity("Part")
@legacyTableName("PredictorSubQueryColumns")
export class PredictorSubQueryEntity_Column extends Entity {
    @backReference subQuery: Lite<PredictorSubQueryEntity>;
    @rowOrder order: int;

    usage: PredictorSubQueryColumnUsage;

    token: QueryTokenEmbedded;

    // Signum's StateValidator: an encoding and a null handling are required for Input/Output and
    // FORBIDDEN for ParentKey/SplitBy — those two are structural, not data to feed a network.
    @fieldValidation<PredictorSubQueryEntity_Column>(c => isDataUsage(c.usage) === (c.encoding == null)
        ? PredictorMessage.EncodingIsRequiredForInputAndOutputColumnsOnly.niceToString() : null)
    encoding: PredictorColumnEncodingSymbol | null;

    @fieldValidation<PredictorSubQueryEntity_Column>(c => isDataUsage(c.usage) === (c.nullHandling == null)
        ? PredictorMessage.NullHandlingIsRequiredForInputAndOutputColumnsOnly.niceToString() : null)
    nullHandling: PredictorColumnNullHandling | null;

    clone(): PredictorSubQueryEntity_Column {
        return PredictorSubQueryEntity_Column.create({
            usage: this.usage,
            token: QueryTokenEmbedded.create({ tokenString: this.token.tokenString }),
            encoding: this.encoding,
            nullHandling: this.nullHandling,
        });
    }

    equalsColumn(other: PredictorSubQueryEntity_Column | null): boolean {
        return other != null
            && this.token?.tokenString === other.token?.tokenString
            && this.usage === other.usage;
    }

    toString(): string {
        return `${PredictorSubQueryColumnUsage[this.usage]} ${this.token?.tokenString ?? ""} ${this.encoding?.key ?? ""}`;
    }
}

/** Whether a sub-query column carries DATA (so it needs an encoding) or STRUCTURE (so it must not). */
export function isDataUsage(usage: PredictorSubQueryColumnUsage): boolean {
    return usage === PredictorSubQueryColumnUsage.Input || usage === PredictorSubQueryColumnUsage.Output;
}

@reflect
@entity("Part")
@legacyTableName("PredictorSubQueryFilters")
export class PredictorSubQueryEntity_Filter extends QueryFilterBaseEntity {
    @backReference subQuery: Lite<PredictorSubQueryEntity>;
}

/**
 * Signum's `PredictorSubQueryEntity` — a SECOND query whose rows are folded into the main query's, so a
 * predictor can learn from a one-to-many relationship (an order's lines, a customer's past orders).
 *
 * Signum declares it a virtual MList (`[Ignore, QueryableProperty]` + a back reference); in altea a
 * `@part` row IS that shape, so it needs no such marker pair.
 */
@reflect
@entity("Part")
@legacyTableName({ name: "PredictorSubQuery", wasVirtualMList: true })
export class PredictorSubQueryEntity extends Entity {
    @backReference predictor: Lite<PredictorEntity>;
    @rowOrder order: int;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    query: QueryEntity;

    filters: PredictorSubQueryEntity_Filter[];

    @noRepeatValidator()
    columns: PredictorSubQueryEntity_Column[];

    @quoted
    override toString(): string {
        return this.name;
    }

    /** Signum's `FindColumn(part)` — the single column whose token ends in this member. */
    findColumn(part: string): PredictorSubQueryEntity_Column {
        const found = this.columns.filter(c => tokenContainsKey(c.token, part));
        if (found.length !== 1)
            throw new Error(`${found.length} columns match '${part}' on sub-query '${this.name}'`);
        return found[0]!;
    }
}

/** Signum's `QueryToken.ContainsKey(part)` — the token's path passes through this member. */
export function tokenContainsKey(token: QueryTokenEmbedded | null, part: string): boolean {
    return token?.tokenString?.split(".").includes(part) === true;
}

// ---- the predictor -------------------------------------------------------------------------------------

@reflect
@entity("Main", "Transactional")
export class PredictorEntity extends Entity implements IProcessDataEntity {
    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null;

    settings: PredictorSettingsEmbedded;

    algorithm: PredictorAlgorithmSymbol;

    resultSaver: PredictorResultSaverSymbol | null;

    publication: PredictorPublicationSymbol | null;

    trainingException: Lite<ExceptionEntity> | null;

    // Core declares no implementations for a user reference so it needn't reference altea-auth; this
    // module DOES depend on it, so the implementation is named here as Signum's `[ImplementedBy]` does.
    @implementedBy(() => [])
    user: Lite<IUserEntity> | null;

    /** Signum's `[ImplementedBy(typeof(NeuralNetworkSettingsEntity))] IPredictorAlgorithmSettings`. */
    @implementedBy(() => [])
    algorithmSettings: IPredictorAlgorithmSettings;

    state: PredictorState = PredictorState.Draft;

    mainQuery: PredictorMainQueryEmbedded;

    // The main query's filters and columns — Signum keeps them INSIDE PredictorMainQueryEmbedded; a
    // `@part` row needs a real owner table, so they hang off the predictor. See that class's header.
    filters: PredictorEntity_Filter[];

    @noRepeatValidator()
    columns: PredictorEntity_Column[];

    subQueries: PredictorSubQueryEntity[];

    @noRepeatValidator()
    files: PredictorEntity_File[];

    resultTraining: PredictorMetricsEmbedded | null;
    resultValidation: PredictorMetricsEmbedded | null;
    classificationTraining: PredictorClassificationMetricsEmbedded | null;
    classificationValidation: PredictorClassificationMetricsEmbedded | null;
    regressionTraining: PredictorRegressionMetricsEmbedded | null;
    regressionValidation: PredictorRegressionMetricsEmbedded | null;

    @quoted
    override toString(): string {
        return this.name!;
    }

    /** Signum's `MainQuery.FindColumn(part)`. */
    findColumn(part: string): PredictorEntity_Column {
        const found = this.columns.filter(c => tokenContainsKey(c.token, part));
        if (found.length !== 1)
            throw new Error(`${found.length} main-query columns match '${part}'`);
        return found[0]!;
    }

    tryFindColumn(part: string): PredictorEntity_Column | null {
        const found = this.columns.filter(c => tokenContainsKey(c.token, part));
        return found.length === 1 ? found[0]! : null;
    }
}

export namespace PredictorOperation {
    export const Save: ExecuteSymbol<PredictorEntity> = init();
    export const Train: ExecuteSymbol<PredictorEntity> = init();
    export const CancelTraining: ExecuteSymbol<PredictorEntity> = init();
    export const StopTraining: ExecuteSymbol<PredictorEntity> = init();
    export const Untrain: ExecuteSymbol<PredictorEntity> = init();
    export const Publish: ExecuteSymbol<PredictorEntity> = init();
    export const AfterPublishProcess: ConstructSymbol<Entity, From<PredictorEntity>> = init();
    export const Delete: DeleteSymbol<PredictorEntity> = init();
    export const Clone: ConstructSymbol<PredictorEntity, From<PredictorEntity>> = init();
    export const AutoconfigureNetwork: ConstructSymbol<ProcessEntity, From<PredictorEntity>> = init();
}

// ---- the derived rows ----------------------------------------------------------------------------------

/**
 * Signum's `PredictorCodificationEntity` — one row per NUMBER the network sees.
 *
 * This is the join between the human definition and the tensors: a single one-hot column over five
 * distinct values becomes five codifications, and a sub-query column split three ways becomes three. The
 * row also carries the statistics a normalizing encoding needs (average / stdDev / min / max), because a
 * PREDICTION has to normalize its input exactly as the training data was normalized — otherwise the model
 * is fed numbers on a different scale than it learned on.
 */
@reflect
@entity("System", "Transactional")
export class PredictorCodificationEntity extends Entity {
    predictor: Lite<PredictorEntity>;

    usage: PredictorColumnUsage;

    /** The position of this number in the input (or output) vector. */
    index: int;

    /** Which sub-query it came from, or null for the main query. */
    subQueryIndex: int | null;

    /** Which of that query's columns it came from. */
    originalColumnIndex: int;

    // For flattening collections: the SplitBy values that identify this codification's row.
    @stringLengthValidator({ max: 100 }) splitKey0: string | null;
    @stringLengthValidator({ max: 100 }) splitKey1: string | null;
    @stringLengthValidator({ max: 100 }) splitKey2: string | null;

    /** For one-hot encoding: the single value this column stands for. */
    @stringLengthValidator({ max: 100 }) isValue: string | null;

    average: number | null;
    stdDev: number | null;
    min: number | null;
    max: number | null;
}

/** Signum's `PredictorEpochProgressEntity` — one row per recorded training epoch, for the loss chart. */
@reflect
@entity("System", "Transactional")
export class PredictorEpochProgressEntity extends Entity {
    predictor: Lite<PredictorEntity>;

    creationDate: Temporal.PlainDateTime = Clock.now;

    @unit("ms")
    ellapsed: long = toLong(0);

    trainingExamples: int;

    epoch: int;

    @format("0.0000") lossTraining: number | null;
    @format("0.0000") accuracyTraining: number | null;
    @format("0.0000") lossValidation: number | null;
    @format("0.0000") accuracyValidation: number | null;
}

/**
 * Signum's `PredictSimpleResultEntity` — one row per training example, with what the model predicted
 * beside what actually happened. Written by the `Full` result saver, and the reason it exists is that
 * aggregate metrics hide WHICH rows a model gets wrong.
 */
@reflect
@entity("System", "Transactional")
export class PredictSimpleResultEntity extends Entity {
    predictor: Lite<PredictorEntity>;

    @implementedByAll
    target: Lite<Entity> | null;

    @stringLengthValidator({ max: 100 }) key0: string | null;
    @stringLengthValidator({ max: 100 }) key1: string | null;
    @stringLengthValidator({ max: 100 }) key2: string | null;

    type: PredictionSet;

    @stringLengthValidator({ max: 200 }) originalCategory: string | null;
    @format("0.0000") originalValue: number | null;

    @stringLengthValidator({ max: 200 }) predictedCategory: string | null;
    @format("0.0000") predictedValue: number | null;
}

// ---- messages ------------------------------------------------------------------------------------------

export const PredictorMessage = {
    Csv: msg(),
    Tsv: msg(),
    TsvMetadata: msg("TSV Metadata"),
    DownloadCsv: msg("Download CSV"),
    DownloadTsv: msg("Download TSV"),
    DownloadTsvMetadata: msg("Download TSV Metadata"),
    OpenTensorflowProjector: msg("Open Tensorflow Projector"),
    _0ShouldBeDivisibleBy12: msg("{0} should be divisible by {1} ({2})"),
    _0IsNotCompatibleWith12: msg("{0} is not compatible with {1} {2}"),
    _0CanNotBe1Because2Use3: msg("{0} can not be {1} because {2} use {3}"),
    Predict: msg(),
    Preview: msg(),
    Codifications: msg(),
    Progress: msg(),
    Results: msg(),
    ShouldBeOfType0: msg("Should be of type {0}"),
    TooManyParentKeys: msg(),
    TheTypeOf01DoesNotMatch23: msg("The type of {0} ({1}) does not match {2} ({3})"),
    ThereShouldBe0ColumnsWith12Currently3: msg("There should be {0} columns with {1} {2} (currently {3})"),
    _0IsRequiredFor1: msg("{0} is required for {1}"),
    NoPublicationsForQuery0Registered: msg("No publications for query {0} registered"),
    NoPublicationsProcessRegisteredFor0: msg("No publications process registered for {0}"),
    _0IsAlreadyBeingTrained: msg("{0} is already being trained"),
    StartingTraining: msg("Starting training…"),
    Preprocessing: msg("Preprocessing…"),
    Training: msg("Training…"),
    Saving: msg("Saving…"),
    Done: msg(),
    // altea additions: the two StateValidator rules Signum expresses as a table (see the column).
    EncodingIsRequiredForInputAndOutputColumnsOnly: msg("Encoding is required for Input and Output columns, and forbidden for the rest"),
    NullHandlingIsRequiredForInputAndOutputColumnsOnly: msg("Null handling is required for Input and Output columns, and forbidden for the rest"),
    NoOutputColumn: msg("The predictor has no Output column"),
    _0NotSuportedFor1: msg("{0} not supported for {1}"),
    NoInputColumn: msg("The predictor has no Input column"),
    PredictorIsPublishedUntrainAnyway: msg("The predictor is published. Untrain anyway?"),
};

// ---- the wire DTOs -------------------------------------------------------------------------------------
//
// Declared HERE rather than in server/ because they are the shape of two ENDPOINTS, and both tiers need
// them: the routes answer them and the designer reads them. (The client cannot import from server/ — the
// layers are separate projects.)

/** Signum's `TrainingProgress` — what `/api/predictor/trainingProgress` answers. */
export interface TrainingProgress {
    message: string | null;
    /** 0..1, or null when the step has no measurable progress. */
    progress: number | null;
    running: boolean;
    state: PredictorState;
    epochProgresses: EpochProgressRow[] | null;
}

/**
 * One epoch's row, in the compact ARRAY form the loss chart reads — Signum's `ToObjectArray`.
 *
 * An array rather than an object on purpose: a long training records hundreds of these and they are only
 * ever read positionally by the chart, so the field names would be most of the payload.
 */
export type EpochProgressRow = [
    ellapsed: number, trainingExamples: number, epoch: number,
    lossTraining: number | null, accuracyTraining: number | null,
    lossValidation: number | null, accuracyValidation: number | null,
];
