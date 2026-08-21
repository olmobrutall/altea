import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Dropdown } from "react-bootstrap";
import { classes } from "@altea/altea/data/globals";
import ContextMenu, { getMouseEventPosition, type ContextMenuPosition } from "@altea/altea/client/SearchControl/ContextMenu";
import * as NodeUtils from "./NodeUtils";
import NodeSelectorModal from "./NodeSelectorModal";
import type { DesignerNode } from "./NodeUtils";
import { type BaseNode, type ContainerNode, type LineBaseNode, NodeConstructor } from "./Nodes";
import { DynamicViewMessage } from "../../data/DynamicView";
import "./DynamicViewTree.css";

// Port of Signum.Dynamic's View/DynamicViewTree.tsx — verbatim: the node tree, its right-click menu (add
// child / add sibling / generate children / clear / remove) and drag-and-drop reordering, where a drop is
// colour-coded by whether it is legal (Ok), legal-but-suspect (Warning: the dragged line's field does not
// exist on the new parent) or illegal (Error: the parent is not a container, or the validParent/validChild
// constraint says no).
//
// altea divergences: `Array.insertAt` / `.remove` / `.clear` are Signum globals, spelled out with splice.

export interface DynamicViewTreeProps {
    rootNode: DesignerNode<BaseNode>;
}

export type DraggedPosition = "Top" | "Bottom" | "Middle";
export type DraggedError = "Error" | "Warning" | "Ok";

interface DraggedOverInfo {
    dn: DesignerNode<BaseNode>;
    position: DraggedPosition;
    error: DraggedError;
}

export function DynamicViewTree(p: DynamicViewTreeProps): React.JSX.Element {

    const [draggedNode, setDraggedNode] = React.useState<DesignerNode<BaseNode> | undefined>(undefined);
    const [draggedOver, setDraggedOver] = React.useState<DraggedOverInfo | undefined>(undefined);
    const [contextualMenu, setContextualMenu] = React.useState<{ position: ContextMenuPosition } | undefined>(undefined);

    function handleNodeTextContextMenu(n: DesignerNode<BaseNode>, e: React.MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();

        p.rootNode.context.setSelectedNode(n);
        setContextualMenu({ position: getMouseEventPosition(e as React.MouseEvent<HTMLTableElement>) });
    }

    function newNode(parent: DesignerNode<ContainerNode>): Promise<BaseNode | undefined> {
        return NodeSelectorModal.chooseElement(parent.node.kind).then(t => {

            if (!t)
                return undefined;

            const node: BaseNode = { kind: t.kind };

            if (t.isContainer)
                (node as ContainerNode).children = [];

            if (t.initialize)
                t.initialize(node, parent);

            return node;
        });
    }

    function handleAddChildren(): void {
        const parent = p.rootNode.context.getSelectedNode()! as DesignerNode<ContainerNode>;

        void newNode(parent).then(n => {
            if (!n)
                return;

            parent.node.children.push(n);
            p.rootNode.context.setSelectedNode(parent.createChild(n));
            parent.context.refreshView();
        });
    }

    function handleAddSibling(): void {
        const sibling = p.rootNode.context.getSelectedNode()!;
        const parent = sibling.parent! as DesignerNode<ContainerNode>;

        void newNode(parent).then(n => {
            if (!n)
                return;

            parent.node.children.splice(parent.node.children.indexOf(sibling.node) + 1, 0, n);
            p.rootNode.context.setSelectedNode(parent.createChild(n));
            parent.context.refreshView();
        });
    }

    function handleRemove(): void {
        const selected = p.rootNode.context.getSelectedNode()!;
        const parent = selected.parent as DesignerNode<ContainerNode>;

        const index = parent.node.children.indexOf(selected.node);
        if (index >= 0)
            parent.node.children.splice(index, 1);

        p.rootNode.context.setSelectedNode(parent);
        parent.context.refreshView();
    }

    function handleClearChildren(): void {
        const selected = p.rootNode.context.getSelectedNode()! as DesignerNode<ContainerNode>;
        selected.node.children.length = 0;
        selected.context.refreshView();
    }

    function handleGenerateChildren(): void {
        const selected = p.rootNode.context.getSelectedNode()! as DesignerNode<ContainerNode>;
        const route = selected.fixRoute()!;

        if (selected.node.kind === "EntityTable")
            selected.node.children.push(...NodeConstructor.createEntityTableSubChildren(route));
        else
            selected.node.children.push(...NodeConstructor.createSubChildren(route));

        selected.context.refreshView();
    }

    function renderContextualMenu(): React.ReactElement | null {
        const cm = contextualMenu!;
        const dn = p.rootNode.context.getSelectedNode();
        if (!dn)
            return null;

        const no = NodeUtils.registeredNodes[dn.node.kind]!;
        const cn = dn.node as ContainerNode;
        const isRoot = dn.node === p.rootNode.node;

        return (
            <ContextMenu position={cm.position} onHide={() => setContextualMenu(undefined)} itemsCount={cn.children?.length ?? 0}>
                {no.isContainer && <Dropdown.Item onClick={handleAddChildren}><FontAwesomeIcon icon="arrow-right" />&nbsp; {DynamicViewMessage.AddChild.niceToString()}</Dropdown.Item>}
                {!isRoot && <Dropdown.Item onClick={handleAddSibling}><FontAwesomeIcon icon="arrow-down" />&nbsp; {DynamicViewMessage.AddSibling.niceToString()}</Dropdown.Item>}

                {no.isContainer && <Dropdown.Divider />}

                {no.isContainer && (cn.children?.length ?? 0) === 0 && dn.route && <Dropdown.Item onClick={handleGenerateChildren}><FontAwesomeIcon icon="bolt" />&nbsp; {DynamicViewMessage.GenerateChildren.niceToString()}</Dropdown.Item>}
                {no.isContainer && (cn.children?.length ?? 0) > 0 && <Dropdown.Item onClick={handleClearChildren}><FontAwesomeIcon icon="trash" />&nbsp; {DynamicViewMessage.ClearChildren.niceToString()}</Dropdown.Item>}

                {!isRoot && <Dropdown.Divider />}
                {!isRoot && <Dropdown.Item onClick={handleRemove}><FontAwesomeIcon icon="xmark" />&nbsp; {DynamicViewMessage.Remove.niceToString()}</Dropdown.Item>}
            </ContextMenu>
        );
    }

    return (
        <div>
            <div className="dynamic-view-tree">
                <ul>
                    <DynamicViewNode
                        node={p.rootNode}
                        dynamicTreeView={{
                            draggedOver,
                            draggedNode,
                            setDraggedNode,
                            setDraggedOver,
                            handleNodeTextContextMenu,
                        }} />
                </ul>
            </div>
            {contextualMenu && renderContextualMenu()}
        </div>
    );
}

interface DynamicViewTreeHandle {
    draggedOver: DraggedOverInfo | undefined;
    draggedNode: DesignerNode<BaseNode> | undefined;
    setDraggedNode(node: DesignerNode<BaseNode> | undefined): void;
    setDraggedOver(node: DraggedOverInfo | undefined): void;
    handleNodeTextContextMenu(n: DesignerNode<BaseNode>, e: React.MouseEvent): void;
}

export interface DynamicViewNodeProps {
    node: DesignerNode<BaseNode>;
    dynamicTreeView: DynamicViewTreeHandle;
}

export function DynamicViewNode(p: DynamicViewNodeProps): React.JSX.Element {

    const [isOpened, setIsOpened] = React.useState(true);

    function renderIcon(): React.ReactNode {
        const c = p.node.node as ContainerNode;

        if (!c.children || c.children.length === 0)
            return <span className="place-holder" />;

        return (
            <span onClick={() => setIsOpened(!isOpened)} className="tree-icon">
                <FontAwesomeIcon icon={isOpened ? ["far", "square-minus"] : ["far", "square-plus"]}
                    title={isOpened ? "collapse" : "expand"} />
            </span>);
    }

    function handleDragStart(e: React.DragEvent): void {
        e.dataTransfer.setData("text", "start"); // cannot be an empty string
        e.dataTransfer.effectAllowed = "move";
        p.dynamicTreeView.setDraggedNode(p.node);
    }

    function getOffset(pageY: number, rect: DOMRect, margin: number): DraggedPosition {
        const height = Math.round(rect.height / 5) * 5;
        const offsetY = pageY - rect.top;

        if (offsetY < margin)
            return "Top";

        if (offsetY > (height - margin))
            return "Bottom";

        return "Middle";
    }

    function getError(position: DraggedPosition): DraggedError {
        const parent = position === "Middle" ? p.node : p.node.parent;

        if (!parent?.node)
            return "Error";

        const parentOptions = NodeUtils.registeredNodes[parent.node.kind]!;
        if (!parentOptions.isContainer)
            return "Error";

        const dragged = p.dynamicTreeView.draggedNode!;
        const draggedOptions = NodeUtils.registeredNodes[dragged.node.kind]!;
        if ((parentOptions.validChild && parentOptions.validChild !== dragged.node.kind)
            || (draggedOptions.validParent && draggedOptions.validParent !== parent.node.kind))
            return "Error";

        const draggedField = (dragged.node as LineBaseNode).field;
        if (draggedField && (parent.route == undefined || parent.route.subMembers()[draggedField] === undefined))
            return "Warning";

        return "Ok";
    }

    function handleDragOver(e: React.DragEvent): void {
        e.preventDefault();
        const de = e.nativeEvent as DragEvent;
        const dn = p.node;
        const span = e.currentTarget as HTMLElement;
        const newPosition = getOffset(de.pageY, span.getBoundingClientRect(), 7);
        const newError = getError(newPosition);

        const tree = p.dynamicTreeView;

        if (tree.draggedOver == null
            || tree.draggedOver.dn.node !== dn.node
            || tree.draggedOver.position !== newPosition
            || tree.draggedOver.error !== newError) {

            p.dynamicTreeView.setDraggedOver({ dn, position: newPosition, error: newError });
        }
    }

    function handleDragEnd(): void {
        p.dynamicTreeView.setDraggedOver(undefined);
        p.dynamicTreeView.setDraggedNode(undefined);
    }

    function handleDrop(): void {
        const dragged = p.dynamicTreeView.draggedNode!;
        const over = p.dynamicTreeView.draggedOver!;

        p.dynamicTreeView.setDraggedOver(undefined);
        p.dynamicTreeView.setDraggedNode(undefined);

        if (over.error === "Error")
            return;

        const cn = dragged.parent!.node as ContainerNode;
        const from = cn.children.indexOf(dragged.node);
        if (from >= 0)
            cn.children.splice(from, 1);

        if (over.position === "Middle") {
            (over.dn.node as ContainerNode).children.push(dragged.node);
            p.node.context.setSelectedNode(over.dn.createChild(dragged.node));
        } else {
            const parent = over.dn.parent!.node as ContainerNode;
            const index = parent.children.indexOf(over.dn.node);
            parent.children.splice(index + (over.position === "Top" ? 0 : 1), 0, dragged.node);
            p.node.context.setSelectedNode(over.dn.parent!.createChild(dragged.node));
        }
    }

    function getDragAndDropStyle(): React.CSSProperties | undefined {
        const dtv = p.dynamicTreeView;
        const dn = p.node;

        if (dtv.draggedNode == undefined)
            return undefined;

        if (dn.node === dtv.draggedNode.node)
            return { opacity: 0.5 };

        const over = dtv.draggedOver;

        if (over && dn.node === over.dn.node) {

            const color =
                over.error === "Error" ? "var(--bs-danger-bg-subtle)"
                    : over.error === "Warning" ? "var(--bs-warning-bg-subtle)"
                        : "var(--bs-success-bg-subtle)";

            if (over.position === "Top")
                return { borderTop: "2px dashed " + color };
            if (over.position === "Bottom")
                return { borderBottom: "2px solid " + color };

            return { backgroundColor: color };
        }

        return undefined;
    }

    const dn = p.node;
    const container = dn.node as ContainerNode;
    const error = NodeUtils.validate(dn, undefined);
    const tree = p.dynamicTreeView;
    const sn = dn.context.getSelectedNode();

    const className = classes("tree-label", sn && dn.node === sn.node && "tree-selected", error && "tree-error");

    return (
        <li>
            <div draggable={dn.parent != null}
                onDragStart={handleDragStart}
                onDragEnter={handleDragOver}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop}
                style={getDragAndDropStyle()}>

                {renderIcon()}
                <span
                    className={className}
                    title={error ?? undefined}
                    onClick={() => dn.context.setSelectedNode(dn)}
                    onContextMenu={e => tree.handleNodeTextContextMenu(dn, e)}>
                    {NodeUtils.registeredNodes[dn.node.kind]!.renderTreeNode(dn)}
                </span>
            </div>

            {container.children && container.children.length > 0 && isOpened &&
                <ul>
                    {container.children.map((c, i) =>
                        <DynamicViewNode
                            dynamicTreeView={tree}
                            key={i} node={dn.createChild(c)} />)}
                </ul>}
        </li>
    );
}
