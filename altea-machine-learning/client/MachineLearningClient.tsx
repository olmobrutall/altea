import * as React from "react";
import type { RouteObject } from "react-router";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { Constructor } from "@altea/altea/client/Constructor";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import * as AppContext from "@altea/altea/client/AppContext";
import { Finder } from "@altea/altea/client/Finder";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { toNumberFormat } from "@altea/altea/client/numberFormat";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { toInt } from "@altea/altea/data/basics";
import {
    NeuralNetworkActivation, NeuralNetworkEvalFunction, NeuralNetworkInitializer, NeuralNetworkSettingsEntity,
    PredictionType, TensorFlowOptimizer,
} from "../data/NeuralNetworkSettings";
import {
    PredictorAlgorithmSymbol, PredictorEntity, PredictorEpochProgressEntity, PredictorMainQueryEmbedded,
    PredictorMessage, PredictorOperation, PredictorPublicationSymbol, PredictorResultSaverSymbol,
    PredictorSettingsEmbedded, PredictorSimpleResultSaver, PredictorState, PredictorSubQueryEntity,
    PredictSimpleResultEntity, TensorFlowPredictorAlgorithm,
    type EpochProgressRow, type TrainingProgress,
} from "../data/Predictor";
import type { PredictRequestModel } from "../data/PredictRequest";


// Port of Signum.MachineLearning's PredictorClient.tsx — the client registration.
// See port/MachineLearning.md.
//
// altea divergences, documented inline:
//  - `Navigator.addSettings(new EntitySettings(...))` → `cb.configure(X).withView(...)`, altea's fluent
//    client builder.
//  - the four CSV / TSV / TensorFlow-projector quick links are NOT ported: they hang off Signum's
//    `api/predictor/csv|tsv|tsvMetadata` endpoints, which export the CODIFIED training matrix for use in
//    an external tool. That is a genuinely separate feature (a matrix serializer plus three routes), and
//    the projector link is a bare `window.open` of a public site. `PredictorMessage` keeps their labels.
//  - `registerInitializer(algorithm, …)` is the per-algorithm default-settings hook; kept, because
//    it is what makes picking an algorithm fill in usable defaults rather than an empty settings row.
//  - `registerResultRenderer(saver, …)` likewise — how a result saver contributes its own view to the
//    predictor's Results tab (the shipped `Full` saver contributes the chart link).
//  - a prediction is a PAGE, not Signum's modal (see Templates/PredictView), so `predict(...)` becomes
//    `navigateToPredict(...)`.

export namespace MachineLearningClient {

    /** How a chosen algorithm seeds its own settings. */
    const initializers = new Map<string, (predictor: PredictorEntity) => void>();

    export function registerInitializer(
        algorithm: PredictorAlgorithmSymbol, initializer: (predictor: PredictorEntity) => void,
    ): void {
        initializers.set(algorithm.key, initializer);
    }

    /** Called by the designer when the algorithm changes. */
    export function initializeAlgorithm(predictor: PredictorEntity): void {
        initializers.get(predictor.algorithm?.key ?? "")?.(predictor);
    }

    /** A result saver's own view on the Results tab. */
    const resultRenderers = new Map<string, (ctx: TypeContext<PredictorEntity>) => React.ReactNode>();

    export function registerResultRenderer(
        saver: PredictorResultSaverSymbol, renderer: (ctx: TypeContext<PredictorEntity>) => React.ReactNode,
    ): void {
        resultRenderers.set(saver.key, renderer);
    }

    export function getResultRendered(ctx: TypeContext<PredictorEntity>): React.ReactNode {
        const saver = ctx.value.resultSaver;
        return saver == null ? null : resultRenderers.get(saver.key)?.(ctx) ?? null;
    }

    /**
     * Open a prediction, as a NAVIGATION rather than a modal.
     *
     * The entity rides as a lite KEY, which is what survives a url (see Templates/PredictPage).
     */
    export function navigateToPredict(
        predictor: Lite<PredictorEntity>, entity?: Lite<Entity> | null,
    ): void {
        const suffix = entity == null ? "" : `?entity=${encodeURIComponent(entity.key())}`;
        AppContext.navigate(`/machineLearning/predict/${predictor.id}${suffix}`);
    }

    export function start(cb: ClientBuilder, routes: RouteObject[]): void {
        cb.configure(PredictorEntity)
            .withView(() => import("./Templates/Predictor"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.algorithm),
                    token(a => a.state),
                    token(a => a.publication),
                ],
            }));

        cb.configure(PredictorSubQueryEntity).withView(() => import("./Templates/PredictorSubQuery"));
        cb.configure(NeuralNetworkSettingsEntity).withView(() => import("./Templates/NeuralNetworkSettings"));
        cb.configure(PredictSimpleResultEntity)
            .withView(() => import("./Templates/PredictSimpleResult"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.target),
                    token(a => a.type),
                    token(a => a.originalCategory),
                    token(a => a.predictedCategory),
                    token(a => a.originalValue),
                    token(a => a.predictedValue),
                ],
            }));

        cb.configure(PredictorEpochProgressEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.epoch),
                    token(a => a.trainingExamples),
                    token(a => a.lossTraining),
                    token(a => a.accuracyTraining),
                    token(a => a.lossValidation),
                    token(a => a.accuracyValidation),
                ],
            }));

        // Four numeric cell formatters. The COLOURS are the point: training and validation of the
        // same metric are a light/dark pair, so a glance at the grid shows the two diverging — which is
        // what overfitting looks like.
        registerLossFormatter("lossTraining", "#1A5276");
        registerLossFormatter("accuracyTraining", "#5DADE2");
        registerLossFormatter("lossValidation", "#7B241C");
        registerLossFormatter("accuracyValidation", "#D98880");

        // The training operations are all hidden unless they can run — a Draft predictor should not show
        // "Stop training".
        Operations.addSettings(
            new EntityOperationSettings(PredictorOperation.Train, { hideOnCanExecute: true }),
            new EntityOperationSettings(PredictorOperation.StopTraining, { hideOnCanExecute: true }),
            new EntityOperationSettings(PredictorOperation.CancelTraining, { hideOnCanExecute: true }),
            new EntityOperationSettings(PredictorOperation.Untrain, {
                hideOnCanExecute: true,
                // Untraining a PUBLISHED predictor takes the live model away from whatever depends on it,
                // so it asks first.
                confirmMessage: eoc => eoc.entity.publication != null
                    ? PredictorMessage.PredictorIsPublishedUntrainAnyway.niceToString() : undefined,
            }),
            new EntityOperationSettings(PredictorOperation.Publish, { hideOnCanExecute: true }),
            new EntityOperationSettings(PredictorOperation.AfterPublishProcess, { hideOnCanExecute: true, group: null }),
        );

        routes.push({
            path: "/machineLearning/predict/:predictorId",
            element: <ImportComponent onImport={() => import("./Templates/PredictPage")} />,
        });

        // A new predictor needs its two embedded rows, or
        // the designer opens with nothing to bind its lines to.
        Constructor.registerConstructor(PredictorEntity, props => PredictorEntity.create({
            mainQuery: PredictorMainQueryEmbedded.create({}),
            settings: PredictorSettingsEmbedded.create({}),
            state: PredictorState.Draft,
            ...props,
        }));

        // The one algorithm the module ships, with Signum's own defaults — a REGRESSION with no hidden
        // layer, which is the configuration most likely to train at all on a first attempt.
        registerInitializer(TensorFlowPredictorAlgorithm.NeuralNetworkGraph, p => {
            p.algorithmSettings = NeuralNetworkSettingsEntity.create({
                predictionType: PredictionType.Regression,
                lossFunction: NeuralNetworkEvalFunction.MeanSquaredError,
                evalErrorFunction: NeuralNetworkEvalFunction.MeanAbsoluteError,
                optimizer: TensorFlowOptimizer.Adam,
                learningRate: 0.01,
                learningEpsilon: 1e-8,
                minibatchSize: toInt(100),
                numMinibatches: toInt(100),
                bestResultFromLast: toInt(10),
                saveProgressEvery: toInt(5),
                saveValidationProgressEvery: toInt(10),
                outputActivation: NeuralNetworkActivation.None,
                outputInitializer: NeuralNetworkInitializer.glorot_uniform_initializer,
                hiddenLayers: [],
            }) as never;
        });

        // The `Full` saver writes a row per prediction, so it has a picture to offer — see the button.
        registerResultRenderer(PredictorSimpleResultSaver.Full, ctx =>
            <ImportComponent onImport={() => import("./Templates/SimpleResultButton")} componentProps={{ ctx }} />);

        // "Predict about this row" — offered on a trained predictor.
        QuickLinkClient.registerQuickLink(PredictorEntity, new QuickLinkAction(
            "Predict", () => PredictorMessage.Predict.niceToString(),
            ctx => Promise.resolve(`/machineLearning/predict/${ctx.lite.id}`)));
    }

    function registerLossFormatter(member: string, color: string): void {
        const format = toNumberFormat("0.000");
        Finder.registerPropertyFormatter(
            PropertyRoute.root(PredictorEpochProgressEntity).addMember(member),
            new Finder.CellFormatter(
                (cell: unknown) => cell == null ? "" :
                    <span style={{ color }}>{format.format(cell as number)}</span>,
                false, "numeric-cell"));
    }

    export namespace API {
        /** The LIVE progress of a run in flight. */
        export function trainingProgress(predictor: Lite<PredictorEntity>): Promise<TrainingProgress> {
            return ajaxGet({ url: `/api/predictor/trainingProgress/${predictor.id}`, cache: "no-cache" });
        }

        /** The PERSISTED epoch rows of a finished run. */
        export function epochProgress(predictor: Lite<PredictorEntity>): Promise<EpochProgressRow[]> {
            return ajaxGet({ url: `/api/predictor/epochProgress/${predictor.id}` });
        }

        /** Which publications a query has trained predictors for. */
        export function publications(queryKey: string): Promise<PredictorPublicationSymbol[]> {
            return ajaxGet({ url: `/api/predict/publications/${queryKey}` });
        }

        /** OPEN an interactive prediction — about `entity`, or empty for a what-if. */
        export function getPredict(
            predictor: Lite<PredictorEntity>, entity: Lite<Entity> | null,
        ): Promise<PredictRequestModel> {
            return ajaxPost({ url: `/api/predict/get/${predictor.id}` }, { entity });
        }

        /** RE-predict from an edited model. Abortable: an edit while one is in flight supersedes it. */
        export function updatePredict(
            request: PredictRequestModel, signal?: AbortSignal,
        ): Promise<PredictRequestModel> {
            return ajaxPost({ url: "/api/predict/update", signal }, request);
        }

        /** Which tfjs backend the server is on — shown in the designer (see the engine's header). */
        export function backend(): Promise<{ backend: string; native: boolean }> {
            return ajaxGet({ url: "/api/predictor/backend" });
        }
    }
}
