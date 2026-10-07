import * as React from "react";
import { Modal } from "react-bootstrap";
import { openModal, type IModalProps } from "../Modals";
import { JavascriptMessage } from "../../data/uiMessages";
import { WebConsoleView } from "./WebConsoleView";

// A WebConsoleView in a dialog: resolves to the command's result once it finishes and the user continues,
// or to `undefined` when it failed or the dialog was closed (which cancels a running command).

interface WebConsoleModalProps extends IModalProps<{ result: unknown } | undefined> {
    title: React.ReactNode;
    command: string;
    args?: unknown;
}

function WebConsoleModal(p: WebConsoleModalProps): React.ReactElement {
    const [show, setShow] = React.useState(true);
    const [finished, setFinished] = React.useState<{ result: unknown } | undefined>(undefined);
    const answer = React.useRef<{ result: unknown } | undefined>(undefined);
    const titleId = React.useId();

    function close(value: { result: unknown } | undefined) {
        answer.current = value;
        setShow(false);
    }

    return (
        <Modal show={show} size="xl" onHide={() => close(undefined)} onExited={() => p.onExited!(answer.current)}
            aria-labelledby={titleId} backdrop="static">
            <div className="modal-header">
                <h1 id={titleId} className="modal-title h5">{p.title}</h1>
                <button type="button" className="btn-close" aria-label={JavascriptMessage.Close.niceToString()} onClick={() => close(undefined)} />
            </div>
            <div className="modal-body">
                <WebConsoleView command={p.command} args={p.args} onFinished={result => setFinished({ result })} />
            </div>
            <div className="modal-footer">
                <button type="button" className="btn btn-primary" disabled={finished == null} onClick={() => close(finished)}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => close(undefined)}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

namespace WebConsoleModal {
    export function show(title: React.ReactNode, command: string, args?: unknown): Promise<{ result: unknown } | undefined> {
        return openModal<{ result: unknown } | undefined>(<WebConsoleModal title={title} command={command} args={args} />);
    }
}

export default WebConsoleModal;
