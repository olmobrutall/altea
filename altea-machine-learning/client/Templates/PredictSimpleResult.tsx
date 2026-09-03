import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { ButtonBarElement, ButtonsContext, IRenderButtons } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { PredictSimpleResultEntity, PredictorMessage } from "../../data/Predictor";
import { MachineLearningClient } from "../MachineLearningClient";

// Port of Signum.MachineLearning's Templates/PredictSimpleResult.tsx — one saved prediction.
//
// A row of this table is "what the model said about this entity, and what was actually true", written by
// the Full result saver for every training and validation row. So the view is a read-out plus ONE button:
// re-predict about the same subject NOW, which is how one checks whether a retrained model does better.
//
// altea divergence: the button navigates to the predict page (see PredictView's header). Signum's
// `key0/key1/key2` path — re-predicting a GROUPED main query from its stored keys — is not needed here,
// because the page resolves the row through the predictor's own query from the target lite.

export default function PredictSimpleResult(
    { ctx, ref }: { ctx: TypeContext<PredictSimpleResultEntity>; ref?: React.Ref<IRenderButtons> },
): React.JSX.Element {
    const psr = ctx.value;

    function handleClick(): void {
        MachineLearningClient.navigateToPredict(psr.predictor, psr.target);
    }

    React.useImperativeHandle(ref, () => ({
        renderButtons(_bc: ButtonsContext): ButtonBarElement[] {
            // Only a row that names a target can be re-predicted: a grouped predictor's row is identified
            // by its key columns, and the page addresses a row by entity.
            if (psr.target == null)
                return [];
            return [{
                order: 10000,
                button: (
                    <button className="btn btn-info" onClick={handleClick}>
                        <FontAwesomeIcon icon={["far", "lightbulb"]} />&nbsp;{PredictorMessage.Predict.niceToString()}
                    </button>
                ),
            }];
        },
    }), [psr]);

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.predictor)} />
            <AutoLine ctx={ctx.subCtx(a => a.type)} />
            <EntityLine ctx={ctx.subCtx(a => a.target)} hideIfNull />
            <AutoLine ctx={ctx.subCtx(a => a.key0)} hideIfNull />
            <AutoLine ctx={ctx.subCtx(a => a.key1)} hideIfNull />
            <AutoLine ctx={ctx.subCtx(a => a.key2)} hideIfNull />
            <AutoLine ctx={ctx.subCtx(a => a.originalValue)} hideIfNull />
            <AutoLine ctx={ctx.subCtx(a => a.predictedValue)} hideIfNull />
            <AutoLine ctx={ctx.subCtx(a => a.originalCategory)} hideIfNull />
            <AutoLine ctx={ctx.subCtx(a => a.predictedCategory)} hideIfNull />
        </div>
    );
}
