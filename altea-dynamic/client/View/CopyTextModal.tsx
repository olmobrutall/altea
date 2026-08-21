import * as React from "react";
import { Modal } from "react-bootstrap";
import { ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";

// Signum's designer uses `AutoLineModal.show({ customComponent: TextAreaLine, message: "Copy to clipboard:
// Ctrl+C, ESC" })` in three places, purely as a "here is a snippet, take it" dialog. altea has no
// AutoLineModal, so this is the same dialog written directly — the text pre-selected so Ctrl+C works
// immediately, plus a copy button, which is what the Signum message asked the user to do by hand.
interface CopyTextModalProps extends IModalProps<undefined> {
    title: React.ReactNode;
    text: string;
}

export function CopyTextModal(p: CopyTextModalProps): React.JSX.Element {

    const [show, setShow] = React.useState(true);
    const textAreaRef = React.useRef<HTMLTextAreaElement>(null);

    React.useEffect(() => {
        textAreaRef.current?.select();
    }, []);

    function handleCopy(): void {
        textAreaRef.current?.select();
        void navigator.clipboard?.writeText(p.text);
    }

    return (
        <Modal onHide={() => setShow(false)} show={show} onExited={() => p.onExited!(undefined)}>
            <ModalHeaderButtons>
                {p.title}
            </ModalHeaderButtons>
            <div className="modal-body">
                <textarea ref={textAreaRef} className="form-control" style={{ height: "200px" }}
                    readOnly value={p.text} />
                <button type="button" className="btn btn-sm btn-light mt-2" onClick={handleCopy}>
                    Copy to clipboard
                </button>
            </div>
        </Modal>
    );
}

export namespace CopyTextModal {
    export function show(title: React.ReactNode, text: string): Promise<undefined> {
        return openModal<undefined>(<CopyTextModal title={title} text={text} />);
    }
}
