import * as React from "react";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { StyleContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { FormControlReadonly } from "@altea/altea/client/Lines/FormControlReadonly";
import SearchValue from "@altea/altea/client/SearchControl/SearchValue";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Enum } from "@altea/altea/data/enum";
import {
    NeuralNetworkEvalFunction, NeuralNetworkSettingsEntity, PredictionType, TensorFlowOptimizer,
    isClassificationType,
} from "../../data/NeuralNetworkSettings";
import {
    PredictorCodificationEntity, PredictorColumnUsage, PredictorEntity, PredictorState,
} from "../../data/Predictor";

// Port of Signum.MachineLearning's Templates/NeuralNetworkSettings.tsx — the network designer.
//
// The layout is Signum's, and it is deliberate: the page reads top to bottom as the network is SHAPED —
// how many inputs there are (a count, not an editor: the codifications decide it), then the hidden
// layers, then the output layer, then the training hyper-parameters below a rule. The two counts are not
// editable for the same reason: they are derived from the predictor's columns, and showing them here is
// what makes a layer size look reasonable or absurd.
//
// altea divergences, documented inline:
//  - `PredictorColumnUsage.niceToString(u)` becomes `Enum.niceName(PredictorColumnUsage, u)` — altea's
//    fluent display-name API.
//  - an enum FIELD holds its ORDINAL, so the prediction-type handler assigns enum MEMBERS rather than
//    Signum's string literals.
//  - Signum's `getHelpBlock` returns "" for both optimizers and THROWS for anything else — so it is a
//    switch that can only ever produce an empty string or an exception. Dropped; there is no help text to
//    show, and an unknown optimizer is a schema question, not a rendering one. Its `LabelWithHelp`
//    component is dropped with it (nothing in Signum uses it either).
//  - `AutoLine` reads the member's type, so the enum lines need no `optionItems`.

export default function NeuralNetworkSettings(p: { ctx: TypeContext<NeuralNetworkSettingsEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const predictor = ctx.findParent(PredictorEntity);

    /**
     * Signum's `handlePredictionTypeChanged` — a classification and a regression need DIFFERENT losses,
     * and picking one by hand is the mistake this avoids: a cross-entropy loss over a continuous output
     * trains to nothing, and a squared error over one-hot slots trains to the mean.
     */
    function handlePredictionTypeChanged(): void {
        const nn = ctx.value;
        if (isClassificationType(nn.predictionType)) {
            nn.lossFunction = NeuralNetworkEvalFunction.softmax_cross_entropy_with_logits;
            nn.evalErrorFunction = NeuralNetworkEvalFunction.ClassificationError;
        } else {
            nn.lossFunction = NeuralNetworkEvalFunction.MeanSquaredError;
            nn.evalErrorFunction = NeuralNetworkEvalFunction.MeanSquaredError;
        }
        forceUpdate();
    }

    // Signum's comment, kept verbatim because it is the provenance of these numbers: "Values found
    // letting a NN work for a night learning y = sin(x * 5), no idea if they work ok for other cases".
    function handleOptimizerChange(): void {
        const nns = ctx.value;
        switch (nns.optimizer) {
            case TensorFlowOptimizer.Adam:
            case TensorFlowOptimizer.GradientDescentOptimizer:
                nns.learningRate = 0.01;
                break;
            default:
        }
        forceUpdate();
    }

    /**
     * Signum's `renderCount` — how many slots this usage has, as a link to the codifications.
     *
     * Before training there is no answer (the codifications are assigned BY the training), which is what
     * the "?" is: Signum's same two branches.
     */
    function renderCount(sctx: StyleContext, usage: PredictorColumnUsage): React.JSX.Element {
        return (
            <FormGroup ctx={sctx} label={`${Enum.niceName(PredictorColumnUsage, usage)} columns`}>
                {inputId => predictor.state !== PredictorState.Trained
                    ? <FormControlReadonly id={inputId} ctx={sctx}>?</FormControlReadonly>
                    : <SearchValue isBadge isLink findOptions={PredictorCodificationEntity.findOptions(token => ({
                        filterOptions: [
                            token(e => e.predictor).filter("EqualTo", predictor.toLite()),
                            token(e => e.usage).filter("EqualTo", usage),
                        ],
                    }))} />}
            </FormGroup>
        );
    }

    const ctxb = ctx.subCtx({ formGroupStyle: "Basic" });
    const ctx8 = ctx.subCtx({ labelColumns: 8 });

    return (
        <div>
            <h4>{NeuralNetworkSettingsEntity.niceName()}</h4>
            <AutoLine ctx={ctx.subCtx(a => a.predictionType)} onChange={handlePredictionTypeChanged} />
            {renderCount(ctx, PredictorColumnUsage.Input)}
            <EntityTable ctx={ctx.subCtx(a => a.hiddenLayers)} columns={[
                { property: a => a.size, headerHtmlAttributes: { style: { width: "33%" } } },
                { property: a => a.activation, headerHtmlAttributes: { style: { width: "33%" } } },
                { property: a => a.initializer, headerHtmlAttributes: { style: { width: "33%" } } },
            ]} />
            <div>
                <div className="row">
                    <div className="col-sm-4">
                        {renderCount(ctxb, PredictorColumnUsage.Output)}
                    </div>
                    <div className="col-sm-4">
                        <AutoLine ctx={ctxb.subCtx(a => a.outputActivation)} />
                    </div>
                    <div className="col-sm-4">
                        <AutoLine ctx={ctxb.subCtx(a => a.outputInitializer)} />
                    </div>
                </div>
                <div className="row">
                    <div className="col-sm-4" />
                    <div className="col-sm-4">
                        <AutoLine ctx={ctxb.subCtx(a => a.lossFunction)} />
                    </div>
                    <div className="col-sm-4">
                        <AutoLine ctx={ctxb.subCtx(a => a.evalErrorFunction)} />
                    </div>
                </div>
            </div>
            <hr />
            <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={ctx8.subCtx(a => a.optimizer)} onChange={handleOptimizerChange} />
                    <AutoLine ctx={ctx8.subCtx(a => a.learningRate)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.learningEpsilon)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.device)} />
                </div>
                <div className="col-sm-6">
                    <AutoLine ctx={ctx8.subCtx(a => a.minibatchSize)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.numMinibatches)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.bestResultFromLast)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.saveProgressEvery)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.saveValidationProgressEvery)} />
                </div>
            </div>
            {/* The prediction type drives which losses are legal, and picking an illegal pair is only
                caught on Save — so say it here, where the choice is made. */}
            {isClassificationType(ctx.value.predictionType) !== isClassificationLoss(ctx.value.lossFunction) &&
                <div className="alert alert-warning mt-2 py-1 px-2 small">
                    {Enum.niceName(PredictionType, ctx.value.predictionType)}
                    {" — "}
                    {Enum.niceName(NeuralNetworkEvalFunction, ctx.value.lossFunction)}
                </div>}
        </div>
    );
}

/** Whether a loss is one of the CLASSIFICATION losses — the validation the settings entity enforces. */
function isClassificationLoss(f: NeuralNetworkEvalFunction): boolean {
    return f === NeuralNetworkEvalFunction.softmax_cross_entropy_with_logits
        || f === NeuralNetworkEvalFunction.softmax_cross_entropy_with_logits_v2
        || f === NeuralNetworkEvalFunction.sigmoid_cross_entropy_with_logits
        || f === NeuralNetworkEvalFunction.ClassificationError;
}
