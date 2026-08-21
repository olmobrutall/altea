import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes, Dic } from "@altea/altea/data/globals";
import { Binding } from "@altea/altea/client/binding";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { ExpressionOrValueComponent, DesignerModal } from "./Designer";
import { type DesignerNode, isExpression } from "./NodeUtils";
import type { BaseNode } from "./Nodes";
import { type StyleOptionsExpression, formGroupStyle, formSize } from "./StyleOptionsExpression";

// Port of Signum.Dynamic's View/StyleOptionsComponent.tsx — verbatim: the inspector row for a node's
// `styleOptions`, which opens a modal with one ExpressionOrValueComponent per StyleOptions member.
//
// altea divergence: `LinkButton` → a plain bootstrap `btn btn-link` (altea has no LinkButton).

interface StyleOptionsLineProps {
    binding: Binding<StyleOptionsExpression | undefined>;
    dn: DesignerNode<BaseNode>;
}

export function StyleOptionsLine(p: StyleOptionsLineProps): React.JSX.Element {

    function renderMember(expr: StyleOptionsExpression | undefined): React.ReactNode {
        return (
            <span className={expr === undefined ? "design-default" : "design-changed"}>
                {p.binding.member}
            </span>);
    }

    function handleRemove(): void {
        p.binding.deleteValue();
        p.dn.context.refreshView();
    }

    function handleCreate(): void {
        modifyExpression({} as StyleOptionsExpression);
    }

    function handleView(): void {
        // A deep clone, so Cancel really cancels (Signum does the same).
        const soe = JSON.parse(JSON.stringify(p.binding.getValue())) as StyleOptionsExpression;
        modifyExpression(soe);
    }

    function modifyExpression(soe: StyleOptionsExpression): void {
        void DesignerModal.show("StyleOptions", () => <StyleOptionsComponent dn={p.dn} styleOptions={soe} />)
            .then(result => {
                if (result) {
                    if (Dic.getKeys(soe).length === 0)
                        p.binding.deleteValue();
                    else
                        p.binding.setValue(soe);
                }

                p.dn.context.refreshView();
            });
    }

    function getDescription(soe: StyleOptionsExpression): string {
        return Dic.map(soe as Record<string, unknown>,
            (key, value) => key + ": " + (isExpression(value) ? value.__code__ : String(value))).join("\n");
    }

    const val = p.binding.getValue();

    return (
        <div className="form-group form-group-xs">
            <label className="control-label label-xs">
                {renderMember(val)}
                {val && " "}
                {val && <button type="button" className={classes("btn btn-link p-0", "sf-line-button", "sf-remove")}
                    onClick={handleRemove}
                    title={EntityControlMessage.Remove.niceToString()}>
                    <FontAwesomeIcon icon="xmark" />
                </button>}
            </label>
            <div>
                {val
                    ? <button type="button" className="btn btn-link p-0" onClick={handleView}>
                        <pre style={{ padding: "0px", border: "none", color: "blue" }}>{getDescription(val)}</pre>
                    </button>
                    : <button type="button" className="btn btn-link p-0 sf-line-button sf-create"
                        title={EntityControlMessage.Create.niceToString()}
                        onClick={handleCreate}>
                        <FontAwesomeIcon icon="plus" className="sf-create" />&nbsp;{EntityControlMessage.Create.niceToString()}
                    </button>}
            </div>
        </div>
    );
}

export interface StyleOptionsComponentProps {
    dn: DesignerNode<BaseNode>;
    styleOptions: StyleOptionsExpression;
}

export function StyleOptionsComponent(p: StyleOptionsComponentProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const so = p.styleOptions;
    const dn = p.dn;

    return (
        <div className="form-sm code-container">
            <ExpressionOrValueComponent dn={dn} refreshView={forceUpdate} binding={Binding.create(so, s => s.formGroupStyle)} type="string" options={formGroupStyle} defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} refreshView={forceUpdate} binding={Binding.create(so, s => s.formSize)} type="string" options={formSize} defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} refreshView={forceUpdate} binding={Binding.create(so, s => s.placeholderLabels)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} refreshView={forceUpdate} binding={Binding.create(so, s => s.readonlyAsPlainText)} type="boolean" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} refreshView={forceUpdate} binding={Binding.create(so, s => s.labelColumns)} type="number" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} refreshView={forceUpdate} binding={Binding.create(so, s => s.valueColumns)} type="number" defaultValue={null} />
            <ExpressionOrValueComponent dn={dn} refreshView={forceUpdate} binding={Binding.create(so, s => s.readOnly)} type="boolean" defaultValue={null} />
        </div>
    );
}
