import * as React from "react";
import { Modal, ProgressBar } from "react-bootstrap";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import type { Operations } from "@altea/altea/client/Operations";
import { jsonObjectStream } from "@altea/altea/client/Operations/jsonObjectStream";
import { useForceUpdate, useThrottle } from "@altea/altea/client/Hooks";
import { EntityControlMessage, JavascriptMessage, OperationMessage } from "@altea/altea/data/uiMessages";
import { softCast } from "@altea/altea/data/globals";
import ErrorModal from "@altea/altea/client/Modals/ErrorModal";
import { RemoteEmailMessageMessage } from "../../data/RemoteEmailMessage";
import type { EmailResult } from "./RemoteEmailsClient";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' MultiMessageProgressModal.tsx — the progress dialog for
// a bulk action over remote messages, fed by the route's NDJSON stream (one line per message, see
// RemoteEmailsServer).
//
// It is Signum's MultiOperationProgressModal with "a Lite and an operation" swapped for "a message id and a
// title" — which is also why altea's own MultiOperationProgressModal cannot just be reused: its results are
// keyed by `lite.key()`, and a remote message has no lite.
//
// altea divergences: the import paths, and `messageResultRef.current.toObject(...)` written as an explicit
// Object.fromEntries (altea's array extensions have `toObject`, but the explicit form reads clearer for a
// two-line reduction).

interface MultiMessageProgressModalProps extends IModalProps<Operations.API.ErrorReport> {
    messages: string[];
    title: string;
    makeRequest: () => Promise<Response>;
    abortController: AbortController;
}

export function MultiMessageProgressModal(p: MultiMessageProgressModalProps): React.ReactElement {

    const [show, setShow] = React.useState(true);
    const forceUpdate = useForceUpdate();
    const messageResultRef = React.useRef([] as EmailResult[]);

    const [requestStarted, setRequestStarted] = React.useState<boolean>(false);
    const oldRequestStarted = useThrottle(requestStarted, 1000);

    async function consumeReader(): Promise<void> {
        setRequestStarted(true);
        const resp = await p.makeRequest();

        for await (const val of jsonObjectStream<EmailResult>(resp.body!.getReader())) {
            messageResultRef.current.push(val);
            forceUpdate();
        }
    }

    React.useEffect(() => {
        void consumeReader().then(
            () => setShow(false),
            e => ErrorModal.showErrorModal(e).then(() => setShow(false)));
    }, []);

    function handleCancelClicked(): void {
        p.abortController.abort();
    }

    function handleOnExited(): void {
        p.onExited!({
            errors: Object.fromEntries(messageResultRef.current.map(a => [a.id, a.error ?? null])),
        });
    }

    const errors = messageResultRef.current.filter(a => a.error != null);

    return (
        <Modal show={show} className="message-modal" backdrop="static" onExited={handleOnExited}>
            <div className="modal-header">
                <h5 className="modal-title">{p.title}</h5>
                <button type="button" className="btn-close" data-dismiss="modal"
                    aria-label={EntityControlMessage.Close.niceToString()} onClick={handleCancelClicked} />
            </div>
            <div className="modal-body">
                <p><strong>{p.messages.length}</strong> {RemoteEmailMessageMessage.Messages.niceToString()}</p>
                {messageResultRef.current.length === 0 && oldRequestStarted
                    ? <ProgressBar now={100} variant="info" animated striped key={1} />
                    : <ProgressBar min={0} max={p.messages.length} now={messageResultRef.current.length}
                        label={`[${messageResultRef.current.length}/${p.messages.length}]`} key={2} />}
                {errors.length > 0 &&
                    <p className="text-danger">
                        {OperationMessage._0Errors.niceToString().forGenderAndNumber(errors.length)
                            .formatHtml(<strong>{errors.length}</strong>)}
                    </p>}
            </div>
            <div className="modal-footer">
                <button type="button" className="btn btn-tertiary sf-entity-button sf-close-button" onClick={handleCancelClicked}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

export namespace MultiMessageProgressModal {
    /** One message needs no dialog: the response is a single NDJSON line, read straight through. */
    export function show(
        messages: string[],
        title: string,
        abortController: AbortController,
        makeRequest: () => Promise<Response>,
    ): Promise<Operations.API.ErrorReport> {

        if (messages.length > 1)
            return openModal<Operations.API.ErrorReport>(
                <MultiMessageProgressModal messages={messages} title={title}
                    makeRequest={makeRequest} abortController={abortController} />);

        return makeRequest().then(r => r.json()).then(obj => {
            const a = obj as EmailResult;
            return softCast<Operations.API.ErrorReport>({ errors: { [a.id]: a.error ?? null } });
        });
    }
}
