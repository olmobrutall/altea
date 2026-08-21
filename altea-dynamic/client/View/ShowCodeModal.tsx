import * as React from "react";
import { Modal } from "react-bootstrap";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import * as NodeUtils from "./NodeUtils";
import type { BaseNode } from "./Nodes";

// Port of Signum.Dynamic's View/ShowCodeModal.tsx — prints the view as the SOURCE of an equivalent
// hand-written component, so a dynamic view that has settled down can be moved into the codebase. It is also
// the only consumer of every node's `renderCode`.
//
// altea divergences: the import block is altea's (there is no `@framework` barrel — a Line is imported from
// its own module, and `getMixin(e, X)` is `e.mixin(X)`), and the ctx type is the entity class itself.

interface ShowCodeModalProps extends IModalProps<undefined> {
    typeName: string;
    node: BaseNode;
}

function ShowCodeModal(p: ShowCodeModalProps): React.JSX.Element {

    const [show, setShow] = React.useState(true);

    return (
        <Modal size="lg" onHide={() => setShow(false)} show={show} onExited={() => p.onExited!(undefined)}
            className="sf-selector-modal">
            <div className="modal-header">
                <h5 className="modal-title">{p.typeName + "Component code"}</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                <pre>
                    {renderFile(p.typeName, p.node)}
                </pre>
            </div>
        </Modal>
    );
}

namespace ShowCodeModal {
    export function showCode(typeName: string, node: BaseNode): Promise<undefined> {
        return openModal<undefined>(<ShowCodeModal typeName={typeName} node={node} />);
    }
}

export default ShowCodeModal;

function indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text.split("\n").map(l => pad + l).join("\n");
}

function renderFile(typeName: string, node: BaseNode): string {

    const cc = new NodeUtils.CodeContext("ctx", [], {}, []);

    const text = indent(NodeUtils.renderCode(node, cc), 4);

    const assignments = Object.entries(cc.assignments).map(([k, v]) => `const ${k} = ${v};`).join("\n");
    const extraImports = [...new Set(cc.imports)].join("\n");

    return `import * as React from 'react'
import type { TypeContext } from '@altea/altea/client/TypeContext'
import { AutoLine } from '@altea/altea/client/Lines/AutoLine'
import { EntityLine } from '@altea/altea/client/Lines/EntityLine'
import { EntityCombo } from '@altea/altea/client/Lines/EntityCombo'
import { EntityDetail } from '@altea/altea/client/Lines/EntityDetail'
import { EntityStrip } from '@altea/altea/client/Lines/EntityStrip'
import { EntityRepeater } from '@altea/altea/client/Lines/EntityRepeater'
import { EntityTabRepeater } from '@altea/altea/client/Lines/EntityTabRepeater'
import { EntityCheckboxList } from '@altea/altea/client/Lines/EntityCheckboxList'
import { EntityTable } from '@altea/altea/client/Lines/EntityTable'
import { RenderEntity } from '@altea/altea/client/Lines/RenderEntity'
import SearchControl from '@altea/altea/client/SearchControl/SearchControl'
import SearchValueLine from '@altea/altea/client/SearchControl/SearchValueLine'
import { ${typeName}Entity } from '[your entity module]'
${extraImports}

export default function ${typeName}(p: { ctx: TypeContext<${typeName}Entity> }): React.JSX.Element {
  const ctx = p.ctx;
${indent(assignments, 2)}
  return (
${text}
  );
}`;
}
