import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { WorkflowMessage } from "../../data/Workflow";
import { ConnectionType, type WorkflowConnectionModel } from "../../data/WorkflowNodes";
import { WorkflowConditionEntity } from "../../data/WorkflowCondition";
import { WorkflowActionEntity } from "../../data/WorkflowAction";

// Port of Signum.Workflow's Workflow/WorkflowConnectionModel.tsx — what a connection carries: its type, the
// decision option it answers (when it leaves a decision gateway), its guard condition, its action, and the
// evaluation order on an exclusive split.
//
// altea divergences: the type comparison is an ORDINAL, and the decision-option list is a plain array.

export default function WorkflowConnectionModelComponent(
    p: { ctx: TypeContext<WorkflowConnectionModel> }): React.JSX.Element {

    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const forceUpdate = useForceUpdate();

    function handleDecisionNameChange(e: React.SyntheticEvent<HTMLSelectElement>): void {
        const value = (e.currentTarget as HTMLSelectElement).value;
        ctx.value.decisionOptionName = ctx.value.decisionOptions.find(d => d.name === value)?.name ?? null;
        forceUpdate();
    }

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={ctx.subCtx(e => e.name)} />
                </div>
                <div className="col-sm-6">
                    <AutoLine ctx={ctx.subCtx(e => e.type)}
                        onChange={() => { ctx.value.decisionOptionName = null; forceUpdate(); }} />
                </div>
            </div>

            {ctx.value.type === ConnectionType.Decision &&
                <FormGroup ctx={ctx.subCtx(e => e.decisionOptionName)} label={ctx.niceName(e => e.decisionOptionName)}>
                    {inputId =>
                        <select id={inputId} value={ctx.value.decisionOptionName ?? ""} className="form-select"
                            onChange={handleDecisionNameChange}>
                            <option value="" />
                            {(ctx.value.decisionOptions ?? []).map((d, i) =>
                                <option key={i} value={d.name}>{d.name}</option>)}
                        </select>}
                </FormGroup>}

            <div className="row">
                <div className="col-sm-6">
                    {ctx.value.needCondition
                        ? ctx.value.mainEntityType
                            ? <EntityLine ctx={ctx.subCtx(e => e.condition)}
                                findOptions={WorkflowConditionEntity.findOptions(token => ({
                                    filterOptions: [token(e => e.mainEntityType).filter("EqualTo", ctx.value.mainEntityType)],
                                }))} />
                            : <div className="alert alert-warning">
                                {WorkflowMessage.ToUse0YouSouldSetTheWorkflow1.niceToString(
                                    ctx.niceName(e => e.condition), ctx.niceName(e => e.mainEntityType))}
                            </div>
                        : undefined}
                    {ctx.value.needOrder &&
                        <AutoLine ctx={ctx.subCtx(e => e.order)}
                            helpText={WorkflowMessage.EvaluationOrderOfTheConnectionForIfElse.niceToString()} />}
                </div>
                <div className="col-sm-6">
                    {ctx.value.mainEntityType
                        ? <EntityLine ctx={ctx.subCtx(e => e.action)}
                            findOptions={WorkflowActionEntity.findOptions(token => ({
                                filterOptions: [token(e => e.mainEntityType).filter("EqualTo", ctx.value.mainEntityType)],
                            }))} />
                        : <div className="alert alert-warning">
                            {WorkflowMessage.ToUse0YouSouldSetTheWorkflow1.niceToString(
                                ctx.niceName(e => e.action), ctx.niceName(e => e.mainEntityType))}
                        </div>}
                </div>
            </div>
        </div>
    );
}
