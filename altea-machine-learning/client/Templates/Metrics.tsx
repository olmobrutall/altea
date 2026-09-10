import * as React from "react";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import {
    PredictorClassificationMetricsEmbedded, PredictorMetricsEmbedded, PredictorRegressionMetricsEmbedded,
} from "../../data/Predictor";

// Port of Signum.MachineLearning's Templates/PredictorMetrics.tsx, PredictorClassificationMetrics.tsx and
// PredictorRegressionMetrics.tsx — the three read-only score panels, kept in one file because they are
// the same component three times over with a different member list.
//
// All three are READ-ONLY: a metric is what the training measured, not something to edit. Signum achieves
// that by rendering plain ValueLines inside a disabled context; altea's TypeContext carries `readOnly`,
// so `ctx.subCtx({ readOnly: true })` is the whole story.

/** The loss / accuracy pair, shown side by side. */
export function MetricsPanel(p: { ctx: TypeContext<PredictorMetricsEmbedded>; title: string }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ readOnly: true, formGroupStyle: "SrOnly" });

    return (
        <div className="col-sm-6">
            <fieldset>
                <legend>{p.title}</legend>
                <div className="row">
                    <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(a => a.loss)} /></div>
                    <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(a => a.accuracy)} /></div>
                </div>
            </fieldset>
        </div>
    );
}

/**
 * How many the model got wrong.
 *
 * The MISS RATE is the number to read: a count of misses means nothing without the total, which is why
 * the three are shown together rather than the rate alone.
 */
export function ClassificationMetricsPanel(
    p: { ctx: TypeContext<PredictorClassificationMetricsEmbedded>; title: string },
): React.JSX.Element {
    const ctx = p.ctx.subCtx({ readOnly: true });

    return (
        <div className="col-sm-6">
            <fieldset>
                <legend>{p.title}</legend>
                <AutoLine ctx={ctx.subCtx(a => a.totalCount)} />
                <AutoLine ctx={ctx.subCtx(a => a.missCount)} />
                <AutoLine ctx={ctx.subCtx(a => a.missRate)} />
            </fieldset>
        </div>
    );
}

/**
 * Six numbers, because they answer different questions.
 *
 * The mean error shows BIAS (is the model high or low on average, which the absolute errors hide); the
 * absolute and squared ones show magnitude, and the squared one punishes outliers; the percentage pair
 * puts both in scale-free terms, so a model over prices and a model over counts can be compared.
 */
export function RegressionMetricsPanel(
    p: { ctx: TypeContext<PredictorRegressionMetricsEmbedded>; title: string },
): React.JSX.Element {
    const ctx = p.ctx.subCtx({ readOnly: true });

    return (
        <div className="col-sm-6">
            <fieldset>
                <legend>{p.title}</legend>
                <AutoLine ctx={ctx.subCtx(a => a.meanError)} />
                <AutoLine ctx={ctx.subCtx(a => a.meanSquaredError)} />
                <AutoLine ctx={ctx.subCtx(a => a.meanAbsoluteError)} />
                <AutoLine ctx={ctx.subCtx(a => a.rootMeanSquareError)} />
                <AutoLine ctx={ctx.subCtx(a => a.meanPercentageError)} />
                <AutoLine ctx={ctx.subCtx(a => a.meanAbsolutePercentageError)} />
            </fieldset>
        </div>
    );
}
