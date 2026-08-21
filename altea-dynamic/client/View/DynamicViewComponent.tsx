import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Dropdown } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage, SaveChangesMessage } from "@altea/altea/data/uiMessages";
import { Navigator } from "@altea/altea/client/Navigator";
import type { ViewOverride } from "@altea/altea/client/EntitySettings";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { Operations } from "@altea/altea/client/Operations";
import { getOperationInfos } from "@altea/altea/client/Reflection";
import type { BaseEntity } from "@altea/altea/data/entity";
import { useAPI, useUpdatedRef } from "@altea/altea/client/Hooks";
import type { BaseNode } from "./Nodes";
import { type DesignerContext, DesignerNode, RenderWithViewOverrides } from "./NodeUtils";
import { DynamicViewClient } from "../DynamicViewClient";
import { DynamicViewTabs } from "./DynamicViewTabs";
import ShowCodeModal from "./ShowCodeModal";
import { DynamicViewEntity, DynamicViewOperation } from "../../data/DynamicView";
import "./DynamicView.css";

// Port of Signum.Dynamic's View/DynamicViewComponent.tsx — the component a stored view RESOLVES TO: it
// interprets the node tree on the right, and (unless the type is read-only) offers the designer on the left.
// This is the piece that makes the feature feel like a feature: you are looking at the real entity, editing
// the view that renders it, in place.
//
// altea divergences, documented inline:
//  - `ctx.value.Type` → the constructor's `typeName` static (altea has no `.Type` compat accessor).
//  - `initialDynamicView.props.toObject(mle => …)` — no MList wrapper, so the `@part` rows are mapped
//    directly.
//  - `CollapsableTypeHelp` is not ported (it embeds Signum.Eval's TypeHelpComponent — see Designer.tsx).
//  - `Operations.operationInfos(getTypeInfo(T))` → `getOperationInfos(T)`, and an operation's label comes
//    from the metadata blob's `niceName`.
//  - `entity.modified = true` has no counterpart: altea tracks modification against a SNAPSHOT, so writing
//    the field IS the modification.

export interface DynamicViewComponentProps {
    ctx: TypeContext<BaseEntity>;
    initialDynamicView: DynamicViewEntity;
    ref?: React.Ref<unknown>;
}

export default function DynamicViewComponent(p: DynamicViewComponentProps): React.JSX.Element | null {

    const [isDesignerOpen, setIsDesignerOpen] = React.useState(false);
    const rootNodeMemo = React.useMemo(() => JSON.parse(p.initialDynamicView.viewContent) as BaseNode, []);

    const [rootNode, setRootNode] = React.useState<BaseNode>(() => rootNodeMemo);
    const [selectedNode, setSelectedNode] = React.useState<DesignerNode<BaseNode>>(() => getZeroNode().createChild(rootNodeMemo));
    const selectedNodeRef = useUpdatedRef(selectedNode);
    const [dynamicView, setDynamicView] = React.useState<DynamicViewEntity>(p.initialDynamicView);

    const typeName = typeNameOf(p.ctx.value);

    const viewOverrides = useAPI(() => Navigator.getViewDispatcher().getViewOverrides(typeName), []);

    function getZeroNode(): DesignerNode<BaseNode> {
        const { ctx, initialDynamicView, ref, ...extraProps } = p;
        void ref;

        const context: DesignerContext = {
            onClose: handleClose,
            refreshView: () => { setSelectedNode(selectedNodeRef.current.reCreateNode()); },
            getSelectedNode: () => isDesignerOpen ? selectedNodeRef.current : undefined,
            setSelectedNode: newNode => setSelectedNode(newNode),
            props: extraProps as Record<string, unknown>,
            propTypes: Object.fromEntries((initialDynamicView.props ?? []).map(pr => [pr.name, pr.type])),
            locals: {},
            localsCode: initialDynamicView.locals,
        };

        return DesignerNode.zero(context, typeNameOf(ctx.value));
    }

    function handleReload(dv: DynamicViewEntity): void {
        setDynamicView(dv);
        const newRoot = JSON.parse(dv.viewContent) as BaseNode;
        setRootNode(newRoot);
        setSelectedNode(getZeroNode().createChild(newRoot));
    }

    function handleClose(): void {
        setIsDesignerOpen(false);
    }

    function handleLoseChanges(): Promise<boolean> {
        const node = JSON.stringify(rootNode);

        if (dynamicView.isNew || node !== dynamicView.viewContent) {
            return MessageModal.show({
                title: SaveChangesMessage.ThereAreChanges.niceToString(),
                message: JavascriptMessage.loseCurrentChanges.niceToString(),
                buttons: "yes_no",
                style: "warning",
                icon: "warning",
            }).then(result => result === "yes");
        }

        return Promise.resolve(true);
    }

    const desRootNode = getZeroNode().createChild(rootNode);
    const ctx = p.ctx;

    if (viewOverrides == null)
        return null;

    const vos = viewOverrides.filter(a => a.viewName == dynamicView.viewName) as ViewOverride<BaseEntity>[];

    if (Navigator.isReadOnly(DynamicViewEntity)) {
        return (
            <div className="design-content">
                <RenderWithViewOverrides dn={desRootNode} parentCtx={ctx} vos={vos} />
            </div>
        );
    }

    return (
        <div className="design-main">
            <div className={classes("design-left", isDesignerOpen && "open")}>
                {!isDesignerOpen
                    ? <span onClick={() => setIsDesignerOpen(true)}>
                        <FontAwesomeIcon icon={["fas", "pen-to-square"]} title="Open view designer" className="design-open-icon" />
                    </span>
                    : <DynamicViewDesigner
                        rootNode={desRootNode}
                        dynamicView={dynamicView}
                        onReload={handleReload}
                        onLoseChanges={handleLoseChanges}
                        typeName={typeName} />}
            </div>
            <div className={classes("design-content", isDesignerOpen && "open")}>
                <RenderWithViewOverrides dn={desRootNode} parentCtx={ctx} vos={vos} />
            </div>
        </div>);
}

function typeNameOf(entity: BaseEntity): string {
    return (entity.constructor as unknown as { typeName: string }).typeName;
}

interface DynamicViewDesignerProps {
    rootNode: DesignerNode<BaseNode>;
    dynamicView: DynamicViewEntity;
    onLoseChanges: () => Promise<boolean>;
    onReload: (dynamicView: DynamicViewEntity) => void;
    typeName: string;
}

function DynamicViewDesigner(p: DynamicViewDesignerProps): React.JSX.Element {

    const [viewNames, setViewNames] = React.useState<string[] | undefined>(undefined);
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);

    function reload(entity: DynamicViewEntity): void {
        setViewNames(undefined);
        p.onReload(entity);
    }

    function handleSave(): void {
        p.dynamicView.viewContent = JSON.stringify(p.rootNode.node);

        void Operations.API.executeEntity(p.dynamicView, DynamicViewOperation.Save)
            .then(pack => {
                reload(pack.entity);
                DynamicViewClient.cleanCaches();
                return Operations.notifySuccess();
            });
    }

    function handleCreate(): void {
        void p.onLoseChanges().then(goahead => {
            if (!goahead)
                return;

            void DynamicViewClient.createDefaultDynamicView(p.typeName)
                .then(entity => { reload(entity); return Operations.notifySuccess(); });
        });
    }

    function handleClone(): void {
        void p.onLoseChanges().then(goahead => {
            if (!goahead)
                return;

            void Operations.API.constructFromEntity(p.dynamicView, DynamicViewOperation.Clone)
                .then(pack => { reload(pack!.entity); return Operations.notifySuccess(); });
        });
    }

    function handleChangeView(viewName: string): void {
        void p.onLoseChanges().then(goahead => {
            if (!goahead)
                return;

            void DynamicViewClient.API.getDynamicView(p.typeName, viewName).then(entity => reload(entity));
        });
    }

    function handleOnToggle(): void {
        if (!isDropdownOpen && !viewNames)
            void DynamicViewClient.API.getDynamicViewNames(p.typeName).then(vn => setViewNames(vn));

        setIsDropdownOpen(!isDropdownOpen);
    }

    function handleShowCode(): void {
        void ShowCodeModal.showCode(p.typeName, p.rootNode.node);
    }

    function renderButtonBar(): React.JSX.Element {
        const operations = Object.fromEntries(getOperationInfos(DynamicViewEntity).map(a => [a.key, a]));

        return (
            <div className="btn-group btn-group-sm" role="group" style={{ marginBottom: "5px" }}>
                {operations[DynamicViewOperation.Save.key] &&
                    <button type="button" className="btn btn-primary" onClick={handleSave}>
                        {operations[DynamicViewOperation.Save.key]!.niceName}
                    </button>}
                <button type="button" className="btn btn-success" onClick={handleShowCode}>Show code</button>
                <Dropdown onToggle={handleOnToggle} show={isDropdownOpen}>
                    <Dropdown.Toggle id="bg-nested-dropdown" size="sm">
                        {" … "}
                    </Dropdown.Toggle>
                    <Dropdown.Menu>
                        {operations[DynamicViewOperation.Create.key] &&
                            <Dropdown.Item onClick={handleCreate}>{operations[DynamicViewOperation.Create.key]!.niceName}</Dropdown.Item>}
                        {operations[DynamicViewOperation.Clone.key] && !p.dynamicView.isNew &&
                            <Dropdown.Item onClick={handleClone}>{operations[DynamicViewOperation.Clone.key]!.niceName}</Dropdown.Item>}
                        {viewNames && viewNames.length > 0 && <Dropdown.Divider />}
                        {viewNames?.map(vn =>
                            <Dropdown.Item key={vn}
                                className={classes("sf-dynamic-view", vn === p.dynamicView.viewName && "active")}
                                onClick={() => handleChangeView(vn)}>
                                {vn}
                            </Dropdown.Item>)}
                    </Dropdown.Menu>
                </Dropdown>
            </div>
        );
    }

    const dv = p.dynamicView;
    const ctx = TypeContext.root(dv);

    return (
        <div className="code-container">
            <button type="button" className="btn-close" aria-label="Close" style={{ float: "right" }}
                onClick={p.rootNode.context.onClose} />
            <h3>
                <small>{Navigator.getTypeSubTitle(p.dynamicView, undefined)}</small>
            </h3>
            <AutoLine ctx={ctx.subCtx(e => e.viewName)} formGroupStyle="SrOnly" placeholderLabels={true} />
            {renderButtonBar()}
            <DynamicViewTabs ctx={ctx} rootNode={p.rootNode} />
        </div>
    );
}
