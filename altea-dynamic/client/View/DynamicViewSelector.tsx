import * as React from "react";
import { Dropdown, DropdownButton } from "react-bootstrap";
import { classes } from "@altea/altea/data/globals";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { Entity } from "@altea/altea/data/entity";
import { JavascriptMessage, SaveChangesMessage } from "@altea/altea/data/uiMessages";
import { Binding } from "@altea/altea/client/binding";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { resolveType } from "@altea/altea/data/registration";
import { Navigator } from "@altea/altea/client/Navigator";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import JavascriptCodeMirror from "@altea/altea-codemirror/client/JavascriptCodeMirror";
import { DynamicViewClient } from "../DynamicViewClient";
import { ModulesHelp } from "./ModulesHelp";
import { CopyTextModal } from "./CopyTextModal";
import { DynamicViewMessage, type DynamicViewSelectorEntity } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/DynamicViewSelector.tsx — the selector's editor, and it is mostly a TEST
// HARNESS: write `e => …`, pick an example entity, and see immediately whether the name it returns is one
// this type actually has (green) or not (red). The three reserved names are offered alongside the real ones.
//
// altea divergences:
//  - `TypeHelpComponent` (the right-hand type browser) is not ported — it belongs to Signum.Eval; the
//    `modules` dropdown covers the discoverability it provided (see Designer.tsx).
//  - `AutoLineModal` used as a copy-this-text dialog → the local `CopyTextModal`.
//  - `entityType.className` → `entityType.cleanName` (altea's TypeEntity has no separate className column in
//    the sense Signum uses here; the clean name is what a snippet needs).
//  - `dvs.modified = true` is dropped: altea tracks modification against a snapshot.
export default function DynamicViewSelectorComponent(p: { ctx: TypeContext<DynamicViewSelectorEntity> }): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const viewNames = useAPI(
        () => !p.ctx.value.entityType
            ? Promise.resolve(undefined)
            : Navigator.getViewDispatcher().getViewNames(p.ctx.value.entityType.cleanName),
        [p.ctx.value.entityType]);

    const exampleEntityRef = React.useRef<Entity | null>(null);
    const scriptChangedRef = React.useRef(false);

    const [syntaxError, setSyntaxError] = React.useState<string | undefined>(undefined);
    const [testResult, setTestResult] = React.useState<
        { type: "ERROR"; error: string } | { type: "RESULT"; result: string | undefined } | undefined>(undefined);

    function handleTypeRemove(): Promise<boolean> {
        if (scriptChangedRef.current)
            return MessageModal.show({
                title: SaveChangesMessage.ThereAreChanges.niceToString(),
                message: JavascriptMessage.loseCurrentChanges.niceToString(),
                buttons: "yes_no",
                icon: "warning",
                style: "warning",
            }).then(result => result === "yes");

        return Promise.resolve(true);
    }

    function allViewNames(): string[] {
        return ["NEW", "STATIC", "CHOOSE", ...(viewNames ?? [])];
    }

    function evaluateTest(): void {
        setSyntaxError(undefined);
        setTestResult(undefined);

        const dvs = p.ctx.value;
        let func: (e: Entity) => string;
        try {
            func = DynamicViewClient.asSelectorFunction(dvs);
        } catch (e) {
            setSyntaxError((e as Error).message);
            return;
        }

        if (exampleEntityRef.current) {
            try {
                setTestResult({ type: "RESULT", result: func(exampleEntityRef.current) });
            } catch (e) {
                setTestResult({ type: "ERROR", error: (e as Error).message });
            }
        }
    }

    function handleCodeChange(newCode: string): void {
        const dvs = p.ctx.value;

        if (dvs.script !== newCode) {
            dvs.script = newCode;
            scriptChangedRef.current = true;
            evaluateTest();
        }
    }

    function getTestAlertType(result: string | undefined): string {
        if (!result)
            return "alert-danger";

        return allViewNames().includes(result) ? "alert-success" : "alert-danger";
    }

    function handleOnView(exampleEntity: Entity): Promise<Entity | undefined> {
        return Navigator.view(exampleEntity, { requiresSaveOperation: false, isOperationVisible: () => false });
    }

    function renderExampleEntity(typeName: string): React.ReactNode {
        const ctor = resolveType(typeName);
        if (ctor == undefined)
            return <div className="alert alert-warning">Type '{typeName}' is not registered on the client</div>;

        const exampleCtx = new TypeContext<Entity | null>(
            undefined, undefined, PropertyRoute.root(ctor), Binding.create(exampleEntityRef, s => s.current));

        return (
            <EntityLine ctx={exampleCtx as never} create={true} find={true} remove={true} view={true}
                onView={handleOnView as never} onChange={() => evaluateTest()}
                label={DynamicViewMessage.ExampleEntity.niceToString()} />
        );
    }

    function renderTest(): React.JSX.Element {
        const ctx = p.ctx;
        const res = testResult;
        return (
            <fieldset>
                <legend>TEST</legend>
                {renderExampleEntity(ctx.value.entityType.cleanName)}
                {res?.type === "ERROR" && <div className="alert alert-danger">ERROR: {res.error}</div>}
                {res?.type === "RESULT" &&
                    <div className={classes("alert", getTestAlertType(res.result))}>
                        RESULT: {res.result === undefined ? "undefined" : JSON.stringify(res.result)}
                    </div>}
            </fieldset>
        );
    }

    function renderViewNameButtons(): React.JSX.Element {
        return (
            <DropdownButton variant="success" title="View Names" id="views_dropdown">
                {allViewNames().map((vn, i) =>
                    <Dropdown.Item key={i} onClick={() => void CopyTextModal.show("View Name", `"${vn}"`)}>{vn}</Dropdown.Item>)}
            </DropdownButton>
        );
    }

    function renderEditor(): React.JSX.Element {
        const ctx = p.ctx;
        const cleanName = ctx.value.entityType.cleanName;
        return (
            <div className="code-container">
                <div className="btn-toolbar btn-toolbar-small">
                    {renderViewNameButtons()}
                </div>
                <pre style={{ border: "0px", margin: "0px", overflow: "visible" }}>
                    {"(e: " + cleanName + "Entity, "}
                    <div style={{ display: "inline-flex" }}>
                        <ModulesHelp cleanName={cleanName} />{") =>"}
                    </div>
                </pre>
                <JavascriptCodeMirror code={ctx.value.script ?? ""} onChange={handleCodeChange} />
                {syntaxError && <div className="alert alert-danger">{syntaxError}</div>}
            </div>
        );
    }

    const ctx = p.ctx;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.entityType)} onChange={forceUpdate} onRemove={handleTypeRemove} />

            {ctx.value.entityType &&
                <div>
                    <br />
                    <div className="row">
                        <div className="col-sm-12">
                            {renderEditor()}
                            {renderTest()}
                        </div>
                    </div>
                </div>}
        </div>
    );
}
