import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toInt } from "@altea/altea/data/basics";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import {
    DefaultColumnEncodings, PredictorColumnUsage, PredictorEntity, PredictorEntity_Column,
    PredictorSettingsEmbedded, TensorFlowPredictorAlgorithm,
} from "../data/Predictor";
import {
    NeuralNetworkActivation, NeuralNetworkEvalFunction, NeuralNetworkInitializer, NeuralNetworkSettingsEntity,
    NeuralNetworkSettingsEntity_HiddenLayer, PredictionType, TensorFlowOptimizer,
} from "../data/NeuralNetworkSettings";
import {
    PredictorCodification, PredictorColumnMain, PredictorPredictContext, PredictorTrainingContext,
    type TrainingRow,
} from "../server/PredictorAlgorithm.server";
import { TensorFlowNeuralNetworkPredictor as Engine } from "../server/tensorflow/TensorFlowNeuralNetworkPredictor.server";
import {
    NormalizeMinMaxEncoding, NormalizeZScoreEncoding, OneHotEncoding, SplitWordsEncoding,
} from "../server/tensorflow/Encodings.server";
import { MODEL_FILE_NAME } from "../server/tensorflow/FileModelStore.server";

// The ENGINE suite: the tfjs path, with no database.
//
// This is the part of the port that is a substrate TRANSLATION — Signum runs TensorFlow.NET / Keras, this
// runs TensorFlow.js — so it is the part where behaviour can drift silently. A model that trains without
// error but learns nothing looks exactly like a model that works, until someone trusts its prediction.

/** A fake resolved token, which is all the encodings read off a column. */
function token(typeName: string, subTypeName?: string): QueryToken {
    return { fullKey: () => "probe", type: { typeName, subTypeName } } as unknown as QueryToken;
}

function column(usage: PredictorColumnUsage, encoding: typeof DefaultColumnEncodings.None, tk: QueryToken, index: number): PredictorColumnMain {
    return new PredictorColumnMain(
        PredictorEntity_Column.create({ usage, encoding, order: toInt(index) }), index, tk);
}

function regressionSettings(): NeuralNetworkSettingsEntity {
    return NeuralNetworkSettingsEntity.create({
        predictionType: PredictionType.Regression,
        hiddenLayers: [NeuralNetworkSettingsEntity_HiddenLayer.create({
            size: toInt(8), activation: NeuralNetworkActivation.ReLU,
            initializer: NeuralNetworkInitializer.glorot_uniform_initializer, order: toInt(0),
        })],
        outputActivation: NeuralNetworkActivation.None,
        outputInitializer: NeuralNetworkInitializer.glorot_uniform_initializer,
        optimizer: TensorFlowOptimizer.Adam,
        lossFunction: NeuralNetworkEvalFunction.MeanSquaredError,
        evalErrorFunction: NeuralNetworkEvalFunction.MeanSquaredError,
        learningRate: 0.05, learningEpsilon: 1e-8,
        minibatchSize: toInt(8), numMinibatches: toInt(200), bestResultFromLast: toInt(10),
        saveProgressEvery: toInt(50), saveValidationProgressEvery: toInt(100),
    });
}

describe("machine-learning engine", () => {
    let directory: string;

    before(() => {
        directory = mkdtempSync(join(tmpdir(), "altea-ml-"));
        Engine.predictorDirectory = () => directory;
    });

    test("a backend is available", async () => {
        const backend = await Engine.currentBackend();
        // "cpu" on a plain host, "tensorflow" when the app registered tfjs-node.
        assert.ok(backend === "cpu" || backend === "tensorflow", backend);
    });

    // The whole path in one test, because the steps are only meaningful together: a model that fits but
    // does not persist, or persists but predicts differently after a reload, is not usable.
    test("trains, persists, reloads and predicts", async () => {
        const settings = regressionSettings();
        const predictor = PredictorEntity.create({
            name: "engine test",
            settings: PredictorSettingsEmbedded.create({ testPercentage: 0.2 }),
            algorithm: TensorFlowPredictorAlgorithm.NeuralNetworkGraph,
            algorithmSettings: settings,
        });
        (predictor as { id: unknown }).id = 1;

        const inCol = column(PredictorColumnUsage.Input, DefaultColumnEncodings.None, token("Decimal"), 0);
        const outCol = column(PredictorColumnUsage.Output, DefaultColumnEncodings.None, token("Decimal"), 1);
        const inCod = new PredictorCodification(inCol);
        const outCod = new PredictorCodification(outCol);

        const ctx = new PredictorTrainingContext(predictor, new AbortController().signal);
        ctx.codifications = [inCod, outCod];
        ctx.inputCodifications = [inCod];
        ctx.outputCodifications = [outCod];
        ctx.inputCodificationsByColumn = new Map([[inCol, [inCod]]]);
        ctx.outputCodificationsByColumn = new Map([[outCol, [outCod]]]);

        // y = 2x + 1 — the smallest relationship that distinguishes "learned something" from "returned
        // the mean", which is what a broken loss or a clipped output activation would do.
        const row = (x: number): TrainingRow =>
            ({ entity: null, inputs: Float32Array.from([x]), outputs: Float32Array.from([2 * x + 1]) });
        ctx.training = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(row);
        ctx.validation = [12, 13, 14].map(row);

        await Engine.train(ctx);

        // 200 epochs at saveProgressEvery 5 0 ⇒ 4 rows.
        assert.equal(ctx.epochProgresses.length, 4);
        const lastLoss = ctx.epochProgresses.at(-1)!.lossTraining!;
        assert.ok(lastLoss < 0.05, `expected the loss to converge, got ${lastLoss}`);
        // The FIRST recorded epoch must be worse than the last, or nothing was learned.
        assert.ok(ctx.epochProgresses[0]!.lossTraining! > lastLoss);

        // A validation figure only on the epochs that are a multiple of saveValidationProgressEvery.
        assert.equal(ctx.epochProgresses[0]!.lossValidation, null);
        assert.notEqual(ctx.epochProgresses[1]!.lossValidation, null);

        assert.ok(existsSync(join(directory, MODEL_FILE_NAME)), "the model file was written");
        assert.ok(Engine.isTrainedOnDisk(predictor));

        // Reload from disk — the path a prediction takes months after the training process is gone.
        const pctx = new PredictorPredictContext(predictor, Engine.algorithm, [inCod, outCod]);
        await Engine.loadModel(pctx);
        assert.ok(pctx.model != null);

        const out = await Engine.predict(pctx, {
            predictor, entity: null,
            mainQueryValues: new Map([[inCol.predictorColumn, 20]]),
            subQueryValues: new Map(),
        });
        const predicted = Number(out.mainQueryValues.get(outCol.predictorColumn));
        // Extrapolating past the training range, so a generous band — the point is that it learned the
        // RELATIONSHIP, not that it interpolates.
        assert.ok(Math.abs(predicted - 41) < 4, `expected ~41, got ${predicted}`);
    });

    test("a batch prediction answers one row per input", async () => {
        const settings = regressionSettings();
        const predictor = PredictorEntity.create({
            name: "batch", settings: PredictorSettingsEmbedded.create({ testPercentage: 0 }),
            algorithm: TensorFlowPredictorAlgorithm.NeuralNetworkGraph, algorithmSettings: settings,
        });
        (predictor as { id: unknown }).id = 1;

        const inCol = column(PredictorColumnUsage.Input, DefaultColumnEncodings.None, token("Decimal"), 0);
        const outCol = column(PredictorColumnUsage.Output, DefaultColumnEncodings.None, token("Decimal"), 1);
        const inCod = new PredictorCodification(inCol);
        const outCod = new PredictorCodification(outCol);

        const pctx = new PredictorPredictContext(predictor, Engine.algorithm, [inCod, outCod]);
        await Engine.loadModel(pctx); // the model the previous test saved

        const inputs = [1, 2, 3].map(x => ({
            predictor, entity: null,
            mainQueryValues: new Map([[inCol.predictorColumn, x]]),
            subQueryValues: new Map(),
        }));
        const results = await Engine.predictMultiple(pctx, inputs);
        assert.equal(results.length, 3);
        // Monotonic in x, which is what y = 2x + 1 means.
        const values = results.map(r => Number(r.mainQueryValues.get(outCol.predictorColumn)));
        assert.ok(values[0]! < values[1]! && values[1]! < values[2]!, values.join(", "));
    });

    // ---- the encodings, which are where a value's MEANING is preserved or lost ----------------------

    test("one-hot gives a slot per distinct value and decodes the argmax", () => {
        const enc = new OneHotEncoding();
        const col = column(PredictorColumnUsage.Input, DefaultColumnEncodings.OneHot, token("String"), 0);
        const cods = enc.generateCodifications(["a", "b", "a", null, "c"], col);
        assert.equal(cods.length, 3, "three distinct non-null values");
        cods.forEach((c, i) => c.index = i);

        const v = new Float32Array(3);
        enc.encodeValue("b", col, cods, v, 0);
        assert.deepEqual([...v], [0, 1, 0]);

        // Decoding is the ARGMAX, not the inverse of encoding.
        assert.equal(enc.decodeValue(col, cods, Float32Array.from([0.1, 0.2, 0.9])), "c");

        // An unknown category encodes as all-zeros rather than throwing.
        const u = new Float32Array(3);
        enc.encodeValue("zzz", col, cods, u, 0);
        assert.deepEqual([...u], [0, 0, 0]);
    });

    test("one-hot alternatives come back as probabilities summing to 1", () => {
        const enc = new OneHotEncoding();
        const col = column(PredictorColumnUsage.Output, DefaultColumnEncodings.OneHot, token("String"), 0);
        const cods = enc.generateCodifications(["a", "b", "c"], col);
        cods.forEach((c, i) => c.index = i);

        const alts = enc.decodeValue(col, cods, Float32Array.from([1, 2, 3]), { alternativeCount: 3 }) as
            { probability: number; value: unknown }[];
        assert.equal(alts.length, 3);
        assert.equal(alts[0]!.value, "c", "highest first");
        const sum = alts.reduce((a, x) => a + x.probability, 0);
        assert.ok(Math.abs(sum - 1) < 1e-6, `probabilities should sum to 1, got ${sum}`);
    });

    test("z-score normalizes and round-trips", () => {
        const enc = new NormalizeZScoreEncoding();
        const col = column(PredictorColumnUsage.Input, DefaultColumnEncodings.NormalizeZScore, token("Decimal"), 0);
        const cods = enc.generateCodifications([10, 20, 30], col);
        const c = cods[0]!;
        assert.equal(c.average, 20);
        assert.ok(Math.abs(c.stdDev! - Math.sqrt(200 / 3)) < 1e-9, String(c.stdDev));

        const v = new Float32Array(1);
        enc.encodeValue(20, col, cods, v, 0);
        assert.equal(v[0], 0, "the mean encodes to 0");

        // Decode is the inverse here (one slot, a real scale), unlike one-hot.
        assert.ok(Math.abs(Number(enc.decodeValue(col, cods, Float32Array.from([1]))) - (20 + c.stdDev!)) < 1e-4);
    });

    test("a zero standard deviation encodes to 0 rather than NaN", () => {
        // Every training value identical — Signum divides regardless and yields NaN, which poisons the
        // whole tensor. See the encoding's comment.
        const enc = new NormalizeZScoreEncoding();
        const col = column(PredictorColumnUsage.Input, DefaultColumnEncodings.NormalizeZScore, token("Decimal"), 0);
        const cods = enc.generateCodifications([7, 7, 7], col);
        const v = new Float32Array(1);
        enc.encodeValue(7, col, cods, v, 0);
        assert.equal(v[0], 0);
        assert.ok(!Number.isNaN(v[0]!));
    });

    test("min-max maps the observed range onto 0..1", () => {
        const enc = new NormalizeMinMaxEncoding();
        const col = column(PredictorColumnUsage.Input, DefaultColumnEncodings.NormalizeMinMax, token("Decimal"), 0);
        const cods = enc.generateCodifications([5, 15], col);
        const v = new Float32Array(1);
        enc.encodeValue(10, col, cods, v, 0);
        assert.equal(v[0], 0.5);
    });

    test("an integer token decodes to a whole number", () => {
        // Signum's ReflectionTools.ChangeType — an int column must not predict 3.70000001.
        const enc = new NormalizeMinMaxEncoding();
        const col = column(PredictorColumnUsage.Output, DefaultColumnEncodings.NormalizeMinMax, token("Number", "int"), 0);
        const cods = enc.generateCodifications([0, 10], col);
        const decoded = enc.decodeValue(col, cods, Float32Array.from([0.37]));
        assert.equal(decoded, 4);
        assert.ok(Number.isInteger(decoded as number));
    });

    test("split-words is a case-insensitive bag of words", () => {
        const enc = new SplitWordsEncoding();
        const col = column(PredictorColumnUsage.Input, DefaultColumnEncodings.SplitWords, token("String"), 0);
        const cods = enc.generateCodifications(["Chai Tea", "chai, coffee"], col);
        // chai / tea / coffee — "Chai" and "chai" are ONE word (halving the evidence otherwise).
        assert.equal(cods.length, 3, cods.map(c => String(c.isValue)).join(","));
        cods.forEach((c, i) => c.index = i);

        const v = new Float32Array(3);
        enc.encodeValue("COFFEE and chai", col, cods, v, 0);
        // Both known words are set, and the unknown "and" is ignored.
        assert.equal([...v].filter(x => x === 1).length, 2);
    });

    test("split-words refuses to be an output", () => {
        const enc = new SplitWordsEncoding();
        const predictor = PredictorEntity.create({
            name: "x", algorithm: TensorFlowPredictorAlgorithm.NeuralNetworkGraph,
            algorithmSettings: regressionSettings(),
        });
        const error = enc.validateEncodingProperty(
            predictor, null, DefaultColumnEncodings.SplitWords, PredictorColumnUsage.Output, token("String"));
        assert.ok(error != null, "an output bag-of-words is not trainable");
    });

    test("cancelling stops the fit", async () => {
        const settings = regressionSettings();
        settings.numMinibatches = toInt(5000);
        const predictor = PredictorEntity.create({
            name: "cancel", settings: PredictorSettingsEmbedded.create({ testPercentage: 0 }),
            algorithm: TensorFlowPredictorAlgorithm.NeuralNetworkGraph, algorithmSettings: settings,
        });
        (predictor as { id: unknown }).id = 2;

        const inCol = column(PredictorColumnUsage.Input, DefaultColumnEncodings.None, token("Decimal"), 0);
        const outCol = column(PredictorColumnUsage.Output, DefaultColumnEncodings.None, token("Decimal"), 1);
        const inCod = new PredictorCodification(inCol);
        const outCod = new PredictorCodification(outCol);

        const controller = new AbortController();
        const ctx = new PredictorTrainingContext(predictor, controller.signal);
        ctx.inputCodifications = [inCod];
        ctx.outputCodifications = [outCod];
        ctx.inputCodificationsByColumn = new Map([[inCol, [inCod]]]);
        ctx.outputCodificationsByColumn = new Map([[outCol, [outCod]]]);
        ctx.training = [0, 1, 2, 3].map(x =>
            ({ entity: null, inputs: Float32Array.from([x]), outputs: Float32Array.from([x]) }));

        setTimeout(() => controller.abort(), 50);

        await assert.rejects(() => Engine.train(ctx), /cancelled/i);
        assert.ok(ctx.epochProgresses.length < 5000, "it stopped well short of the epoch count");
    });

    test("cleanup", () => {
        rmSync(directory, { recursive: true, force: true });
        assert.ok(!existsSync(directory));
    });
});
