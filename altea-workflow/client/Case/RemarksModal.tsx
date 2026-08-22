import * as React from "react";
import { Modal } from "react-bootstrap";
import { ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";

// Signum asks for a notification's personal remarks with `AutoLineModal.show({ type: { name: "string" },
// customComponent: TextAreaLine, … })`. altea has no AutoLineModal, so this is that dialog written directly —
// the same shape as ../Workflow/ExpirationDateModal, and as altea-dynamic's CopyTextModal.
//
// It answers `undefined` on cancel and the (possibly empty) text on OK, which is the three-way Signum relies
// on: clearing the remarks is a real answer, not a cancel.

interface RemarksModalProps extends IModalProps<string | null | undefined> {
    title: React.ReactNode;
    message: React.ReactNode;
    initialValue: string | null;
}

function RemarksModal(p: RemarksModalProps): React.JSX.Element {

    const [show, setShow] = React.useState(true);
    const [value, setValue] = React.useState<string>(p.initialValue ?? "");
    const answerRef = React.useRef<string | null | undefined>(undefined);

    function handleOk(): void {
        answerRef.current = value === "" ? null : value;
        setShow(false);
    }

    return (
        <Modal onHide={() => setShow(false)} show={show} onExited={() => p.onExited!(answerRef.current)}>
            <ModalHeaderButtons onClose={() => setShow(false)}>
                {p.title}
            </ModalHeaderButtons>
            <div className="modal-body">
                <p>{p.message}</p>
                <textarea className="form-control" style={{ height: "150px" }} autoFocus
                    value={value} onChange={e => setValue(e.currentTarget.value)} />
            </div>
            <div className="modal-footer">
                <button className="btn btn-primary sf-entity-button sf-ok-button" onClick={handleOk}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
                <button className="btn btn-light sf-entity-button sf-close-button" onClick={() => setShow(false)}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

namespace RemarksModal {
    export function show(options: { title: React.ReactNode, message: React.ReactNode, initialValue: string | null }):
        Promise<string | null | undefined> {
        return openModal<string | null | undefined>(
            <RemarksModal title={options.title} message={options.message} initialValue={options.initialValue} />);
    }
}

export default RemarksModal;
