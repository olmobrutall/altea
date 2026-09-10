import "@altea/altea/server"; // installs Entity.save()/delete()
import { Saver } from "@altea/altea/server/saver";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { toInt } from "@altea/altea/data/basics";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    PredictionSet, PredictorColumnUsage, PredictorEntity, PredictorMessage, PredictorSimpleResultSaver,
    PredictSimpleResultEntity, PredictorClassificationMetricsEmbedded, PredictorRegressionMetricsEmbedded,
} from "../data/Predictor";
import { NeuralNetworkSettingsEntity, PredictionType, isClassificationType } from "../data/NeuralNetworkSettings";
import {
    type IPredictorResultSaver, type PredictorCodification, type PredictorTrainingContext, type TrainingRow,
} from "./PredictorAlgorithm";
import { PredictorPredictContext } from "./PredictorAlgorithm";

// Port of Signum.MachineLearning's PredictorSimpleSaver.cs — what to KEEP about a finished training
// beyond its aggregate loss.
//
// Two savers, and the difference is what you can do afterwards:
//   • `StatisticsOnly` computes the classification / regression metrics and stores them on the predictor.
//     Cheap, and enough to compare two models.
//   • `Full` additionally writes one PredictSimpleResult row per training example — what the model said
//     beside what actually happened. That is the only way to answer "WHICH rows does it get wrong", which
//     aggregate metrics hide: a model with 95% accuracy that is wrong on exactly the cases anyone cares
//     about is worse than useless, and no summary number shows that.
//
// altea divergences, documented inline:
//  - the metrics land on the predictor through the training run, and the classification MISS RATE is
//    computed here, Signum's embedded computing its own in `PreSaving` — for which there is no hook.
//  - the per-row predictions are written in ONE `Saver.save` batch rather than row by row: a training set
//    is thousands of rows, and Signum's own loop is a bulk insert.

export namespace PredictorSimpleSaver {

    /**
     * Register both savers. The REGISTRAR is passed in rather than imported, so this module depends on
     * nothing in the logic layer — which is what keeps saver ↔ logic from being an import cycle.
     */
    export function register(
        registrar: (symbol: typeof PredictorSimpleResultSaver.Full, saver: IPredictorResultSaver) => void,
    ): void {
        registrar(PredictorSimpleResultSaver.StatisticsOnly, statisticsOnly);
        registrar(PredictorSimpleResultSaver.Full, full);
    }

    /** The shared validity rule: both savers need exactly ONE output column to summarise. */
    function assertValid(predictor: PredictorEntity): void {
        const outputs = predictor.columns.filter(c => c.usage === PredictorColumnUsage.Output);
        if (outputs.length !== 1)
            throw new Error(`The simple result savers need exactly one Output column, this predictor has `
                + `${outputs.length}. Use a saver that understands multiple outputs, or reduce the columns.`);
    }

    export const statisticsOnly = {
        assertValid,
        async savePredictions(ctx: PredictorTrainingContext): Promise<void> {
            await computeMetrics(ctx);
        },
    };

    export const full = {
        assertValid,
        async savePredictions(ctx: PredictorTrainingContext): Promise<void> {
            const rows = await computeMetrics(ctx);
            await writeRows(ctx, rows);
        },
    };

    /** One evaluated example: what the model said, and what was true. */
    interface Evaluated {
        row: TrainingRow;
        set: PredictionSet;
        originalCategory: string | null;
        originalValue: number | null;
        predictedCategory: string | null;
        predictedValue: number | null;
    }

    /**
     * Run the fitted model over both sets, store the metrics, and hand back the per-row comparison the
     * `Full` saver persists.
     */
    async function computeMetrics(ctx: PredictorTrainingContext): Promise<Evaluated[]> {
        const predictor = ctx.predictor;
        const nn = predictor.algorithmSettings as NeuralNetworkSettingsEntity;
        const classification = nn?.predictionType != null && isClassificationType(nn.predictionType);

        const evaluated = [
            ...await evaluateSet(ctx, ctx.training, PredictionSet.Training),
            ...await evaluateSet(ctx, ctx.validation, PredictionSet.Validation),
        ];

        const training = evaluated.filter(e => e.set === PredictionSet.Training);
        const validation = evaluated.filter(e => e.set === PredictionSet.Validation);

        if (classification) {
            predictor.classificationTraining = classificationMetrics(training);
            predictor.classificationValidation = classificationMetrics(validation);
        } else {
            predictor.regressionTraining = regressionMetrics(training);
            predictor.regressionValidation = regressionMetrics(validation);
        }

        return evaluated;
    }

    /** Predict every row of a set in ONE batch, and pair each prediction with its truth. */
    async function evaluateSet(
        ctx: PredictorTrainingContext, rows: TrainingRow[], set: PredictionSet,
    ): Promise<Evaluated[]> {
        if (rows.length === 0)
            return [];

        const predictor = ctx.predictor;
        const algorithm = ctx.algorithm;
        if (algorithm == null)
            return [];

        // A predict context over the SAME codifications the training just assigned — the model is the one
        // in memory, so nothing is read back from disk here.
        const pctx = new PredictorPredictContext(predictor, algorithm, ctx.codifications);
        pctx.model = ctx.trainedModel;

        const outputColumn = [...ctx.outputCodificationsByColumn.keys()][0]!;
        const outputCods = ctx.outputCodificationsByColumn.get(outputColumn)!;
        const isOneHot = outputCods.length > 1 || outputCods.some(c => c.isValue != null);

        const results: Evaluated[] = [];

        // Feed the stored INPUT vectors straight back — they are already codified, so this measures the
        // model rather than the codification.
        const inputSize = ctx.inputCodifications.length;
        const model = pctx.model as { predict(x: unknown): { data(): Promise<Float32Array>; dispose(): void } } | null;
        if (model == null)
            return [];

        const tfc = await import("@tensorflow/tfjs-core");
        const flat = new Float32Array(rows.length * inputSize);
        rows.forEach((r, i) => flat.set(r.inputs, i * inputSize));
        const x = tfc.tensor2d(flat, [rows.length, inputSize]);

        try {
            const out = model.predict(x);
            const data = await out.data();
            out.dispose();

            const width = ctx.outputCodifications.length;
            rows.forEach((row, i) => {
                const predicted = data.subarray(i * width, (i + 1) * width);
                results.push(compare(row, predicted, outputCods, isOneHot, set));
            });
        } finally {
            x.dispose();
        }

        return results;
    }

    /**
     * Pair one row's truth with its prediction.
     *
     * For a one-hot output both sides are the ARGMAX slot's value — a category. For a scalar output both
     * are the number in the single slot. Note the truth is read from the stored output VECTOR, not
     * re-queried: that is what makes the comparison exactly what the model was trained against.
     */
    function compare(
        row: TrainingRow, predicted: Float32Array, cods: PredictorCodification[],
        isOneHot: boolean, set: PredictionSet,
    ): Evaluated {
        if (isOneHot) {
            const truth = argmax(row.outputs, cods);
            const guess = argmax(predicted, cods);
            return {
                row, set,
                originalCategory: truth == null ? null : String(truth),
                originalValue: null,
                predictedCategory: guess == null ? null : String(guess),
                predictedValue: null,
            };
        }

        const index = cods[0]!.index;
        return {
            row, set,
            originalCategory: null,
            originalValue: row.outputs[index] ?? null,
            predictedCategory: null,
            predictedValue: predicted[index] ?? null,
        };
    }

    function argmax(values: Float32Array, cods: PredictorCodification[]): unknown {
        let best: PredictorCodification | null = null;
        let max = -Infinity;
        for (const c of cods) {
            const v = values[c.index] ?? -Infinity;
            if (v > max) { max = v; best = c; }
        }
        return best?.isValue ?? null;
    }

    /**
     * The classification metrics: how many the model got WRONG.
     *
     * The miss RATE is computed here because Signum computes it in the embedded's `PreSaving`, for which
     * has no counterpart for — and a stored rate that disagreed with its own two inputs would be worse
     * than none.
     */
    function classificationMetrics(list: Evaluated[]): PredictorClassificationMetricsEmbedded {
        const missCount = list.filter(e => e.originalCategory !== e.predictedCategory).length;
        return PredictorClassificationMetricsEmbedded.create({
            totalCount: toInt(list.length),
            missCount: toInt(missCount),
            missRate: list.length === 0 ? null : Math.round((missCount / list.length) * 100) / 100,
        });
    }

    /**
     * The regression metrics — six of them, because they answer different questions:
     * the mean error shows BIAS (is it high or low on average), the absolute and squared ones show
     * magnitude (and the squared one punishes outliers), and the percentage pair puts both in
     * scale-free terms.
     */
    function regressionMetrics(list: Evaluated[]): PredictorRegressionMetricsEmbedded {
        if (list.length === 0)
            return PredictorRegressionMetricsEmbedded.create({});

        const errors = list.map(e => (e.predictedValue ?? 0) - (e.originalValue ?? 0));
        const n = errors.length;
        const meanError = errors.reduce((a, b) => a + b, 0) / n;
        const meanSquaredError = errors.reduce((a, b) => a + b * b, 0) / n;
        const meanAbsoluteError = errors.reduce((a, b) => a + Math.abs(b), 0) / n;

        // A percentage error needs a non-zero truth to divide by; rows whose truth is 0 are SKIPPED
        // rather than producing an Infinity that swallows the average.
        const percentages = list
            .filter(e => (e.originalValue ?? 0) !== 0)
            .map(e => ((e.predictedValue ?? 0) - e.originalValue!) / e.originalValue!);

        const meanPercentageError = percentages.length === 0 ? null
            : percentages.reduce((a, b) => a + b, 0) / percentages.length;
        const meanAbsolutePercentageError = percentages.length === 0 ? null
            : percentages.reduce((a, b) => a + Math.abs(b), 0) / percentages.length;

        return PredictorRegressionMetricsEmbedded.create({
            meanError,
            meanSquaredError,
            meanAbsoluteError,
            rootMeanSquareError: Math.sqrt(meanSquaredError),
            meanPercentageError,
            meanAbsolutePercentageError,
        });
    }

    /** The `Full` saver's rows — one per training example. */
    async function writeRows(ctx: PredictorTrainingContext, evaluated: Evaluated[]): Promise<void> {
        const predictor = ctx.predictor;

        const rows = evaluated.map(e => PredictSimpleResultEntity.create({
            predictor: predictor.toLite(),
            target: e.row.entity as Lite<Entity> | null,
            type: e.set,
            originalCategory: truncate(e.originalCategory, 200),
            originalValue: e.originalValue,
            predictedCategory: truncate(e.predictedCategory, 200),
            predictedValue: e.predictedValue,
        }));

        if (rows.length === 0)
            return;

        await ExecutionMode.global(() => Transaction.forceNew(async () => {
            await Saver.save(rows as never[]);
        }));
    }

    function truncate(text: string | null, max: number): string | null {
        if (text == null)
            return null;
        return text.length <= max ? text : text.substring(0, max - 1) + "…";
    }
}
