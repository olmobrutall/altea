import * as React from "react";
import { Modal } from "react-bootstrap";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useAPI } from "@altea/altea/client/Hooks";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { Enum } from "@altea/altea/data/enum";
import { SkillActivationEnum, SkillCodeEntity } from "../../data/SkillCustomization";
import type { SkillCodeInfo, SubSkillInfo, ToolInfo } from "../../data/ChatbotProtocol";
import { AgentClient } from "../AgentClient";
import ChatMarkdown from "./ChatMarkdown";

// Port of Signum.Agent's Templates/SkillCode.tsx — the read-only view of what a skill class does BY DEFAULT:
// its instructions, its configurable properties, its tools and its sub-skills (each openable in a modal).
//
// altea divergence: `SkillActivation.niceToString(x)` → `Enum.niceName(SkillActivationEnum, x)` (altea's enum
// display API takes the enum object).
export default function SkillCode(p: { ctx: TypeContext<SkillCodeEntity> }): React.JSX.Element {
    const ctx = p.ctx;

    const info = useAPI(() => ctx.value.className
        ? AgentClient.API.getSkillCodeInfo(ctx.value.className)
        : Promise.resolve(undefined), [ctx.value.className]);

    return (
        <div>
            <h5>{ctx.value.className}</h5>
            {info && <SkillCodeView info={info} />}
        </div>
    );
}

export function SkillCodeView(p: { info: SkillCodeInfo }): React.JSX.Element {
    return (
        <div className="skill-code-view">
            {p.info.defaultShortDescription && (
                <p className="text-muted fst-italic">{p.info.defaultShortDescription}</p>
            )}
            <div className="border rounded p-2 small">
                <ChatMarkdown content={p.info.defaultInstructions} />
            </div>
            {p.info.properties.length > 0 && (
                <div className="mt-2">
                    <strong className="small">Properties</strong>
                    <table className="table table-sm table-borderless small mb-1">
                        <tbody>
                            {p.info.properties.map((prop, i) => (
                                <tr key={i}>
                                    <td className="fw-semibold text-nowrap">{prop.propertyName}</td>
                                    <td className="text-muted text-nowrap">{prop.propertyType}</td>
                                    <td>{prop.defaultValue ?? <span className="text-muted fst-italic">null</span>}</td>
                                    {prop.valueHint && <td className="text-muted fst-italic">{prop.valueHint}</td>}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <ToolsView tools={p.info.tools} />
            {p.info.subSkills.length > 0 && (
                <div className="mt-2">
                    <strong className="small d-block mb-1">Sub Skills</strong>
                    <table className="table table-sm table-borderless small mb-0">
                        <tbody>
                            {p.info.subSkills.map((ss, i) => (
                                <tr key={i}>
                                    <td className="text-nowrap pe-2"><SubSkillLink subSkill={ss} /></td>
                                    <td className="text-muted text-nowrap">{Enum.niceName(SkillActivationEnum, ss.activation)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

export function ToolsView(p: { tools: ToolInfo[] }): React.JSX.Element | null {
    if (!p.tools || p.tools.length === 0)
        return null;

    return (
        <div className="mt-2">
            <strong className="small">Tools</strong>
            {p.tools.map((tool, i) => (
                <div key={i} className="border rounded px-2 py-1 mb-1 small font-monospace">
                    <span className="fw-semibold text-primary">{tool.mcpName}</span>
                    <span className="text-muted">(</span>
                    {tool.parameters.map((param, j) => (
                        <span key={j}>
                            {j > 0 && <span className="text-muted">, </span>}
                            <span className={param.isRequired ? "" : "text-muted"}>{param.name}</span>
                            <span className="text-muted">: {param.type}</span>
                        </span>
                    ))}
                    <span className="text-muted">): {tool.returnType}</span>
                    {tool.description && <div className="text-muted fst-italic fw-normal">{tool.description}</div>}
                </div>
            ))}
        </div>
    );
}

function SubSkillLink(p: { subSkill: SubSkillInfo }): React.JSX.Element {
    return (
        <a href="#" className="text-decoration-none"
            onClick={e => { e.preventDefault(); void SubSkillModal.show(p.subSkill); }}>
            {p.subSkill.className}
        </a>
    );
}

interface SubSkillModalProps extends IModalProps<void> {
    subSkill: SubSkillInfo;
}

function SubSkillModal(p: SubSkillModalProps): React.JSX.Element {
    const [show, setShow] = React.useState(true);

    return (
        <Modal show={show} onHide={() => setShow(false)} onExited={() => p.onExited!(undefined)} size="lg">
            <Modal.Header closeButton>
                <Modal.Title>{p.subSkill.className}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <SkillCodeView info={p.subSkill.info} />
            </Modal.Body>
        </Modal>
    );
}

SubSkillModal.show = (subSkill: SubSkillInfo): Promise<void> =>
    openModal<void>(<SubSkillModal subSkill={subSkill} />);
