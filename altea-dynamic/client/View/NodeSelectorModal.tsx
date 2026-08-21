import * as React from "react";
import { Modal } from "react-bootstrap";
import { Dic } from "@altea/altea/data/globals";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import * as NodeUtils from "./NodeUtils";
import type { BaseNode } from "./Nodes";
import { DynamicViewMessage } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/NodeSelectorModal.tsx — the "add node" picker: every registered node with a
// group, laid out in three columns of grouped buttons. A container that declares `validChild` skips the modal
// entirely, because there is only one legal answer (a Row takes Columns, a Tabs takes Tabs).
//
// altea divergence: `groupBy` / `groupsOf` / `orderBy` are Signum array globals; spelled out.

function NodeSelectorModal(p: IModalProps<NodeUtils.NodeOptions<BaseNode> | undefined>): React.JSX.Element {

    const [show, setShow] = React.useState(true);
    const selectedValue = React.useRef<NodeUtils.NodeOptions<BaseNode> | undefined>(undefined);

    function handleButtonClicked(val: NodeUtils.NodeOptions<BaseNode>): void {
        selectedValue.current = val;
        setShow(false);
    }

    function handleCancelClicked(): void {
        setShow(false);
    }

    function handleOnExited(): void {
        p.onExited!(selectedValue.current);
    }

    const nodes = Dic.getValues(NodeUtils.registeredNodes).filter(n => n.group != null);

    // group by `group`, keeping first-seen order
    const groups: { key: string; elements: NodeUtils.NodeOptions<BaseNode>[] }[] = [];
    for (const n of nodes) {
        let g = groups.find(a => a.key === n.group);
        if (g == undefined) {
            g = { key: n.group!, elements: [] };
            groups.push(g);
        }
        g.elements.push(n);
    }

    for (const g of groups)
        g.elements.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // then split the groups into three columns of roughly equal weight (Signum's `groupsOf`)
    const perColumn = Math.max(1, Math.ceil(nodes.length / 3));
    const columns: typeof groups[] = [];
    let current: typeof groups = [];
    let currentCount = 0;
    for (const g of groups) {
        if (currentCount > 0 && currentCount + g.elements.length > perColumn) {
            columns.push(current);
            current = [];
            currentCount = 0;
        }
        current.push(g);
        currentCount += g.elements.length;
    }
    if (current.length > 0)
        columns.push(current);

    return (
        <Modal size="lg" onHide={handleCancelClicked} show={show} onExited={handleOnExited} className="sf-selector-modal">
            <ModalHeaderButtons onClose={handleCancelClicked}>
                {DynamicViewMessage.SelectATypeOfComponent.niceToString()}
            </ModalHeaderButtons>
            <div className="modal-body">
                <div className="row">
                    {columns.map((c, i) =>
                        <div key={i} className={"col-sm-" + Math.floor(12 / columns.length)}>
                            {c.map(gr => <fieldset key={gr.key}>
                                <legend>{gr.key}</legend>
                                {gr.elements.map(n =>
                                    <button key={n.kind} type="button" onClick={() => handleButtonClicked(n)}
                                        className="sf-chooser-button sf-close-button btn btn-light">
                                        {n.kind}
                                    </button>)}
                            </fieldset>)}
                        </div>)}
                </div>
            </div>
        </Modal>
    );
}

namespace NodeSelectorModal {
    export function chooseElement(parentNode: string): Promise<NodeUtils.NodeOptions<BaseNode> | undefined> {
        const o = NodeUtils.registeredNodes[parentNode];
        if (o?.validChild)
            return Promise.resolve(NodeUtils.registeredNodes[o.validChild]);

        return openModal<NodeUtils.NodeOptions<BaseNode>>(<NodeSelectorModal />);
    }
}

export default NodeSelectorModal;
