import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import * as AppContext from "@altea/altea/client/AppContext";
import { ChartClient } from "@altea/altea-chart/client/ChartClient";
import {
    DefaultColumnEncodings, PredictSimpleResultEntity, PredictorColumnUsage, PredictorEntity,
} from "../../data/Predictor";

// Port of Signum.MachineLearning's Templates/SimpleResultButton.tsx — the view the `Full` result saver
// contributes to a trained predictor.
//
// It is ONE link, and the choice it makes is the whole point: a classification's saved results are best
// read as a CONFUSION MATRIX (a punchcard of original vs predicted category, sized by count — the
// diagonal is what the model got right), a regression's as a SCATTERPLOT of predicted against original
// (the closer to the diagonal, the better). Signum picks between them by the output column's encoding,
// which is the only thing that distinguishes the two cases, and so does this.
//
// altea divergences: `ChartClient.Encoder.chartPath` takes altea's ChartOptions (a token is a STRING, and
// a chart script is named by its key); the output column's nice name comes off the resolved token, which a
// stored definition carries as `token.token`.

export default function SimpleResultButton(p: { ctx: TypeContext<PredictorEntity> }): React.JSX.Element | null {
    const predictor = p.ctx.value;

    const outputColumns = predictor.columns.filter(c => c.usage === PredictorColumnUsage.Output);
    if (outputColumns.length !== 1)
        // The chart plots ONE output against itself; a multi-output predictor has no such picture.
        return null;

    const outColumn = outputColumns[0]!;
    const isOneHot = outColumn.encoding?.is(DefaultColumnEncodings.OneHot) ?? false;
    const outName = outColumn.token?.token?.niceName() ?? outColumn.token?.tokenString ?? "";

    function chartUrl(): string {
        const filterOptions = [{
            token: PredictSimpleResultEntity.token(e => e.predictor).toString(),
            value: predictor.toLite(),
        }];

        if (isOneHot)
            return ChartClient.Encoder.chartPath({
                queryName: PredictSimpleResultEntity.typeName,
                chartScript: "Punchcard",
                filterOptions,
                columnOptions: [
                    {
                        token: PredictSimpleResultEntity.token(e => e.originalCategory).toString(),
                        displayName: `Original ${outName}`,
                    },
                    {
                        token: PredictSimpleResultEntity.token(e => e.predictedCategory).toString(),
                        displayName: `Predicted ${outName}`,
                    },
                    { token: "Count" },
                ],
            });

        return ChartClient.Encoder.chartPath({
            queryName: PredictSimpleResultEntity.typeName,
            chartScript: "Scatterplot",
            filterOptions,
            columnOptions: [
                { token: PredictSimpleResultEntity.token(e => e.type).toString() },
                {
                    token: PredictSimpleResultEntity.token(e => e.originalValue).toString(),
                    displayName: `Original ${outName}`,
                },
                {
                    token: PredictSimpleResultEntity.token(e => e.predictedValue).toString(),
                    displayName: `Predicted ${outName}`,
                },
            ],
        });
    }

    return (
        <div>
            <LinkButton title={undefined} className="btn btn-sm btn-info"
                onClick={() => window.open(AppContext.toAbsoluteUrl(chartUrl()))}>
                <FontAwesomeIcon icon="chart-line" />&nbsp;
                {isOneHot ? "Confusion matrix" : "Regression scatterplot"}
            </LinkButton>
        </div>
    );
}
