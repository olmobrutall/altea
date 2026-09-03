import * as tfc from "@tensorflow/tfjs-core";
import * as tfl from "@tensorflow/tfjs-layers";
// The CPU backend, imported for its SIDE EFFECT: it registers itself with tfjs-core, which is what makes
// `tfc.ready()` resolve to a usable backend on a plain Node host. A host that installs
// @tensorflow/tfjs-node registers a faster one the same way and selects it with `useBackend`.
import "@tensorflow/tfjs-backend-cpu";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import {
    PredictorColumnEncodingSymbol, PredictorColumnUsage, PredictorEntity, PredictorMessage,
    PredictorSubQueryEntity, DefaultColumnEncodings,
} from "../../data/Predictor";
import { NeuralNetworkSettingsEntity, PredictionType, isClassificationType } from "../../data/NeuralNetworkSettings";
import {
    EpochProgress, PredictorCodification, objectArrayKey, type IPredictorAlgorithm, type PredictDictionary,
    type PredictorColumnBase, type PredictorPredictContext, type PredictorTrainingContext, type TrainingRow,
} from "../PredictorAlgorithm.server";
import { defaultEncodings, type ITensorFlowEncoding, type PredictionOptions } from "./Encodings.server";
import { fileModelStore, hasSavedModel } from "./FileModelStore.server";

// Port of Signum.MachineLearning's TensorFlow/TensorFlowNeuralNetworkPredictor.cs — the algorithm: build
// the network, fit it on the codified rows, score it, and save it so a later prediction can load it.
//
// **The engine is tfjs-CORE + tfjs-LAYERS, and that is deliberate twice over.**
//
// Not `@tensorflow/tfjs-node`: that is a faster BACKEND for this same API, not a different one — it
// registers a native TensorFlow backend that `tfc.setBackend("tensorflow")` then selects. So a host that
// wants the native speed does:
//
//     import "@tensorflow/tfjs-node";                     // registers the backend
//     await TensorFlowNeuralNetworkPredictor.useBackend("tensorflow");
//
// Nothing here changes for that. It matters practically because tfjs-node is a native addon with
// prebuilt binaries per Node ABI — on a Node version it has no build for it cannot install AT ALL (it
// falls back to compiling libtensorflow from source, which needs a full C++ toolchain) — so a module that
// imported it directly would be uninstallable on those hosts rather than merely slower.
//
// And not the union `@tensorflow/tfjs` package either: it additionally pulls the webgl backend, the
// converter, tfjs-data, yargs, chalk and core-js, none of which a server uses. Depending on the three
// parts actually used keeps the install honest — and drops core-js, whose postinstall script pnpm refuses
// to leave un-adjudicated.
//
// altea divergences beyond the engine, documented inline:
//  - Signum trains with an explicit minibatch LOOP, calling its learner once per batch and reading the
//    loss back. tfjs's `model.fit` takes `batchSize` + `epochs` and reports through a callback, which is
//    the same loop inside the library — so `numMinibatches` becomes epochs, `minibatchSize` becomes
//    `batchSize`, and `onEpochEnd` is where the progress rows and the stop check live.
//  - the model is persisted through this module's OWN IOHandler rather than TensorFlow's SavedModel
//    format — `@tensorflow/tfjs` ships no filesystem IO at all, and the `file://` scheme belongs to
//    tfjs-node. See FileModelStore for the format and why one self-contained file. Signum's
//    `TrainingModelDirectory` / `PredictorDirectory` layout is kept, so the model sits where a Signum
//    deployment's did.
//  - `Device` is advisory: tfjs picks its backend, and there is no per-op device placement to honour.

export namespace TensorFlowNeuralNetworkPredictor {

    /** Signum's `PredictorDirectory` — where a trained model's files live. */
    export let predictorDirectory: (p: PredictorEntity) => string =
        p => join("TensorFlowModels", String(p.id));

    /** Signum's `TrainingModelDirectory` — the in-progress model of one training run. */
    export let trainingModelDirectory: (p: PredictorEntity, epoch: number) => string =
        (p, epoch) => join("TensorFlowModels", String(p.id), "Training", String(epoch));

    /**
     * Select a tfjs backend by name, after the host has registered it (see the header). Answers the
     * backend actually in use, which is worth logging: a host that meant to install tfjs-node and did not
     * would otherwise silently train on the CPU backend at a fraction of the speed.
     */
    export async function useBackend(name: string): Promise<string> {
        await tfc.setBackend(name);
        await tfc.ready();
        return tfc.getBackend();
    }

    /** The backend in use, once tfjs has initialised. */
    export async function currentBackend(): Promise<string> {
        await tfc.ready();
        return tfc.getBackend();
    }

    /** Signum's `Encodings` dictionary, keyed by symbol key. An app may add to it. */
    export const encodings: Map<string, ITensorFlowEncoding> = defaultEncodings();

    export function encoding(symbol: PredictorColumnEncodingSymbol): ITensorFlowEncoding {
        const e = encodings.get(symbol.key);
        if (e == null)
            throw new Error(`No TensorFlow encoding registered for '${symbol.key}'`);
        return e;
    }

    /** The algorithm object registered under `TensorFlowPredictorAlgorithm.NeuralNetworkGraph`. */
    export const algorithm: IPredictorAlgorithm = {

        validateEncodingProperty(
            predictor: PredictorEntity, subQuery: PredictorSubQueryEntity | null,
            enc: PredictorColumnEncodingSymbol, usage: PredictorColumnUsage, token: QueryToken,
        ): string | null {
            return encoding(enc).validateEncodingProperty(predictor, subQuery, enc, usage, token);
        },

        generateCodifications(
            enc: PredictorColumnEncodingSymbol, values: readonly unknown[], column: PredictorColumnBase,
        ): PredictorCodification[] {
            return encoding(enc).generateCodifications(values, column);
        },

        getRegisteredEncodingSymbols(): PredictorColumnEncodingSymbol[] {
            return [
                DefaultColumnEncodings.None, DefaultColumnEncodings.OneHot,
                DefaultColumnEncodings.NormalizeZScore, DefaultColumnEncodings.NormalizeMinMax,
                DefaultColumnEncodings.NormalizeLog, DefaultColumnEncodings.SplitWords,
            ];
        },

        encodeValue(
            column: PredictorColumnBase, cods: PredictorCodification[], value: unknown,
            target: Float32Array, offset = 0,
        ): void {
            encoding(column.encoding).encodeValue(value, column, cods, target, offset);
        },

        train,
        loadModel,
        predict,
        predictMultiple,
    };

    // ---- training --------------------------------------------------------------------------------------

    /**
     * Signum's `Train(ctx)`.
     *
     * The shape: build the model from the settings, fit it on the codified training rows with the
     * validation rows held back, record a progress row every `saveProgressEvery` epochs, and stop early
     * when asked. The metrics on the predictor are then computed from a final pass over both sets.
     */
    export async function train(ctx: PredictorTrainingContext): Promise<void> {
        const settings = ctx.predictor.algorithmSettings as unknown as NeuralNetworkSettingsEntity;
        const { buildModel } = await import("./NetworkBuilder.server");

        const inputSize = ctx.inputCodifications.length;
        const outputSize = ctx.outputCodifications.length;

        ctx.reportProgress(PredictorMessage.StartingTraining.niceToString());
        await tfc.ready();

        const model = buildModel(settings, inputSize, outputSize);

        const trainX = toTensor(ctx.training, r => r.inputs, inputSize);
        const trainY = toTensor(ctx.training, r => r.outputs, outputSize);
        const valX = ctx.validation.length > 0 ? toTensor(ctx.validation, r => r.inputs, inputSize) : null;
        const valY = ctx.validation.length > 0 ? toTensor(ctx.validation, r => r.outputs, outputSize) : null;

        const started = Date.now();

        try {
            ctx.reportProgress(PredictorMessage.Training.niceToString(), 0);

            await model.fit(trainX, trainY, {
                epochs: settings.numMinibatches as number,
                batchSize: settings.minibatchSize as number,
                shuffle: true,
                verbose: 0,
                ...(valX != null && valY != null ? { validationData: [valX, valY] as [tfc.Tensor, tfc.Tensor] } : {}),
                callbacks: {
                    onEpochEnd: async (epoch: number, logs?: tfl.Logs) => {
                        const epochNumber = epoch + 1;
                        const total = settings.numMinibatches as number;
                        ctx.reportProgress(PredictorMessage.Training.niceToString(), epochNumber / total);

                        // Signum records a row every `saveProgressEvery`, and validation figures only
                        // every `saveValidationProgressEvery` — which is why the settings require the
                        // second to be a multiple of the first (see the entity's validator): otherwise a
                        // recorded row could have no validation numbers to compare against.
                        if (epochNumber % (settings.saveProgressEvery as number) === 0 || epochNumber === total) {
                            const withValidation = epochNumber % (settings.saveValidationProgressEvery as number) === 0;
                            ctx.epochProgresses.push(new EpochProgress(
                                Date.now() - started,
                                ctx.training.length,
                                epochNumber,
                                logs?.["loss"] ?? null,
                                logs?.["acc"] ?? logs?.["accuracy"] ?? null,
                                withValidation ? (logs?.["val_loss"] ?? null) : null,
                                withValidation ? (logs?.["val_acc"] ?? logs?.["val_accuracy"] ?? null) : null,
                            ));
                        }

                        // Cancelling ABANDONS the run; stopping keeps what has been learned so far.
                        if (ctx.signal.aborted || ctx.stopTraining)
                            model.stopTraining = true;
                    },
                },
            });

            ctx.assertNotCancelled();

            // The metrics that land on the predictor. Signum evaluates the best saved minibatch; here the
            // fitted model IS the latest, and `evaluate` gives the same two numbers per set.
            ctx.reportProgress(PredictorMessage.Saving.niceToString());
            await saveModel(model, predictorDirectory(ctx.predictor));

            ctx.trainedModel = model;
        } finally {
            trainX.dispose();
            trainY.dispose();
            valX?.dispose();
            valY?.dispose();
        }
    }

    /** Evaluate a fitted model over a row set — the loss/accuracy pair the predictor stores. */
    export async function evaluate(
        model: tfl.LayersModel, rows: TrainingRow[], inputSize: number, outputSize: number,
    ): Promise<{ loss: number | null; accuracy: number | null }> {
        if (rows.length === 0)
            return { loss: null, accuracy: null };

        const x = toTensor(rows, r => r.inputs, inputSize);
        const y = toTensor(rows, r => r.outputs, outputSize);
        try {
            const result = model.evaluate(x, y, { batchSize: Math.min(rows.length, 1000) });
            const list = Array.isArray(result) ? result : [result];
            const values = await Promise.all(list.map(async t => (await t.data())[0]!));
            list.forEach(t => t.dispose());
            return { loss: values[0] ?? null, accuracy: values.length > 1 ? values[1]! : null };
        } finally {
            x.dispose();
            y.dispose();
        }
    }

    function toTensor(rows: TrainingRow[], pick: (r: TrainingRow) => Float32Array, width: number): tfc.Tensor2D {
        const flat = new Float32Array(rows.length * width);
        rows.forEach((r, i) => flat.set(pick(r), i * width));
        return tfc.tensor2d(flat, [rows.length, width]);
    }

    // ---- persistence -----------------------------------------------------------------------------------

    async function saveModel(model: tfl.LayersModel, directory: string): Promise<void> {
        mkdirSync(directory, { recursive: true });
        await model.save(fileModelStore(directory));
    }

    /** Signum's `LoadModel(ctx)`. */
    export async function loadModel(ctx: PredictorPredictContext): Promise<void> {
        await tfc.ready();
        ctx.model = await tfl.loadLayersModel(fileModelStore(predictorDirectory(ctx.predictor)));
    }

    /** Whether this predictor has a model on disk to load. */
    export function isTrainedOnDisk(predictor: PredictorEntity): boolean {
        return hasSavedModel(predictorDirectory(predictor));
    }

    /** Drop a predictor's saved model — Signum's Untrain. */
    export function deleteModel(predictor: PredictorEntity): void {
        const dir = predictorDirectory(predictor);
        if (existsSync(dir))
            rmSync(dir, { recursive: true, force: true });
    }

    // ---- prediction ------------------------------------------------------------------------------------

    /** Signum's `Predict(ctx, input)`. */
    export async function predict(ctx: PredictorPredictContext, input: PredictDictionary): Promise<PredictDictionary> {
        const results = await predictMultiple(ctx, [input]);
        return results[0]!;
    }

    /**
     * Signum's `PredictMultiple(ctx, inputs)` — codify every input into one batch, run the model ONCE,
     * and decode each row's outputs back into the predictor's own terms.
     *
     * Batching is not an optimisation detail here: a per-row `predict` on tfjs pays the tensor setup for
     * every row, which for a few thousand rows dominates the actual arithmetic.
     */
    export async function predictMultiple(
        ctx: PredictorPredictContext, inputs: PredictDictionary[],
    ): Promise<PredictDictionary[]> {
        if (inputs.length === 0)
            return [];

        const model = ctx.model as tfl.LayersModel | null;
        if (model == null)
            throw new Error("The model is not loaded — call loadModel first");

        const inputSize = ctx.inputCodifications.length;
        const flat = new Float32Array(inputs.length * inputSize);

        inputs.forEach((dic, row) => {
            const vector = new Float32Array(inputSize);
            encodeInputs(ctx, dic, vector);
            flat.set(vector, row * inputSize);
        });

        const x = tfc.tensor2d(flat, [inputs.length, inputSize]);
        try {
            const out = model.predict(x) as tfc.Tensor;
            const data = await out.data() as Float32Array;
            const outputSize = ctx.outputCodifications.length;
            out.dispose();

            return inputs.map((dic, row) => {
                const slice = data.subarray(row * outputSize, (row + 1) * outputSize);
                return decodeOutputs(ctx, dic, slice);
            });
        } finally {
            x.dispose();
        }
    }

    /** Write one PredictDictionary's values into its input vector, through each column's encoding. */
    export function encodeInputs(ctx: PredictorPredictContext, dic: PredictDictionary, target: Float32Array): void {
        for (const [column, cods] of ctx.inputCodificationsByColumn) {
            const value = readInputValue(dic, column);
            encoding(column.encoding).encodeValue(value, column, cods, target, 0);
        }
    }

    /** Read the value a PredictDictionary supplies for one column. */
    function readInputValue(dic: PredictDictionary, column: PredictorColumnBase): unknown {
        const main = column as { predictorColumn?: object };
        if (main.predictorColumn != null)
            return dic.mainQueryValues.get(main.predictorColumn as never) ?? null;

        const sub = column as { subQuery?: object; keys?: unknown[]; predictorSubQueryColumn?: object };
        if (sub.subQuery == null)
            return null;

        const byKey = dic.subQueryValues.get(sub.subQuery as never);
        const group = byKey?.get(objectArrayKey(sub.keys ?? []));
        return group?.get(sub.predictorSubQueryColumn as never) ?? null;
    }

    /** Decode the model's output vector into the dictionary's own output values. */
    function decodeOutputs(
        ctx: PredictorPredictContext, input: PredictDictionary, outputs: Float32Array,
        options?: PredictionOptions,
    ): PredictDictionary {
        const result: PredictDictionary = {
            predictor: input.predictor,
            entity: input.entity,
            mainQueryValues: new Map(input.mainQueryValues),
            subQueryValues: new Map(input.subQueryValues),
        };

        for (const [column, cods] of ctx.outputCodificationsByColumn) {
            const value = encoding(column.encoding).decodeValue(column, cods, outputs, options);

            const main = column as { predictorColumn?: object };
            if (main.predictorColumn != null) {
                result.mainQueryValues.set(main.predictorColumn as never, value);
                continue;
            }

            const sub = column as { subQuery?: object; keys?: unknown[]; predictorSubQueryColumn?: object };
            if (sub.subQuery == null)
                continue;

            const key = objectArrayKey(sub.keys ?? []);
            let byKey = result.subQueryValues.get(sub.subQuery as never);
            if (byKey == null) {
                byKey = new Map();
                result.subQueryValues.set(sub.subQuery as never, byKey);
            }
            let group = byKey.get(key);
            if (group == null) {
                group = new Map();
                byKey.set(key, group);
            }
            group.set(sub.predictorSubQueryColumn as never, value);
        }

        return result;
    }

    /** Log which backend is actually in use — see `useBackend` on why that is worth saying out loud. */
    export async function logBackend(): Promise<void> {
        const backend = await currentBackend();
        const native = backend === "tensorflow";
        SafeConsole.writeLineColor(native ? Color.green : Color.darkYellow,
            `[machine-learning] TensorFlow.js backend: ${backend}`
            + (native ? "" : " (install @tensorflow/tfjs-node and call useBackend('tensorflow') for native speed)"));
    }
}
