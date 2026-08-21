import * as React from "react";
import { Dropdown, DropdownButton } from "react-bootstrap";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { TypeContext, type EntityFrame } from "@altea/altea/client/TypeContext";
import { Entity } from "@altea/altea/data/entity";
import { JavascriptMessage, SaveChangesMessage } from "@altea/altea/data/uiMessages";
import { Binding, ReadonlyBinding } from "@altea/altea/client/binding";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { resolveType } from "@altea/altea/data/registration";
import { Navigator } from "@altea/altea/client/Navigator";
import { ViewReplacer } from "@altea/altea/client/Frames/ReactVisitor";
import { ErrorBoundary } from "@altea/altea/client/Components";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { useForceUpdate, useAPI } from "@altea/altea/client/Hooks";
import JavascriptCodeMirror from "@altea/altea-codemirror/client/JavascriptCodeMirror";
import { DynamicViewClient } from "../DynamicViewClient";
import { ModulesHelp } from "./ModulesHelp";
import { CopyTextModal } from "./CopyTextModal";
import { DynamicViewMessage, type DynamicViewOverrideEntity } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/DynamicViewOverride.tsx — the override editor: write `vr => …` against a
// ViewReplacer, pick an example entity, and see the ALREADY-EXISTING view for that entity with the override
// applied. It is the one place where you edit a compiled view without touching the code.
//
// altea divergences, documented inline:
//  - Signum's live preview monkey-patches the component's `render` (`patchComponent` / `unPatchComponent`)
//    for a class, or wraps it with `ViewPromise.surroundFunctionComponent` for a function. altea needs
//    NEITHER: its ViewReplacer rewrites the element tree the view RETURNED, so the preview renders the view
//    once and runs the override over the result. That also removes the mount/unmount dance Signum needs to
//    put the original `render` back.
//  - the right-hand `TypeHelpComponent` pane, its member context menu, the `TypeHelpButtonBarComponent` and
//    the "Expressions" dropdown are NOT ported: all four are Signum.Eval (its `TypeHelpClient.API.typeHelp`
//    is a SERVER call into the Roslyn half). The `modules` dropdown and the view-name dropdown remain.
//  - `AutoLineModal` used as a copy-this-text dialog → the local `CopyTextModal`.
//  - `entityType.className` → `cleanName`; `dvo.modified = true` is dropped (snapshot-based tracking).

interface DynamicViewOverrideComponentProps {
    ctx: TypeContext<DynamicViewOverrideEntity>;
}

export default function DynamicViewOverrideComponent(p: DynamicViewOverrideComponentProps): React.JSX.Element {

    const typeName: string | undefined = p.ctx.value.entityType?.cleanName;
    const viewNames = useAPI(
        () => typeName ? Navigator.getViewDispatcher().getViewNames(typeName) : Promise.resolve(undefined),
        [typeName]);

    const scriptChangedRef = React.useRef(false);
    const forceUpdate = useForceUpdate();

    const exampleEntityRef = React.useRef<Entity | null>(null);
    const viewFuncRef = React.useRef<((ctx: TypeContext<Entity>) => React.ReactElement) | null>(null);

    function setViewFunc(f: ((ctx: TypeContext<Entity>) => React.ReactElement) | null): void {
        viewFuncRef.current = f;
        forceUpdate();
    }

    const [syntaxError, setSyntaxError] = React.useState<string | undefined>(undefined);
    const [viewOverride, setViewOverride] = React.useState<{ func: (vr: ViewReplacer<Entity>) => void } | undefined>(undefined);

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

    function compileFunction(): void {
        setSyntaxError(undefined);
        setViewOverride(undefined);

        try {
            const func = DynamicViewClient.asOverrideFunction(p.ctx.value) as (vr: ViewReplacer<Entity>) => void;
            setViewOverride({ func });
        } catch (e) {
            setSyntaxError((e as Error).message);
        }
    }

    function handleCodeChange(newCode: string): void {
        const dvo = p.ctx.value;

        if (dvo.script !== newCode) {
            dvo.script = newCode;
            scriptChangedRef.current = true;
            compileFunction();
        }
    }

    function handleEntityChange(): void {
        const entity = exampleEntityRef.current;

        if (!entity) {
            setViewFunc(null);
            return;
        }

        void Navigator.getViewDispatcher()
            .getViewPromise(entity, p.ctx.value.viewName ?? undefined).promise
            .then(func => {
                setViewFunc(func as (ctx: TypeContext<Entity>) => React.ReactElement);
                compileFunction();
            });
    }

    function handleOnView(exampleEntity: Entity): Promise<Entity | undefined> {
        return Navigator.view(exampleEntity, { requiresSaveOperation: false, isOperationVisible: () => false });
    }

    function handleViewNameChange(e: React.SyntheticEvent<HTMLSelectElement>): void {
        const value = e.currentTarget.value;
        p.ctx.value.viewName = value !== "" ? value : null;
        forceUpdate();
    }

    function renderExampleEntity(cleanName: string): React.ReactNode {
        const ctor = resolveType(cleanName);
        if (ctor == undefined)
            return <div className="alert alert-warning">Type '{cleanName}' is not registered on the client</div>;

        const exampleCtx = new TypeContext<Entity | null>(
            undefined, undefined, PropertyRoute.root(ctor), Binding.create(exampleEntityRef, s => s.current));

        return (
            <div className="code-container">
                <EntityLine ctx={exampleCtx as never} create={true} find={true} remove={true} view={true}
                    onView={handleOnView as never} onChange={handleEntityChange} formGroupStyle="Basic"
                    label={DynamicViewMessage.ExampleEntity.niceToString()} />
            </div>
        );
    }

    function handleViewNameClick(viewName: string): void {
        void CopyTextModal.show("View",
            `modules.React.createElement(RenderEntity, { ctx: ctx, getViewPromise: ctx => "${viewName}" })`);
    }

    function renderViewNameButtons(): React.JSX.Element {
        return (
            <DropdownButton variant="success" title="View Names" id="view_dropdown">
                {viewNames!.map((vn, i) =>
                    <Dropdown.Item key={i} onClick={() => handleViewNameClick(vn)}>{vn}</Dropdown.Item>)}
            </DropdownButton>
        );
    }

    function renderEditor(): React.JSX.Element {
        const ctx = p.ctx;
        const cleanName = ctx.value.entityType.cleanName;
        return (
            <div className="code-container">
                <div className="btn-toolbar btn-toolbar-small">
                    {viewNames && renderViewNameButtons()}
                </div>
                <pre style={{ border: "0px", margin: "0px", overflow: "visible" }}>
                    {`(vr: ViewReplacer<${cleanName}Entity>, `}
                    <div style={{ display: "inline-flex" }}>
                        <ModulesHelp cleanName={cleanName} />{") =>"}
                    </div>
                </pre>
                <JavascriptCodeMirror code={ctx.value.script ?? ""} onChange={handleCodeChange} />
                {syntaxError && <div className="alert alert-danger">{syntaxError}</div>}
            </div>
        );
    }

    function renderTest(): React.JSX.Element {
        return (
            <div>
                {exampleEntityRef.current && viewFuncRef.current &&
                    <ErrorBoundary>
                        <RenderWithReplacements entity={exampleEntityRef.current}
                            viewFunc={viewFuncRef.current}
                            viewOverride={viewOverride?.func} />
                    </ErrorBoundary>}
            </div>
        );
    }

    const ctx = p.ctx;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.entityType)} onChange={forceUpdate} onRemove={handleTypeRemove} />
            {ctx.value.entityType && viewNames &&
                <FormGroup ctx={ctx.subCtx(d => d.viewName)} label={ctx.niceName(d => d.viewName)}>
                    {inputId => <select id={inputId} value={ctx.value.viewName ?? ""} className="form-select"
                        onChange={handleViewNameChange}>
                        <option value="">{" - "}</option>
                        {viewNames.map((v, i) => <option key={i} value={v}>{v}</option>)}
                    </select>}
                </FormGroup>}

            {ctx.value.entityType &&
                <div>
                    <br />
                    <div className="row">
                        <div className="col-sm-12">
                            {renderExampleEntity(ctx.value.entityType.cleanName)}
                            {renderEditor()}
                        </div>
                    </div>
                    <hr />
                    {renderTest()}
                </div>}
        </div>
    );
}

interface RenderWithReplacementsProps {
    entity: Entity;
    viewFunc: (ctx: TypeContext<Entity>) => React.ReactElement;
    viewOverride?: (vr: ViewReplacer<Entity>) => void;
}

/**
 * Render the example entity's real view, then run the override over the element tree it returned. Signum has
 * to patch the component itself (see the header); altea's ViewReplacer works on the OUTPUT, so this is the
 * whole preview.
 */
export function RenderWithReplacements(p: RenderWithReplacementsProps): React.ReactNode {

    const frame = { refreshCount: 0 } as EntityFrame;

    const ctx = new TypeContext<Entity>(
        undefined, { frame }, PropertyRoute.root(p.entity.constructor), new ReadonlyBinding(p.entity, "example"));

    const result = p.viewFunc(ctx);

    if (!p.viewOverride)
        return result;

    const replacer = new ViewReplacer<Entity>(result, ctx, p.viewFunc);
    p.viewOverride(replacer);
    return replacer.result;
}
