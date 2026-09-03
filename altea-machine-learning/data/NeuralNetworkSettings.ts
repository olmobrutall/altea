import { reflect, registerEnum } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import {
    entity, backReference, rowOrder, unit, format, stringLengthValidator, fieldValidation, noRepeatValidator,
} from "@altea/altea/data/decorators";
import { Lite } from "@altea/altea/data/lite";
import { type int, toInt, type long } from "@altea/altea/data/basics";
import { numberIsValidator, ComparisonType } from "@altea/altea/data/validators";
import type { IProcessDataEntity } from "@altea/altea-processes/data/Processes";
import {
    PredictorEntity, PredictorMessage, type IPredictorAlgorithmSettings,
} from "./Predictor";

// Port of Signum.MachineLearning's NeuralNetworkSettings.cs — the knobs of the one algorithm the module
// ships, plus the definition of the genetic search that tunes them (AutoconfigureNeuralNetwork).
//
// altea divergences, documented inline:
//  - `MList<NeuralNetworkHidenLayerEmbedded>` → `@part` rows. Signum's typo ("Hiden") is KEPT in the type
//    name: it is reflection identity — the table name, the `TypeEntity.cleanName` row and the `<Type Name>`
//    key of every translation file — so correcting it would silently orphan a migrated database's rows and
//    every translation of them.
//  - **the four enums keep Signum's member names, which are TensorFlow.NET/Keras function names**
//    (`softmax_cross_entropy_with_logits_v2`, `glorot_uniform_initializer`, …). Those names are the STORED
//    values and the translation keys, so renaming them to their tfjs spellings would break a migrated
//    database for cosmetics. The tfjs mapping lives in the engine instead — see
//    server/tensorflow/NetworkBuilder, which is the one place that knows both vocabularies.
//  - Signum's `PropertyValidation` for the output-activation rule reads `GetParentEntity<PredictorEntity>()`;
//    altea has no `[BindParent]`, so that rule is checked where the parent IS in hand — see
//    `validateOutputActivation`, called by the predictor's Save operation.

// ---- enums ---------------------------------------------------------------------------------------------

export enum PredictionType {
    Regression,
    MultiRegression,
    Classification,
    MultiClassification,
}
export type PredictionTypeKeys = keyof typeof PredictionType;
registerEnum(PredictionType);

export enum NeuralNetworkActivation {
    None,
    ReLU,
    Sigmoid,
    Tanh,
}
export type NeuralNetworkActivationKeys = keyof typeof NeuralNetworkActivation;
registerEnum(NeuralNetworkActivation);

/** Signum's initializer names are TensorFlow's own; see the header on why they are kept. */
export enum NeuralNetworkInitializer {
    glorot_uniform_initializer,
    ones_initializer,
    zeros_initializer,
    random_uniform_initializer,
    orthogonal_initializer,
    random_normal_initializer,
    truncated_normal_initializer,
    variance_scaling_initializer,
}
export type NeuralNetworkInitializerKeys = keyof typeof NeuralNetworkInitializer;
registerEnum(NeuralNetworkInitializer);

export enum TensorFlowOptimizer {
    Adam,
    GradientDescentOptimizer,
}
export type TensorFlowOptimizerKeys = keyof typeof TensorFlowOptimizer;
registerEnum(TensorFlowOptimizer);

export enum NeuralNetworkEvalFunction {
    softmax_cross_entropy_with_logits_v2,
    softmax_cross_entropy_with_logits,
    sigmoid_cross_entropy_with_logits,
    ClassificationError,
    MeanSquaredError,
    MeanAbsoluteError,
    MeanAbsolutePercentageError,
}
export type NeuralNetworkEvalFunctionKeys = keyof typeof NeuralNetworkEvalFunction;
registerEnum(NeuralNetworkEvalFunction);

/** Whether an eval function is a CLASSIFICATION loss — Signum's `lossIsClassification`. */
export function isClassificationFunction(f: NeuralNetworkEvalFunction): boolean {
    return f === NeuralNetworkEvalFunction.sigmoid_cross_entropy_with_logits
        || f === NeuralNetworkEvalFunction.ClassificationError;
}

/** Whether a prediction type is a CLASSIFICATION — Signum's `typeIsClassification`. */
export function isClassificationType(t: PredictionType): boolean {
    return t === PredictionType.Classification || t === PredictionType.MultiClassification;
}

// ---- the settings --------------------------------------------------------------------------------------

/** Signum's `NeuralNetworkHidenLayerEmbedded` — spelling kept deliberately (see the header). */
@reflect
@entity("Part")
export class NeuralNetworkSettingsEntity_HiddenLayer extends Entity {
    @backReference settings: Lite<NeuralNetworkSettingsEntity>;
    @rowOrder order: int;

    @unit("Neurons")
    size: int;

    activation: NeuralNetworkActivation;

    initializer: NeuralNetworkInitializer;

    clone(): NeuralNetworkSettingsEntity_HiddenLayer {
        return NeuralNetworkSettingsEntity_HiddenLayer.create({
            size: this.size, activation: this.activation, initializer: this.initializer,
        });
    }
}

@reflect
@entity("Part", "Master")
export class NeuralNetworkSettingsEntity extends Entity implements IPredictorAlgorithmSettings {
    /** Signum's `Device` — which TF device to pin. tfjs picks its backend, so this is advisory here. */
    @stringLengthValidator({ max: 100 })
    device: string | null;

    predictionType: PredictionType = PredictionType.Classification;

    @noRepeatValidator()
    hiddenLayers: NeuralNetworkSettingsEntity_HiddenLayer[];

    outputActivation: NeuralNetworkActivation = NeuralNetworkActivation.None;
    outputInitializer: NeuralNetworkInitializer = NeuralNetworkInitializer.glorot_uniform_initializer;

    optimizer: TensorFlowOptimizer = TensorFlowOptimizer.Adam;

    // Signum validates both against `predictionType` — a classification loss on a regression predictor is
    // a configuration that cannot train, so it is worth refusing at save time rather than at epoch 1.
    @fieldValidation<NeuralNetworkSettingsEntity>(s => validateEvalFunction(s, s.lossFunction))
    lossFunction: NeuralNetworkEvalFunction = NeuralNetworkEvalFunction.softmax_cross_entropy_with_logits_v2;

    @fieldValidation<NeuralNetworkSettingsEntity>(s => validateEvalFunction(s, s.evalErrorFunction))
    evalErrorFunction: NeuralNetworkEvalFunction = NeuralNetworkEvalFunction.ClassificationError;

    @numberIsValidator(ComparisonType.GreaterThan, 0)
    learningRate: number = 0.001;

    learningEpsilon: number = 1e-8;

    @numberIsValidator(ComparisonType.GreaterThan, 0)
    minibatchSize: int = toInt(1000);

    @numberIsValidator(ComparisonType.GreaterThan, 0)
    numMinibatches: int = toInt(100);

    @unit("Minibaches") @numberIsValidator(ComparisonType.GreaterThan, 0)
    bestResultFromLast: int = toInt(10);

    @unit("Minibaches") @numberIsValidator(ComparisonType.GreaterThan, 0)
    saveProgressEvery: int = toInt(5);

    // Signum's rule: progress is only COMPARABLE if the validation samples line up with the training ones.
    @unit("Minibaches") @numberIsValidator(ComparisonType.GreaterThan, 0)
    @fieldValidation<NeuralNetworkSettingsEntity>(s =>
        s.saveProgressEvery > 0 && (s.saveValidationProgressEvery as number) % (s.saveProgressEvery as number) !== 0
            ? PredictorMessage._0ShouldBeDivisibleBy12.niceToString(
                NeuralNetworkSettingsEntity.nicePropertyName(a => a.saveValidationProgressEvery),
                NeuralNetworkSettingsEntity.nicePropertyName(a => a.saveProgressEvery),
                String(s.saveProgressEvery))
            : null)
    saveValidationProgressEvery: int = toInt(10);

    cloneSettings(): IPredictorAlgorithmSettings {
        return NeuralNetworkSettingsEntity.create({
            device: this.device,
            predictionType: this.predictionType,
            hiddenLayers: this.hiddenLayers.map(hl => hl.clone()),
            outputActivation: this.outputActivation,
            outputInitializer: this.outputInitializer,
            lossFunction: this.lossFunction,
            evalErrorFunction: this.evalErrorFunction,
            optimizer: this.optimizer,
            learningRate: this.learningRate,
            learningEpsilon: this.learningEpsilon,
            minibatchSize: this.minibatchSize,
            numMinibatches: this.numMinibatches,
            bestResultFromLast: this.bestResultFromLast,
            saveProgressEvery: this.saveProgressEvery,
            saveValidationProgressEvery: this.saveValidationProgressEvery,
        });
    }
}

/** Signum's `Validate(function)` inside PropertyValidation. */
function validateEvalFunction(s: NeuralNetworkSettingsEntity, f: NeuralNetworkEvalFunction): string | null {
    if (f == null || s.predictionType == null)
        return null;

    if (isClassificationFunction(f) !== isClassificationType(s.predictionType))
        return PredictorMessage._0IsNotCompatibleWith12.niceToString(
            NeuralNetworkEvalFunction[f],
            NeuralNetworkSettingsEntity.nicePropertyName(a => a.predictionType),
            PredictionType[s.predictionType]);

    return null;
}

/**
 * Signum's output-activation rule, which it checks in `PropertyValidation` by walking up to the predictor
 * through `[BindParent]`. altea has no such link, so the check takes the predictor and is called from the
 * Save operation, where it IS in hand (see server/PredictorLogic).
 *
 * The rule: a bounded output activation cannot represent a Z-score-normalized target, because ReLU clips
 * every negative value to 0 and Sigmoid squashes into (0,1) — and a Z-score is centred on 0 with half its
 * mass below it. The model would train happily and be systematically wrong.
 */
export function validateOutputActivation(
    settings: NeuralNetworkSettingsEntity,
    predictor: PredictorEntity,
    zScoreEncodingKey: string,
): string | null {
    if (settings.outputActivation !== NeuralNetworkActivation.ReLU
        && settings.outputActivation !== NeuralNetworkActivation.Sigmoid)
        return null;

    const offenders = [
        ...predictor.columns
            .filter(c => c.usage === 1 /* Output */ && c.encoding?.key === zScoreEncodingKey)
            .map(c => c.token?.tokenString ?? ""),
        ...predictor.subQueries.flatMap(sq => sq.columns
            .filter(c => c.usage === 3 /* Output */ && c.encoding?.key === zScoreEncodingKey)
            .map(c => c.token?.tokenString ?? "")),
    ];

    if (offenders.length === 0)
        return null;

    return PredictorMessage._0CanNotBe1Because2Use3.niceToString(
        NeuralNetworkSettingsEntity.nicePropertyName(a => a.outputActivation),
        NeuralNetworkActivation[settings.outputActivation],
        offenders.join(", "),
        zScoreEncodingKey);
}

// ---- the autoconfigure definition ----------------------------------------------------------------------

/**
 * Signum's `AutoconfigureNeuralNetworkEntity` — the definition of a GENETIC SEARCH over the settings
 * above: train a population of predictors, keep the best, mutate, repeat.
 *
 * It is a process's data entity, so one run is a ProcessEntity a user can watch and cancel.
 */
@reflect
@entity("Part", "Transactional")
export class AutoconfigureNeuralNetworkEntity extends Entity implements IProcessDataEntity {
    initialPredictor: Lite<PredictorEntity>;

    exploreLearner: boolean = false;
    exploreLearningValues: boolean = false;
    exploreHiddenLayers: boolean = false;
    exploreOutputLayer: boolean = false;

    maxLayers: int = toInt(2);
    minNeuronsPerLayer: int = toInt(5);
    maxNeuronsPerLayer: int = toInt(20);

    @unit("seconds")
    oneTrainingDuration: long | null;

    generations: int = toInt(10);
    population: int = toInt(10);

    @format("p")
    survivalRate: number = 0.4;

    @format("p")
    initialMutationProbability: number = 0.1;

    seed: int | null;
}
