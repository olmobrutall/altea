import * as React from "react";
import { useLocation, useParams } from "react-router";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { NeuralNetworkSettingsEntity, PredictionType } from "../../data/NeuralNetworkSettings";
import { PredictorEntity, PredictorMessage } from "../../data/Predictor";
import { MachineLearningClient } from "../MachineLearningClient";
import PredictView from "./PredictView";

// The predict PAGE — altea's entry point for Signum's PredictModal (see PredictView's header on why a
// page). `/machineLearning/predict/:predictorId?entity=<liteKey>`:
//
//  - with an `entity`, the prediction is about that row, so both the model's answer and the real outcome
//    are shown;
//  - without one, the prediction opens EMPTY, which is the what-if case (fill the inputs by hand).
//
// The entity rides in the query string as a lite KEY ("Order;12"), the same encoding altea uses wherever
// a lite is a url parameter — a JSON lite would not survive a url, and the key is what `Lite.parse` reads.

export default function PredictPage(): React.JSX.Element {
    const { predictorId } = useParams<{ predictorId: string }>();
    const query = new URLSearchParams(useLocation().search);
    const entityKey = query.get("entity");

    const data = useAPI(async () => {
        if (predictorId == null)
            return undefined;

        const lite = PredictorEntity.newLite(PredictorEntity.parseId(predictorId));
        const entity = entityKey == null ? null : Lite.parse(entityKey) as Lite<Entity>;

        // The predictor itself, only so the page knows whether to offer the alternatives checkbox — the
        // prediction is built entirely on the server.
        const [predictor, predict] = await Promise.all([
            Navigator.API.fetch(lite),
            MachineLearningClient.API.getPredict(lite, entity),
        ]);

        return { predictor, predict, entity };
    }, [predictorId, entityKey]);

    if (data == null)
        return <div className="container mt-3">…</div>;

    const settings = data.predictor.algorithmSettings;
    const isClassification = settings instanceof NeuralNetworkSettingsEntity
        && settings.predictionType === PredictionType.Classification;

    return (
        <div className="container mt-3">
            <h2 className="h4">{PredictorMessage.Predict.niceToString()}</h2>
            {data.entity && <p className="text-muted">
                <a href={Navigator.navigateRoute(data.entity)} target="_blank" rel="noreferrer">
                    {data.entity.toString()}
                </a>
            </p>}
            <PredictView initialPredict={data.predict} entity={data.entity} isClassification={isClassification} />
        </div>
    );
}
