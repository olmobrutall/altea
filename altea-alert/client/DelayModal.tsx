import * as React from "react";
import { Modal } from "react-bootstrap";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Temporal } from "@altea/altea/data/basics";
import { AlertMessage } from "../data/Alert";

// Signum asks for the custom delay with `AutoLineModal.show({ type: mi.type, … })` — a generic "edit one
// value" modal altea does not have (see CLAUDE.md), so this is the same prompt as a local component: the
// accommodation altea-workflow already makes for "pick an expiration date".
//
// The input is a native `datetime-local`, whose value IS the ISO shape `Temporal.PlainDateTime` parses.
function DelayModalComponent(p: IModalProps<Temporal.PlainDateTime | undefined> & { initialValue: Temporal.PlainDateTime }): React.JSX.Element {
    const [show, setShow] = React.useState(true);
    const [value, setValue] = React.useState(() => toInputValue(p.initialValue));

    const answer = React.useRef<Temporal.PlainDateTime | undefined>(undefined);

    function ok(): void {
        answer.current = parse(value);
        setShow(false);
    }

    return (
        <Modal size="sm" show={show} onExited={() => p.onExited!(answer.current)} onHide={() => setShow(false)}>
            <div className="modal-header">
                <h5 className="modal-title">{AlertMessage.CustomDelay.niceToString()}</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                <input type="datetime-local" className="form-control" value={value} autoFocus
                    onChange={e => setValue(e.currentTarget.value)}
                    onKeyDown={e => { if (e.key === "Enter") ok(); }} />
            </div>
            <div className="modal-footer">
                <button className="btn btn-primary sf-entity-button" disabled={parse(value) == null} onClick={ok}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
                <button className="btn btn-light sf-entity-button" onClick={() => setShow(false)}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" — a PlainDateTime's ISO string, minutes precision. */
function toInputValue(value: Temporal.PlainDateTime): string {
    return value.toString({ smallestUnit: "minute" });
}

function parse(value: string): Temporal.PlainDateTime | undefined {
    try {
        return value === "" ? undefined : Temporal.PlainDateTime.from(value);
    } catch {
        return undefined;
    }
}

export namespace DelayModal {
    /** Ask for a date/time; resolves undefined when the user cancels. */
    export function show(initialValue: Temporal.PlainDateTime): Promise<Temporal.PlainDateTime | undefined> {
        return openModal<Temporal.PlainDateTime | undefined>(<DelayModalComponent initialValue={initialValue} />);
    }
}
