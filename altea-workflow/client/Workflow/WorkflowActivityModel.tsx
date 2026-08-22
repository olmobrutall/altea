import * as React from "react";
import { Button } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { TypeEntity } from "@altea/altea/data/typeEntity";
import { WorkflowEntity, WorkflowMessage } from "../../data/Workflow";
import {
    BootstrapStyle, ButtonOptionEmbedded, SubWorkflowEmbedded, ViewNamePropEmbedded, WorkflowActivityMessage,
    WorkflowActivityModel, WorkflowActivityType, WorkflowScriptPartEmbedded,
} from "../../data/WorkflowNodes";
import { WorkflowScriptEntity } from "../../data/WorkflowScript";

// Port of Signum.Workflow's Workflow/WorkflowActivityModel.tsx — the big one: what an ACTIVITY is. Its type
// drives everything else (a Script activity gets a script part, a Decomposition gets a sub-workflow, a
// Decision gets its buttons, a Task may get a custom Next button), and a custom VIEW may take extra props.
//
// altea divergences:
//  - the sub-entities eval is a symbol PICKER (see data/WorkflowEval.ts), so Signum's C# editor +
//    TypeHelp browser for it are gone.
//  - `userHelp` is edited with a plain TextAreaLine. Signum uses its HtmlEditor; @altea/altea-html-editor
//    exists, but depending on it from here for one field would pull a whole package into every app that uses
//    workflows — the seam is `WorkflowActivityModelOptions.userHelpComponent`, which an app can fill with
//    `HtmlEditorLine` in one line.
//  - `WorkflowActivityModelOptions.getViewProps` / `navigateToView` are kept as the SAME injected seam Signum
//    fills from Signum.WorkflowDynamic (the unported, Roslyn half): unfilled, a custom view simply takes no
//    props, and the ViewNameProps table is still editable by hand.
//  - the collections are plain arrays and the type comparisons are ordinals.

export const WorkflowActivityModelOptions = {
    /** Signum's injected "which props does this dynamic view take?" (from Signum.WorkflowDynamic). */
    getViewProps: undefined as undefined | ((typeName: string, viewName: string) => Promise<{ name: string; type: string }[]>),
    /** Signum's injected "open this dynamic view with these props" (from Signum.WorkflowDynamic). */
    navigateToView: undefined as undefined | ((typeName: string, viewName: string, props: { [name: string]: unknown }) => Promise<void>),
    /** altea seam: render `userHelp` with a rich editor (an app may point this at
     *  @altea/altea-html-editor's HtmlEditorLine). Defaults to a plain text area. */
    userHelpComponent: undefined as undefined | ((ctx: TypeContext<string | null>) => React.ReactElement),
};

export default function WorkflowActivityModelComponent(
    p: { ctx: TypeContext<WorkflowActivityModel> }): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    const [viewNames, setViewNames] = React.useState<string[] | undefined>(undefined);
    const [viewProps, setViewProps] = React.useState<{ name: string; type: string }[] | undefined>(undefined);

    React.useEffect(() => {
        if (ctx.value.mainEntityType) {
            const typeName = ctx.value.mainEntityType.cleanName;
            void Navigator.getViewDispatcher().getViewNames(typeName).then(vn => setViewNames(vn));
            fillViewProps();
        }

        handleTypeChange();
    }, []);

    function isNamedView(typeName: string, viewName: string): boolean {
        const es = Navigator.getSettings(typeName);
        return Object.keys(es?.namedViews ?? {}).includes(viewName);
    }

    function fillViewProps(): void {
        const typeName = ctx.value.mainEntityType.cleanName;
        const viewName = ctx.value.viewName;

        const isStaticView = !viewName || viewName === "" || isNamedView(typeName, viewName);

        if (isStaticView) {
            setViewProps(undefined);
            ctx.value.viewNameProps = [];
            forceUpdate();
            return;
        }

        const oldExpressions = new Map(ctx.value.viewNameProps.map(a => [a.name, a.expression]));

        if (WorkflowActivityModelOptions.getViewProps) {
            void WorkflowActivityModelOptions.getViewProps(typeName, viewName).then(dvp => {
                setViewProps(dvp);
                ctx.value.viewNameProps = dvp.map(prop => ViewNamePropEmbedded.create({
                    name: prop.name,
                    expression: oldExpressions.get(prop.name) ?? null,
                }));
                forceUpdate();
            });
        }
    }

    function handleViewNameChange(e: React.SyntheticEvent<HTMLSelectElement>): void {
        ctx.value.viewName = (e.currentTarget as HTMLSelectElement).value;
        fillViewProps();
    }

    /** Signum's handleTypeChange — keep the type-dependent members consistent with the chosen type. */
    function handleTypeChange(): void {
        const wa = ctx.value;

        if (wa.type === WorkflowActivityType.Script) {
            wa.script ??= WorkflowScriptPartEmbedded.create({});
            wa.subWorkflow = null;
        }

        if (wa.type === WorkflowActivityType.DecompositionWorkflow || wa.type === WorkflowActivityType.CallWorkflow) {
            wa.subWorkflow ??= SubWorkflowEmbedded.create({});
            wa.script = null;
        }

        if (wa.type === WorkflowActivityType.DecompositionWorkflow || wa.type === WorkflowActivityType.CallWorkflow
            || wa.type === WorkflowActivityType.Script) {
            wa.viewName = null;
            wa.requiresOpen = false;
        }
        else {
            wa.subWorkflow = null;
            wa.script = null;
        }

        if (wa.type === WorkflowActivityType.Decision) {
            if (wa.decisionOptions.length === 0) {
                wa.decisionOptions.push(ButtonOptionEmbedded.create({
                    name: WorkflowActivityMessage.Approve.niceToString(), style: BootstrapStyle.Success,
                }));
                wa.decisionOptions.push(ButtonOptionEmbedded.create({
                    name: WorkflowActivityMessage.Decline.niceToString(), style: BootstrapStyle.Danger,
                }));
            }
        }
        else
            wa.decisionOptions = [];

        if (wa.type !== WorkflowActivityType.Task)
            wa.customNextButton = null;

        forceUpdate();
    }

    function handleCheckView(): void {
        const typeName = ctx.value.mainEntityType.cleanName;
        const viewName = ctx.value.viewName;
        const props = ctx.value.viewNameProps.toObject(a => a.name,
            a => !a.expression ? undefined : evalExpression(a.expression));

        const isStaticView = !viewName || viewName === "" || isNamedView(typeName, viewName);

        if (isStaticView) {
            void Finder.find({ queryName: typeName }).then(lite => {
                if (!lite)
                    return;

                return Navigator.API.fetch(lite).then(entity => {
                    const vp = Navigator.getViewDispatcher().getViewPromise(entity, viewName || undefined);
                    return Navigator.view(entity, {
                        getViewPromise: () => vp,
                        extraProps: props,
                        isOperationVisible: () => false,
                        avoidPromptLoseChange: true,
                        readOnly: true,
                    });
                });
            });
        }
        else
            void WorkflowActivityModelOptions.navigateToView?.(typeName, viewName, props);
    }

    function viewNamePropsHelpText(pctx: TypeContext<ViewNamePropEmbedded>): React.ReactNode {
        const prop = viewProps?.singleOrNull(a => a.name === pctx.value.name);
        return viewProps == null ? undefined
            : prop == null ? <div style={{ color: "#a94442" }}><strong>Property not found</strong></div>
                : <strong>{prop.type}</strong>;
    }

    function viewNamePropsIsMandatory(pctx: TypeContext<ViewNamePropEmbedded>): boolean {
        const prop = viewProps?.singleOrNull(a => a.name === pctx.value.name);
        return prop != null && !prop.type.endsWith("?");
    }

    const isSubWorkflowOrScript = ctx.value.type === WorkflowActivityType.DecompositionWorkflow
        || ctx.value.type === WorkflowActivityType.CallWorkflow
        || ctx.value.type === WorkflowActivityType.Script;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(d => d.name)} onChange={() => forceUpdate()} />
            <AutoLine ctx={ctx.subCtx(d => d.type)} onChange={handleTypeChange} valueColumns={5} />
            <AutoLine ctx={ctx.subCtx(a => a.estimatedDuration)} valueColumns={5} />

            {!isSubWorkflowOrScript &&
                <div>
                    {ctx.value.mainEntityType ? <>
                        <FormGroup ctx={ctx.subCtx(d => d.viewName)} label={ctx.niceName(d => d.viewName)}>
                            {inputId => <div className="row">
                                <div className="col-sm-6">
                                    <select id={inputId} value={ctx.value.viewName ?? ""}
                                        className="form-select form-select-sm" onChange={handleViewNameChange}>
                                        <option value="">{" - "}</option>
                                        {(viewNames ?? []).map((v, i) => <option key={i} value={v}>{v}</option>)}
                                    </select>
                                </div>
                                <div className="col-sm-6">
                                    <Button variant="success" size="sm" onClick={handleCheckView}>Check View …</Button>
                                </div>
                            </div>}
                        </FormGroup>
                        <FormGroup ctx={ctx.subCtx(d => d.viewNameProps)}>
                            {() => <EntityTable avoidFieldSet
                                ctx={ctx.subCtx(d => d.viewNameProps)}
                                columns={[
                                    {
                                        property: a => a.name,
                                        template: pctx => <AutoLine ctx={pctx.subCtx(a => a.name)} />,
                                    },
                                    {
                                        property: a => a.expression,
                                        template: (pctx: TypeContext<ViewNamePropEmbedded>) =>
                                            <AutoLine ctx={pctx.subCtx(a => a.expression)}
                                                helpText={viewNamePropsHelpText(pctx)}
                                                mandatory={viewNamePropsIsMandatory(pctx)} />,
                                    },
                                ]} />}
                        </FormGroup>
                    </>
                        : <div className="alert alert-warning">
                            {WorkflowMessage.ToUse0YouSouldSetTheWorkflow1.niceToString(
                                ctx.niceName(e => e.viewName), ctx.niceName(e => e.mainEntityType))}
                        </div>}

                    <AutoLine ctx={ctx.subCtx(a => a.requiresOpen)} />

                    {ctx.value.type === WorkflowActivityType.Decision
                        ? <EntityTable ctx={ctx.subCtx(a => a.decisionOptions)} /> : null}

                    {ctx.value.type === WorkflowActivityType.Task
                        ? <EntityDetail ctx={ctx.subCtx(a => a.customNextButton)} labelColumns={1} valueColumns={4} /> : null}

                    {ctx.value.workflow
                        ? <EntityRepeater ctx={ctx.subCtx(a => a.boundaryTimers)} readOnly={false} />
                        : <div className="alert alert-warning">
                            {WorkflowMessage.ToUse0YouSouldSaveWorkflow.niceToString(ctx.niceName(e => e.boundaryTimers))}
                        </div>}

                    <fieldset>
                        <legend>{WorkflowActivityModel.nicePropertyName(a => a.userHelp)}</legend>
                        {WorkflowActivityModelOptions.userHelpComponent
                            ? WorkflowActivityModelOptions.userHelpComponent(ctx.subCtx(a => a.userHelp))
                            : <TextAreaLine ctx={ctx.subCtx(a => a.userHelp)} label={null} />}
                    </fieldset>
                    <AutoLine ctx={ctx.subCtx(d => d.comments)} />
                </div>}

            {ctx.value.script != null
                ? ctx.value.workflow
                    ? <ScriptComponent ctx={ctx.subCtx(a => a.script!)} mainEntityType={ctx.value.mainEntityType} />
                    : <div className="alert alert-warning">
                        {WorkflowMessage.ToUse0YouSouldSaveWorkflow.niceToString(ctx.niceName(e => e.script))}
                    </div>
                : undefined}

            {ctx.value.subWorkflow != null
                ? ctx.value.mainEntityType
                    ? <DecompositionComponent ctx={ctx.subCtx(a => a.subWorkflow!)} />
                    : <div className="alert alert-warning">
                        {WorkflowMessage.ToUse0YouSouldSetTheWorkflow1.niceToString(
                            ctx.niceName(e => e.subWorkflow), ctx.niceName(e => e.mainEntityType))}
                    </div>
                : undefined}
        </div>
    );
}

function ScriptComponent(p: { ctx: TypeContext<WorkflowScriptPartEmbedded>; mainEntityType: TypeEntity }): React.JSX.Element {
    const ctx = p.ctx;
    return (
        <fieldset>
            <legend>{ctx.niceName()}</legend>
            <EntityLine ctx={ctx.subCtx(a => a.script)}
                findOptions={WorkflowScriptEntity.findOptions(token => ({
                    filterOptions: [token(e => e.mainEntityType).filter("EqualTo", p.mainEntityType)],
                }))} />
            <EntityLine ctx={ctx.subCtx(s => s.retryStrategy)} />
        </fieldset>
    );
}

function DecompositionComponent(p: { ctx: TypeContext<SubWorkflowEmbedded> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    return (
        <fieldset>
            <legend>{ctx.niceName()}</legend>
            <EntityLine ctx={ctx.subCtx(a => a.workflow)} onChange={() => forceUpdate()} />
            {ctx.value.workflow && <EntityLine ctx={ctx.subCtx(a => a.subEntitiesEvaluator)} />}
        </fieldset>
    );
}

/**
 * A view prop's `expression` is a JavaScript snippet the DESIGNER wrote, evaluated in the browser to build
 * the prop value — exactly as in Signum (whose `eval(a.element.expression)` runs client-side too). It is not
 * an altea Eval divergence: nothing is compiled or stored server-side.
 */
function evalExpression(expression: string): unknown {
    // eslint-disable-next-line no-eval
    return eval(expression);
}
