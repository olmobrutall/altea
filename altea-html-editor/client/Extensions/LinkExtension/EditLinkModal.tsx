import * as React from "react";
import { Modal } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { HtmlEditorMessage } from "../../../data/HtmlEditor";

// Replaces Signum's `EditLinkField.tsx` + its `AutoLineModal.show({ customComponent })` call.
//
// altea does not port AutoLineModal (a generic "edit one value in a modal" host), so the url prompt is this
// one small modal instead. It keeps the two behaviours the Signum pair had: type a url and confirm, or clear
// the field (the ⌫ button, or an empty OK) to UNLINK — which is why the result distinguishes "" (unlink) from
// undefined (cancelled, change nothing).
interface EditLinkModalProps extends IModalProps<string | undefined> {
    initialUrl: string;
}

function EditLinkModal(p: EditLinkModalProps): React.JSX.Element {
    const [show, setShow] = React.useState(true);
    const [url, setUrl] = React.useState(p.initialUrl);
    const answerRef = React.useRef<string | undefined>(undefined);

    function accept(value: string): void {
        answerRef.current = value;
        setShow(false);
    }

    return (
        <Modal show={show} onHide={() => setShow(false)} onExited={() => p.onExited!(answerRef.current)}>
            <Modal.Header closeButton>
                <Modal.Title>{HtmlEditorMessage.Hyperlink.niceToString()}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <div className="input-group">
                    <input type="text" className="form-control" autoFocus value={url}
                        placeholder={HtmlEditorMessage.EnterYourUrlHere.niceToString()}
                        onChange={e => setUrl(e.currentTarget.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                accept(url);
                            }
                        }} />
                    <button type="button" className="input-group-text"
                        title={HtmlEditorMessage.RemoveLink.niceToString()}
                        onClick={() => accept("")}>
                        <FontAwesomeIcon icon="xmark" />
                    </button>
                </div>
            </Modal.Body>
            <Modal.Footer>
                <button type="button" className="btn btn-primary" onClick={() => accept(url)}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
                <button type="button" className="btn btn-light" onClick={() => setShow(false)}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </Modal.Footer>
        </Modal>
    );
}

EditLinkModal.show = (initialUrl: string): Promise<string | undefined> =>
    openModal<string | undefined>(<EditLinkModal initialUrl={initialUrl} />);

export default EditLinkModal;
