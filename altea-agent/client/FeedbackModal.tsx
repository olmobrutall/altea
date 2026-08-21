import * as React from "react";
import { Modal } from "react-bootstrap";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { ChatbotMessage } from "../data/ChatSession";

// NEW in altea. Signum collects the "what went wrong?" note with
// `AutoLineModal.show({ propertyRoute: ChatMessageEntity.propertyRouteAssert(a => a.userFeedbackMessage), … })`
// — a generic "edit one value in a modal" component altea does not port. This is that one modal, spelled out:
// a multi-line note, resolving to the text or to `undefined` when cancelled (the contract Message.tsx expects).
interface FeedbackModalProps extends IModalProps<string | undefined> {
    initialValue: string;
}

function FeedbackModal(p: FeedbackModalProps): React.JSX.Element {
    const [show, setShow] = React.useState(true);
    const [value, setValue] = React.useState(p.initialValue);
    const answerRef = React.useRef<string | undefined>(undefined);

    function handleOk(): void {
        answerRef.current = value;
        setShow(false);
    }

    return (
        <Modal show={show} onHide={() => setShow(false)} onExited={() => p.onExited!(answerRef.current)} size="lg">
            <Modal.Header closeButton>
                <Modal.Title>{ChatbotMessage.ProvideFeedback.niceToString()}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <p>{ChatbotMessage.WhatWentWrong.niceToString()}</p>
                <textarea className="form-control" rows={4} autoFocus value={value}
                    maxLength={1000}
                    onChange={e => setValue(e.currentTarget.value)} />
            </Modal.Body>
            <Modal.Footer>
                <button type="button" className="btn btn-primary" onClick={handleOk}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
                <button type="button" className="btn btn-light" onClick={() => setShow(false)}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </Modal.Footer>
        </Modal>
    );
}

FeedbackModal.show = (initialValue: string): Promise<string | undefined> =>
    openModal<string | undefined>(<FeedbackModal initialValue={initialValue} />);

export default FeedbackModal;
