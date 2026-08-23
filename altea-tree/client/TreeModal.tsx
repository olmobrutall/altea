import * as React from "react";
import { Modal } from "react-bootstrap";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { getTypeInfo } from "@altea/altea/client/Reflection";
import { FrameMessage } from "@altea/altea/data/uiMessages";
import type { Lite } from "@altea/altea/data/lite";
import type { TreeEntity, TreeNode } from "../data/Tree";
import type { TreeClient } from "./TreeClient";
import { TreeViewer } from "./TreeViewer";

// Port of Signum.Tree's TreeModal.tsx — the tree as a PICKER: what `TreeClient.overrideOnFind` opens when
// the user presses Find on a tree-typed EntityLine, instead of a search modal.
interface TreeModalProps extends IModalProps<TreeNode | undefined> {
    treeOptions: TreeClient.TreeOptions;
    title?: React.ReactNode;
}

function TreeModal(p: TreeModalProps): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const [show, setShow] = React.useState(true);

    const selectedNodeRef = React.useRef<TreeNode | undefined>(undefined);
    const okPressedRef = React.useRef<boolean>(false);
    const treeViewRef = React.useRef<TreeViewer>(null);

    function handleSelectedNode(selected: TreeNode | undefined): void {
        selectedNodeRef.current = selected;
        forceUpdate();
    }

    function handleCancelClicked(): void {
        okPressedRef.current = false;
        setShow(false);
    }

    function handleOnExited(): void {
        p.onExited!(okPressedRef.current ? selectedNodeRef.current : undefined);
    }

    function handleDoubleClick(selectedNode: TreeNode, e: React.MouseEvent): void {
        e.preventDefault();
        selectedNodeRef.current = selectedNode;
        okPressedRef.current = true;
        setShow(false);
    }

    return (
        <Modal size="lg" onHide={handleCancelClicked} show={show} onExited={handleOnExited}>
            <ModalHeaderButtons onClose={handleCancelClicked}>
                <span className="sf-entity-title">{p.title ?? getTypeInfo(p.treeOptions.typeName).getNicePluralName()}</span>
                &nbsp;
                <LinkButton className="sf-popup-fullscreen"
                    title={FrameMessage.Fullscreen.niceToString()}
                    onClick={e => treeViewRef.current?.handleFullScreenClick(e)}>
                    <span className="fa fa-external-link" />
                </LinkButton>
            </ModalHeaderButtons>

            <div className="modal-body">
                <TreeViewer ref={treeViewRef}
                    treeOptions={p.treeOptions}
                    avoidChangeUrl={true}
                    onSelectedNode={handleSelectedNode}
                    onDoubleClick={handleDoubleClick} />
            </div>
        </Modal>
    );
}

namespace TreeModalApi {
    export function open(treeOptions: TreeClient.TreeOptions, options?: TreeClient.TreeModalOptions): Promise<Lite<TreeEntity> | undefined> {
        return openModal<TreeNode | undefined>(<TreeModal treeOptions={treeOptions} title={options?.title} />)
            .then(tn => tn?.lite);
    }
}

export default TreeModalApi;
