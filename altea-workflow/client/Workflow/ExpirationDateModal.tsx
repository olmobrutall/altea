import * as React from "react";
import { Modal } from "react-bootstrap";
import { ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Temporal } from "@altea/altea/data/basics";

// Signum asks for the workflow's expiration date with `AutoLineModal.show({ type: { name: "DateTime" }, … })`.
// altea has no AutoLineModal (the same gap altea-auth's ActiveDirectoryClient and altea-dynamic's
// CopyTextModal already work around), so this is that one dialog written directly: a datetime input, an OK
// that answers a `Temporal.PlainDateTime`, and a cancel that answers undefined.

interface ExpirationDateModalProps extends IModalProps<Temporal.PlainDateTime | undefined> {
    title: React.ReactNode;
    message: React.ReactNode;
}

function ExpirationDateModal(p: ExpirationDateModalProps): React.JSX.Element {

    const [show, setShow] = React.useState(true);
    const [value, setValue] = React.useState<string>("");
    const answerRef = React.useRef<Temporal.PlainDateTime | undefined>(undefined);

    function handleOk(): void {
        // An `<input type="datetime-local">` answers "YYYY-MM-DDTHH:mm" — exactly a PlainDateTime literal.
        answerRef.current = value === "" ? undefined : Temporal.PlainDateTime.from(value);
        setShow(false);
    }

    return (
        <Modal onHide={() => setShow(false)} show={show} onExited={() => p.onExited!(answerRef.current)}>
            <ModalHeaderButtons onClose={() => setShow(false)}>
                {p.title}
            </ModalHeaderButtons>
            <div className="modal-body">
                {p.message}
                <input type="datetime-local" className="form-control" autoFocus
                    value={value} onChange={e => setValue(e.currentTarget.value)} />
            </div>
            <div className="modal-footer">
                <button className="btn btn-primary sf-entity-button sf-ok-button" disabled={value === ""}
                    onClick={handleOk}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
                <button className="btn btn-light sf-entity-button sf-close-button"
                    onClick={() => setShow(false)}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

namespace ExpirationDateModal {
    export function show(options: { title: React.ReactNode, message: React.ReactNode }):
        Promise<Temporal.PlainDateTime | undefined> {
        return openModal<Temporal.PlainDateTime | undefined>(
            <ExpirationDateModal title={options.title} message={options.message} />);
    }
}

export default ExpirationDateModal;
