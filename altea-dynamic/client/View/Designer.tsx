import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Modal, Dropdown, DropdownButton } from "react-bootstrap";
import { classes, Dic } from "@altea/altea/data/globals";
import { Finder } from "@altea/altea/client/Finder";
import type { Binding } from "@altea/altea/client/binding";
import { Typeahead } from "@altea/altea/client/Components";
import { ModalFooterButtons, ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import JavascriptCodeMirror from "@altea/altea-codemirror/client/JavascriptCodeMirror";
import type { Expression, DesignerNode } from "./NodeUtils";
import type { BaseNode } from "./Nodes";
import * as NodeUtils from "./NodeUtils";
import { ModulesHelp } from "./ModulesHelp";
import { CopyTextModal } from "./CopyTextModal";
import { DynamicViewMessage } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/Designer.tsx — the INSPECTOR: the little editors that appear in the right
// pane for whichever node is selected. `ExpressionOrValueComponent` is the one that matters — every
// designable property of every node goes through it, and its calculator toggle is what turns a plain value
// into a stored `{ __code__ }` expression.
//
// altea divergences, documented inline:
//  - `LinkButton` (a Signum Basics component) → a plain bootstrap `btn btn-link`.
//  - `AutoLineModal.show({ customComponent: TextAreaLine, … })`, which Signum uses purely as a
//    "here is some text, copy it" dialog, → a local `CopyTextModal` (altea has no AutoLineModal; the
//    html-editor port made the same call for its link dialog).
//  - `CollapsableTypeHelp` is NOT ported: it embeds Signum.Eval's `TypeHelpComponent`, an interactive
//    type-tree browser that belongs to the unported Roslyn half. What it was FOR — discovering what you can
//    write in an expression — is covered by the two help dropdowns that do port (`ModulesHelp`, `PropsHelp`)
//    plus the field picker in `FieldComponent`.
//  - `Finder.getTypeNiceName(route.typeReference())` → `Finder.getTypeNiceName(route.type)`.

export interface ExpressionOrValueProps {
    binding: Binding<unknown>;
    dn: DesignerNode<BaseNode>;
    refreshView?: () => void;
    type: "number" | "string" | "boolean" | "textArea" | null;
    options?: (string | number)[] | ((query: string) => string[]);
    defaultValue: number | string | boolean | null;
    allowsExpression?: boolean;
    avoidDelete?: boolean;
    hideLabel?: boolean;
    exampleExpression?: string;
    onRenderValue?: (value: number | string | null | undefined, e: ExpressionOrValueComponentHandle) => React.ReactElement;
}

interface ExpressionOrValueComponentHandle {
    updateValue(value: string | boolean | null | undefined): void;
}

export function ExpressionOrValueComponent(p: ExpressionOrValueProps): React.JSX.Element {

    function updateValue(value: string | boolean | null | undefined): void {

        let parsedValue: unknown = p.type !== "number" ? value : (Number.parseFloat(value as string) ?? null);

        if (parsedValue === "")
            parsedValue = null;

        if (parsedValue === p.defaultValue && !p.avoidDelete)
            p.binding.deleteValue();
        else
            p.binding.setValue(parsedValue);

        (p.refreshView ?? p.dn.context.refreshView)();
    }

    function handleChangeCheckbox(e: React.ChangeEvent<HTMLInputElement>): void {
        updateValue(e.currentTarget.checked);
    }

    function handleChangeSelectOrInput(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement>): void {
        updateValue(e.currentTarget.value);
    }

    function handleTypeaheadSelect(item: unknown): string {
        updateValue(item as string);
        return item as string;
    }

    function handleToggleExpression(e: React.MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const value = p.binding.getValue();

        if (NodeUtils.isExpression(value)) {
            if (p.avoidDelete)
                p.binding.setValue(undefined);
            else
                p.binding.deleteValue();
        } else {
            p.binding.setValue({
                __code__: p.exampleExpression ?? JSON.stringify(value == undefined ? p.defaultValue : value),
            } as Expression<unknown>);
        }

        (p.refreshView ?? p.dn.context.refreshView)();
    }

    function renderMember(value: number | string | null | undefined): React.ReactNode {
        return (
            <span className={value === undefined ? "design-default" : "design-changed"}>
                {p.binding.member}
            </span>
        );
    }

    function handleGetItems(query: string): Promise<string[]> {
        if (typeof p.options !== "function")
            throw new Error("Unexpected options");

        return Promise.resolve(p.options(query));
    }

    function renderValue(value: number | string | null | undefined): React.ReactNode {
        if (p.onRenderValue)
            return p.onRenderValue(value, { updateValue });

        if (p.type == null)
            return <p className="form-control-static form-control-xs">{DynamicViewMessage.UseExpression.niceToString()}</p>;

        const val = value === undefined ? p.defaultValue : value;

        const style = p.hideLabel ? { display: "inline-block" } as React.CSSProperties : undefined;

        if (p.options) {
            if (typeof p.options === "function")
                return (
                    <Typeahead
                        inputAttrs={{ className: "form-control form-control-xs sf-entity-autocomplete" }}
                        getItems={handleGetItems}
                        onSelect={handleTypeaheadSelect} />
                );

            return (
                <select className="form-select form-select-xs" style={style}
                    value={val == null ? "" : String(val)} onChange={handleChangeSelectOrInput}>
                    {p.defaultValue == null && <option value="">{" - "}</option>}
                    {p.options.map((o, i) => <option key={i} value={String(o)}>{String(o)}</option>)}
                </select>);
        }

        if (p.type === "textArea")
            return (
                <textarea className="form-control form-select-xs" style={style}
                    value={val == null ? "" : String(val)}
                    onChange={handleChangeSelectOrInput} />);

        return (
            <input className="form-control form-control-xs" style={style}
                type="text"
                value={val == null ? "" : String(val)}
                onChange={handleChangeSelectOrInput} />);
    }

    function renderExpression(expression: Expression<unknown>, dn: DesignerNode<BaseNode>): React.ReactNode {
        if (p.allowsExpression === false)
            throw new Error("Unexpected expression");

        const route = dn.parent?.fixRoute();
        const rawName = route?.type.getTypeName() ?? "Entity";
        const typeName = rawName.split(",")
            .map(tn => tn.endsWith("Entity") ? tn : tn + "Entity")
            .join(" | ");

        return (
            <div className="code-container">
                <pre style={{ border: "0px", margin: "0px", overflow: "visible" }}>
                    {"(ctx: TypeContext<" + typeName + ">, "}
                    <div style={{ display: "inline-flex" }}>
                        <ModulesHelp cleanName={typeName.replace("Entity", "")} />{", "}
                        <PropsHelp node={dn} />{", locals) =>"}
                    </div>
                </pre>
                <JavascriptCodeMirror
                    code={expression.__code__}
                    onChange={newCode => { expression.__code__ = newCode; p.dn.context.refreshView(); }} />
            </div>
        );
    }

    const value = p.binding.getValue();

    const expr = NodeUtils.isExpression(value) ? value : null;

    const expressionIcon = p.allowsExpression !== false && (
        <span className={classes("formula", expr && "active")} onClick={handleToggleExpression}>
            <FontAwesomeIcon icon="calculator" title={DynamicViewMessage.UseExpression.niceToString()} />
        </span>);

    if (!expr && p.type === "boolean") {

        if (p.defaultValue == null)
            return (
                <div>
                    <label className="label-xs">
                        {expressionIcon}
                        <NullableCheckBox value={value as boolean | undefined}
                            onChange={newValue => updateValue(newValue)}
                            label={!p.hideLabel && renderMember(value as string | undefined)} />
                    </label>
                </div>
            );

        return (
            <div>
                <label className="label-xs">
                    {expressionIcon}
                    <input className="design-check-box form-check-input"
                        type="checkbox"
                        checked={value == undefined ? p.defaultValue as boolean : value as boolean}
                        onChange={handleChangeCheckbox} />
                    {!p.hideLabel && renderMember(value as string | undefined)}
                </label>
            </div>
        );
    }

    if (p.hideLabel)
        return (
            <div className="row gx-1">
                <div className="col-auto">{expressionIcon}</div>
                <div className="col-auto">
                    {expr ? renderExpression(expr, p.dn) : renderValue(value as string | undefined)}
                </div>
            </div>
        );

    return (
        <div className="form-group form-group-xs">
            <label className="control-label label-xs">
                {expressionIcon}
                {renderMember(value as string | undefined)}
            </label>
            <div>
                {expr ? renderExpression(expr, p.dn) : renderValue(value as string | undefined)}
            </div>
        </div>
    );
}

interface NullableCheckBoxProps {
    label: React.ReactNode | undefined | false;
    value: boolean | undefined;
    onChange: (newValue: boolean | undefined) => void;
}

/** Signum's three-state checkbox: true → false → undefined ("inherit the default"). */
export function NullableCheckBox(p: NullableCheckBoxProps): React.JSX.Element {

    function getIcon(): "check" | "times" | "minus" {
        switch (p.value) {
            case true: return "check";
            case false: return "times";
            default: return "minus";
        }
    }

    function getClass(): string {
        return p.value === undefined ? "design-default" : "design-changed";
    }

    function handleClick(): void {
        switch (p.value) {
            case true: p.onChange(false); break;
            case false: p.onChange(undefined); break;
            default: p.onChange(true); break;
        }
    }

    return (
        <button type="button" className="btn btn-link p-0" onClick={handleClick}>
            <FontAwesomeIcon icon={getIcon()} className={getClass()} />
            {" "}
            {p.label}
        </button>
    );
}

export interface FieldComponentProps {
    dn: DesignerNode<BaseNode>;
    binding: Binding<string | undefined>;
}

/** The field picker: the members reachable from the PARENT node's route. */
export function FieldComponent(p: FieldComponentProps): React.JSX.Element {

    function handleChange(e: React.ChangeEvent<HTMLSelectElement>): void {
        if (!e.currentTarget.value)
            p.binding.deleteValue();
        else
            p.binding.setValue(e.currentTarget.value);

        p.dn.context.refreshView();
    }

    function renderValue(value: string | null | undefined): React.ReactNode {
        const strValue = value == null ? "" : String(value);

        const route = p.dn.parent?.fixRoute();
        const subMembers = route ? route.subMembers() : {};

        return (
            <select className="form-select form-select-xs" value={strValue} onChange={handleChange}>
                <option value=""> - </option>
                {Dic.getKeys(subMembers).filter(k => k !== "id").map((name, i) =>
                    <option key={i} value={name}>{name}</option>)}
            </select>);
    }

    return (
        <div className="form-group form-group-xs">
            <label className="control-label label-xs">
                {p.binding.member}
            </label>
            <div>
                {renderValue(p.binding.getValue())}
            </div>
        </div>
    );
}

export function DynamicViewInspector(p: { selectedNode?: DesignerNode<BaseNode> }): React.JSX.Element {
    const sn = p.selectedNode;

    if (!sn)
        return <h4>{DynamicViewMessage.SelectANodeFirst.niceToString()}</h4>;

    const error = NodeUtils.validate(sn, undefined);

    return (
        <div className="form-sm">
            <h4>
                {sn.node.kind}
                {sn.route && <small> ({Finder.getTypeNiceName(sn.route.type)})</small>}
            </h4>
            {error && <div className="alert alert-danger">{error}</div>}
            {NodeUtils.renderDesigner(sn)}
        </div>);
}

interface DesignerModalProps extends IModalProps<boolean | undefined> {
    title: React.ReactNode;
    mainComponent: () => React.ReactElement;
}

export function DesignerModal(p: DesignerModalProps): React.JSX.Element {

    const [show, setShow] = React.useState(true);
    const okClicked = React.useRef<boolean | undefined>(undefined);

    function handleOkClicked(): void {
        okClicked.current = true;
        setShow(false);
    }

    function handleCancelClicked(): void {
        setShow(false);
    }

    function handleOnExited(): void {
        p.onExited!(okClicked.current);
    }

    return (
        <Modal size="lg" onHide={handleCancelClicked} show={show} onExited={handleOnExited} className="sf-selector-modal">
            <ModalHeaderButtons>
                {p.title}
            </ModalHeaderButtons>
            <div className="modal-body">
                {p.mainComponent()}
            </div>
            <ModalFooterButtons onOk={handleOkClicked} onCancel={handleCancelClicked} />
        </Modal>
    );
}

export namespace DesignerModal {
    export function show(title: React.ReactNode, mainComponent: () => React.ReactElement): Promise<boolean | undefined> {
        return openModal<boolean>(<DesignerModal title={title} mainComponent={mainComponent} />);
    }
}

/** The `props` dropdown beside an expression editor: what the view declared it can be passed. */
export function PropsHelp(p: { node: DesignerNode<BaseNode> }): React.JSX.Element {

    function handlePropsClick(val: string): void {
        void CopyTextModal.show(
            `${DynamicViewMessage.PropsHelp.niceToString()}.${val}`,
            `props.${val}`);
    }

    return (
        <DropdownButton id="props_help_dropdown" variant="success" size={"sm"} title={DynamicViewMessage.PropsHelp.niceToString()}>
            {Dic.map(p.node.context.propTypes, (name, typeName) =>
                <Dropdown.Item style={{ paddingTop: "0", paddingBottom: "0" }} key={name}
                    onClick={() => handlePropsClick(name)}>{name}: {typeName}</Dropdown.Item>)}
        </DropdownButton>
    );
}
