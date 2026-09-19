import * as tfc from "@tensorflow/tfjs-core";
import * as tfl from "@tensorflow/tfjs-layers";
import {
    NeuralNetworkActivation, NeuralNetworkEvalFunction, NeuralNetworkInitializer, NeuralNetworkSettingsEntity,
    PredictionType, TensorFlowOptimizer, isClassificationType,
} from "../../data/NeuralNetworkSettings";

// Port of Signum.MachineLearning's TensorFlow/NetworkBuilder.cs — turn the stored settings into a model.
//
// **This is the one file that knows both vocabularies.** The four settings enums keep Signum's member
// names, which are TensorFlow.NET / Keras function names (`glorot_uniform_initializer`,
// `softmax_cross_entropy_with_logits_v2`); tfjs spells the same things differently (`glorotUniform`,
// `categoricalCrossentropy`). Those names are STORED values and translation keys, so they are not
// renamed — see data/NeuralNetworkSettings' header — and the mapping lives here instead.
//
// The engine is tfjs-CORE + tfjs-LAYERS, not the union `@tensorflow/tfjs` bundle and not
// `@tensorflow/tfjs-node`. See TensorFlowNeuralNetworkPredictor's header for both reasons.

/** The activation switch. tfjs's "no activation" is `linear`, which is identity. */
export function toActivation(a: NeuralNetworkActivation): "linear" | "relu" | "sigmoid" | "tanh" {
    switch (a) {
        case NeuralNetworkActivation.None: return "linear";
        case NeuralNetworkActivation.ReLU: return "relu";
        case NeuralNetworkActivation.Sigmoid: return "sigmoid";
        case NeuralNetworkActivation.Tanh: return "tanh";
        default: throw new Error("Unexpected NeuralNetworkActivation " + a);
    }
}

/**
 * The initializer switch.
 *
 * Two of TensorFlow's eight have no tfjs counterpart as a NAMED initializer, and both are mapped to the
 * nearest one that exists rather than silently ignored:
 *  - `variance_scaling_initializer` → tfjs's `varianceScaling` (same thing, different spelling);
 *  - `orthogonal_initializer` → tfjs's `orthogonal` (present since 1.x).
 * So all eight do map; the list is written out so a future tfjs rename fails HERE rather than at fit().
 */
export function toInitializer(i: NeuralNetworkInitializer): string {
    switch (i) {
        case NeuralNetworkInitializer.glorot_uniform_initializer: return "glorotUniform";
        case NeuralNetworkInitializer.ones_initializer: return "ones";
        case NeuralNetworkInitializer.zeros_initializer: return "zeros";
        case NeuralNetworkInitializer.random_uniform_initializer: return "randomUniform";
        case NeuralNetworkInitializer.orthogonal_initializer: return "orthogonal";
        case NeuralNetworkInitializer.random_normal_initializer: return "randomNormal";
        case NeuralNetworkInitializer.truncated_normal_initializer: return "truncatedNormal";
        case NeuralNetworkInitializer.variance_scaling_initializer: return "varianceScaling";
        default: throw new Error("Unexpected NeuralNetworkInitializer " + i);
    }
}

/** The optimizer switch. `learningEpsilon` is Adam's epsilon; SGD has none. */
export function toOptimizer(settings: NeuralNetworkSettingsEntity): tfc.Optimizer {
    switch (settings.optimizer) {
        case TensorFlowOptimizer.Adam:
            return tfc.train.adam(settings.learningRate, undefined, undefined, settings.learningEpsilon);
        case TensorFlowOptimizer.GradientDescentOptimizer:
            return tfc.train.sgd(settings.learningRate);
        default: throw new Error("Unexpected TensorFlowOptimizer " + settings.optimizer);
    }
}

/**
 * The loss / eval switch, and the one place the two frameworks genuinely differ in KIND.
 *
 * TensorFlow's `*_cross_entropy_with_logits` functions take LOGITS — raw scores — and apply the softmax /
 * sigmoid internally, which is why Signum's networks leave their output activation at None. tfjs's
 * `categoricalCrossentropy` / `binaryCrossentropy` losses take PROBABILITIES. Mapping the names alone
 * would therefore train a model on unnormalized scores and quietly produce nonsense.
 *
 * So the mapping is a PAIR: the loss, and the output activation that loss requires. The predictor applies
 * the returned activation to the output layer (overriding the stored `outputActivation` when the loss
 * demands it), which reproduces TensorFlow's from-logits behaviour exactly.
 */
export function toLoss(f: NeuralNetworkEvalFunction): { loss: string; requiredOutputActivation: string | null } {
    switch (f) {
        case NeuralNetworkEvalFunction.softmax_cross_entropy_with_logits_v2:
        case NeuralNetworkEvalFunction.softmax_cross_entropy_with_logits:
            // from_logits in TF ⇒ softmax must be applied here.
            return { loss: "categoricalCrossentropy", requiredOutputActivation: "softmax" };
        case NeuralNetworkEvalFunction.sigmoid_cross_entropy_with_logits:
            return { loss: "binaryCrossentropy", requiredOutputActivation: "sigmoid" };
        case NeuralNetworkEvalFunction.ClassificationError:
            // Signum uses this as an EVAL (metric) rather than a trainable loss; as a loss it stands for
            // "the usual classification loss", which is what categorical cross-entropy is.
            return { loss: "categoricalCrossentropy", requiredOutputActivation: "softmax" };
        case NeuralNetworkEvalFunction.MeanSquaredError:
            return { loss: "meanSquaredError", requiredOutputActivation: null };
        case NeuralNetworkEvalFunction.MeanAbsoluteError:
            return { loss: "meanAbsoluteError", requiredOutputActivation: null };
        case NeuralNetworkEvalFunction.MeanAbsolutePercentageError:
            return { loss: "meanAbsolutePercentageError", requiredOutputActivation: null };
        default: throw new Error("Unexpected NeuralNetworkEvalFunction " + f);
    }
}

/** The metric tfjs should report alongside the loss — accuracy for a classification, none otherwise. */
export function toMetrics(predictionType: PredictionType): string[] {
    return isClassificationType(predictionType) ? ["accuracy"] : [];
}

/**
 * The model: one dense layer per hidden layer, then the output.
 *
 * `inputSize` / `outputSize` are CODIFICATION counts, not column counts (see PredictorAlgorithm's header):
 * a one-hot column contributes one input per distinct value.
 */
export function buildModel(
    settings: NeuralNetworkSettingsEntity,
    inputSize: number,
    outputSize: number,
): tfl.Sequential {
    if (inputSize <= 0)
        throw new Error("The predictor has no input codifications — nothing to learn from");
    if (outputSize <= 0)
        throw new Error("The predictor has no output codifications — nothing to learn");

    const model = tfl.sequential();

    const layers = settings.hiddenLayers.orderBy(a => a.rowOrder);
    layers.forEach((hl, i) => {
        model.add(tfl.layers.dense({
            units: hl.size as number,
            activation: toActivation(hl.activation),
            kernelInitializer: toInitializer(hl.initializer),
            // Only the FIRST layer declares the input shape; tfjs infers the rest.
            ...(i === 0 ? { inputShape: [inputSize] } : {}),
        }));
    });

    const { loss, requiredOutputActivation } = toLoss(settings.lossFunction);

    model.add(tfl.layers.dense({
        units: outputSize,
        // The loss decides when it must be softmax/sigmoid — see toLoss on why this overrides the stored
        // value rather than trusting it.
        activation: (requiredOutputActivation ?? toActivation(settings.outputActivation)) as never,
        kernelInitializer: toInitializer(settings.outputInitializer),
        // With no hidden layers the OUTPUT layer is the first, so it carries the input shape.
        ...(layers.length === 0 ? { inputShape: [inputSize] } : {}),
    }));

    model.compile({
        optimizer: toOptimizer(settings),
        loss,
        metrics: toMetrics(settings.predictionType),
    });

    return model;
}
