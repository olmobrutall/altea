import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { toInt } from "@altea/altea/data/basics";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { Lite as LiteClass } from "@altea/altea/data/lite";
import {
    PredictorEntity, PredictorEpochProgressEntity, PredictorPublicationSymbol, PredictorState,
} from "../data/Predictor";
import type { PredictRequestModel } from "../data/PredictRequest";
import type { EpochProgressRow, TrainingProgress } from "./PredictorAlgorithm";
import { PredictRequestBuilder } from "./PredictRequestBuilder";
import { PredictorLogic } from "./PredictorLogic";
import { PredictorPredictLogic } from "./PredictorPredictLogic";
import { TensorFlowNeuralNetworkPredictor } from "./tensorflow/TensorFlowNeuralNetworkPredictor";

// Port of Signum.MachineLearning's PredictorController.cs / PredictorServer.cs — the HTTP surface.
//
// Four things the client cannot get from an ordinary query:
//   • the LIVE training progress, which exists only in the training process's memory;
//   • the recorded epoch rows in the compact array form the loss chart reads;
//   • a prediction, which needs the cached model;
//   • which publications a query has, for the "predict about this row" menu.
//
// altea divergences, documented inline:
//  - the wire DTOs are declared in data/PredictRequest rather than generated (Signum's TSGenerator emits
//    its `PredictRequestTS`), and their dates/values are plain JSON scalars.
//  - OPENING a prediction names the entity as a LITE; Signum posts a dictionary of main-query key values.
//    Same thing for the one caller that exists (a row picked in a search), and checkable — with the
//    grouped case reached the same way, since the predictor's own query is what resolves the row.

export namespace PredictorServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        // The live progress of a run — polled while the predictor is Training.
        ws.get("/api/predictor/trainingProgress/:id",
            { params: CustomType<{ id: string }>(), res: CustomType<TrainingProgress>() },
            async (req, res) => {
                const predictor = await retrieve(PredictorEntity, PredictorEntity.parseId(req.params.id));
                res.jsonTyped(PredictorLogic.trainingProgress(predictor));
            });

        // The PERSISTED epoch rows, for the loss chart of a finished run. Signum answers
        // `List<object?[]>`; the same compact rows here (see EpochProgressRow on why an array).
        ws.get("/api/predictor/epochProgress/:id",
            { params: CustomType<{ id: string }>(), res: CustomType<EpochProgressRow[]>() },
            async (req, res) => {
                const id = PredictorEntity.parseId(req.params.id);
                const rows = await ExecutionMode.global(async () =>
                    await table(PredictorEpochProgressEntity)
                        .filter(e => e.predictor.id == id)
                        .orderBy(e => e.epoch)
                        .toArray() as PredictorEpochProgressEntity[]);

                res.jsonTyped(rows.map((e): EpochProgressRow => [
                    e.ellapsed as unknown as number,
                    e.trainingExamples as unknown as number,
                    e.epoch as unknown as number,
                    e.lossTraining, e.accuracyTraining, e.lossValidation, e.accuracyValidation,
                ]));
            });

        // Which publications exist for a query — the "predict about this row" menu reads it to decide
        // whether to offer anything at all.
        ws.get("/api/predict/publications/:queryKey",
            { params: CustomType<{ queryKey: string }>(), res: CustomType<PredictorPublicationSymbol[]>() },
            async (req, res) => {
                const queryKey = req.params.queryKey;
                const predictors = await ExecutionMode.global(async () =>
                    await table(PredictorEntity)
                        .filter(p => p.state == PredictorState.Trained && p.mainQuery.query.key == queryKey)
                        .toArray() as PredictorEntity[]);

                const publications = predictors
                    .map(p => p.publication)
                    .filter((s): s is PredictorPublicationSymbol => s != null);

                // Distinct by key — several predictors may target the same publication over time, and the
                // menu wants one entry per purpose.
                const seen = new Set<string>();
                res.jsonTyped(publications.filter(s => seen.has(s.key) ? false : (seen.add(s.key), true)));
            });

        /**
         * Signum's `GetPredict` — OPEN an interactive prediction.
         *
         * With an entity, the predictor's own queries are run for that one row, so the page opens showing
         * the real inputs and both answers (what the model says, what actually happened). Without one it
         * opens empty, for a what-if.
         */
        ws.post("/api/predict/get/:predictorId",
            {
                params: CustomType<{ predictorId: string }>(),
                req: CustomType<{ entity: Lite<Entity> | null }>(),
                res: CustomType<PredictRequestModel>(),
            },
            async (req, res) => {
                const body = await req.jsonTyped();
                const predictor = await retrieve(PredictorEntity, PredictorEntity.parseId(req.params.predictorId));
                const ctx = await PredictorPredictLogic.predictContext(predictor);

                const fromEntity = body.entity == null ? null
                    : await PredictorPredictLogic.inputsFromEntity(ctx, body.entity);

                const inputs = fromEntity ?? PredictorPredictLogic.inputsEmpty(ctx);
                const predicted = await PredictorPredictLogic.predict(ctx, inputs);

                res.jsonTyped(PredictRequestBuilder.createPredictModel(ctx, inputs, fromEntity, predicted));
            });

        /**
         * Signum's `UpdatePredict` — RE-predict from the model the page posted back.
         *
         * This is what makes the page interactive: edit an input, get a new prediction, with the original
         * values (and the inputs themselves) carried through untouched.
         */
        ws.post("/api/predict/update",
            { req: CustomType<PredictRequestModel>(), res: CustomType<PredictRequestModel>() },
            async (req, res) => {
                const request = await req.jsonTyped();
                const ctx = await PredictorPredictLogic.predictContext(request.predictor);

                const inputs = PredictRequestBuilder.inputsFromRequest(ctx, request);
                if (request.alternativesCount != null)
                    inputs.options = { alternativeCount: request.alternativesCount };

                PredictRequestBuilder.setOutput(request, await PredictorPredictLogic.predict(ctx, inputs));
                res.jsonTyped(request);
            });

        // Which tfjs backend the server is actually using — see the predictor's header on why that is
        // worth surfacing rather than assuming.
        ws.get("/api/predictor/backend",
            { res: CustomType<{ backend: string; native: boolean }>() },
            async (_req, res) => {
                const backend = await TensorFlowNeuralNetworkPredictor.currentBackend();
                res.jsonTyped({ backend, native: backend === "tensorflow" });
            });
    }
}

