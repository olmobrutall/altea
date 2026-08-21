import * as React from "react";
import { Modal } from "react-bootstrap";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { Operations } from "@altea/altea/client/Operations";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { AgentSymbol, SkillCustomizationOperation } from "../../data/SkillCustomization";
import type { SkillCodeInfo } from "../../data/ChatbotProtocol";
import { AgentClient } from "../AgentClient";
import { SkillCodeView } from "./SkillCode";

// Port of Signum.Agent's Templates/Agent.tsx — an agent is just a NAME plus an optional DB overlay, so the
// whole editor is one EntityLine, whose create button runs CreateFromAgent (which captures the code default
// as an editable customization) and immediately saves it.
export default function Agent(p: { ctx: TypeContext<AgentSymbol> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();

    const defaultInfo = useAPI(() => ctx.value.skillCustomization == null && ctx.value.key != null
        ? AgentClient.API.getDefaultAgentSkillCodeInfo(ctx.value.key)
        : Promise.resolve(undefined),
        [ctx.value.skillCustomization, ctx.value.key]);

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.skillCustomization, { labelColumns: { sm: 4 } })}
                onChange={forceUpdate}
                create={true} viewOnCreate={false}
                onCreate={() => Operations.API.constructFromLite(ctx.value.toLite(), SkillCustomizationOperation.CreateFromAgent)
                    .then(pack => Operations.API.executeEntity(pack!.entity, SkillCustomizationOperation.Save))
                    .then(pack => pack.entity)}
                helpText={defaultInfo
                    ? <a href="#" onClick={e => { e.preventDefault(); void DefaultSkillInfoModal.show(defaultInfo, ctx.value.key); }}>
                        View defaults
                    </a>
                    : undefined} />
        </div>
    );
}

interface DefaultSkillInfoModalProps extends IModalProps<void> {
    info: SkillCodeInfo;
    title: string;
}

function DefaultSkillInfoModal(p: DefaultSkillInfoModalProps): React.JSX.Element {
    const [show, setShow] = React.useState(true);

    return (
        <Modal show={show} onHide={() => setShow(false)} onExited={() => p.onExited!(undefined)} size="lg">
            <Modal.Header closeButton>
                <Modal.Title>{p.title}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <SkillCodeView info={p.info} />
            </Modal.Body>
        </Modal>
    );
}

DefaultSkillInfoModal.show = (info: SkillCodeInfo, title: string): Promise<void> =>
    openModal<void>(<DefaultSkillInfoModal info={info} title={title} />);
