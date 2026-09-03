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
import type { EpochProgressRow, TrainingProgress } from "./PredictorAlgorithm.server";
import { PredictorLogic } from "./PredictorLogic.server";
import { PredictorPredictLogic } from "./PredictorPredictLogic.server";
import { TensorFlowNeuralNetworkPredictor } from "./tensorflow/TensorFlowNeuralNetworkPredictor.server";

// Port of Signum.MachineLearning's PredictorController.cs / PredictorServer.cs — the HTTP surface.
//
// Four things the client cannot get from an ordinary query:
//   • the LIVE training progress, which exists only in the training process's memory;
//   • the recorded epoch rows in the compact array form the loss chart reads;
//   • a prediction, which needs the cached model;
//   • which publications a query has, for the "predict about this row" menu.
//
// altea divergences, documented inline:
//  - the wire DTOs are declared HERE and in data/PredictRequest, rather than generated (Signum's
//    TSGenerator emits its `PredictRequestTS`), and their dates/values are plain JSON scalars.
//  - a prediction request names the entity as a LITE; Signum passes a dictionary of main-query key
//    values, which is the same thing for its one caller and less checkable.

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
         * A prediction about one entity, through a named predictor.
         *
         * The response is the predicted OUTPUT columns keyed by their token string — the client knows the
         * predictor's definition, so a token key is what it can render against, and it avoids shipping
         * the whole codification model to the browser.
         */
        ws.post("/api/predict/:predictorId",
            {
                params: CustomType<{ predictorId: string }>(),
                req: CustomType<PredictRequest>(),
                res: CustomType<PredictResponse>(),
            },
            async (req, res) => {
                const body = await req.jsonTyped();
                const predictor = await retrieve(PredictorEntity, PredictorEntity.parseId(req.params.predictorId));

                const ctx = await PredictorPredictLogic.predictContext(predictor);
                const inputs = await PredictorPredictLogic.inputsFromEntity(ctx, body.entity);
                const result = await PredictorPredictLogic.predict(ctx, inputs);

                const outputs: Record<string, unknown> = {};
                for (const [column, value] of result.mainQueryValues)
                    if (column.usage === 1 /* Output */)
                        outputs[column.token.tokenString] = value;

                res.jsonTyped({ entity: body.entity, outputs });
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

/** The body of a prediction request. */
export interface PredictRequest {
    entity: Lite<Entity>;
}

/** Predicted output values, keyed by the output column's token string. */
export interface PredictResponse {
    entity: Lite<Entity>;
    outputs: Record<string, unknown>;
}
