import * as React from "react";
import { OverlayTrigger } from "react-bootstrap";
import type { OverlayInjectedProps } from "react-bootstrap/esm/Overlay";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "../../data/globals/helpers";
import { useAPIWithReload } from "../Hooks";
import { VisualTipMessage, type VisualTipSymbol } from "../../data/visualTip";
import { VisualTipClient } from "./VisualTipClient";

// Port of Signum's React/Basics/VisualTipIcon.tsx — the "?" beside a piece of UI that opens an
// explanation, BEATS gently until this user has read it once, and then stops.
//
// The beat is the whole point of the subsystem, and it is what needs the two tables behind it: the icon
// draws attention exactly once per person (see data/visualTip). Reading is recorded on the FIRST CLICK,
// not on close, so a user who opens the popover and dismisses it still counts as having seen it.
//
// altea divergences:
//  - `visualTip` is a `VisualTipSymbol` rather than Signum's generated symbol object; the key is
//    `symbol.key`, as everywhere in altea.
//  - Signum's `AccessibleOverlay` is kept, comments and all: it is not decoration but the reason the
//    popover is usable from a keyboard — it focuses the popover, wires `aria-labelledby` /
//    `aria-describedby` to the header and body it finds, marks a long body `role="document"`, and closes
//    on Escape. One divergence inside it: the Escape handler is registered ONCE rather than on every
//    render (Signum's effect depends on the whole props object, so it re-subscribes each time).

/**
 * Signum's `AccessibleOverlay` — makes the tip popover a real dialog for a keyboard or screen reader.
 *
 * It reaches into the rendered popover because react-bootstrap owns that markup: the header and body are
 * found in the DOM and given ids, which is what `aria-labelledby` / `aria-describedby` can then point at.
 */
function AccessibleOverlay(p: { id: string; children: React.ReactNode; onClose: () => void }): React.JSX.Element {
    const ref = React.useRef<HTMLDivElement>(null);
    const onClose = p.onClose;

    React.useEffect(() => {
        const node = ref.current;
        if (node == null)
            return;

        const popover = node.querySelector<HTMLElement>(".popover");
        if (popover != null) {
            popover.setAttribute("tabindex", "-1");
            popover.focus();
        } else {
            node.focus(); // fallback
        }

        const header = node.querySelector(".popover-header");
        if (header != null) {
            const id = `${p.id}-header`;
            header.id = id;
            node.setAttribute("aria-labelledby", id);
        }

        const body = node.querySelector(".popover-body");
        if (body != null) {
            const bodyId = `${p.id}-body`;
            body.id = bodyId;
            node.setAttribute("aria-describedby", bodyId);
            // Help content is long, so it is a document rather than a plain description.
            body.setAttribute("role", "document");
        }
    }, [p.id]);

    React.useEffect(() => {
        function handleKeyDown(e: KeyboardEvent): void {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        }

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    return (
        <div ref={ref} id={p.id} role="dialog" aria-modal="true" tabIndex={-1} className="visual-tip-overlay">
            {p.children}
        </div>
    );
}

export interface VisualTipIconProps {
    visualTip: VisualTipSymbol;
    className?: string;
    content: (injected: OverlayInjectedProps) => React.ReactElement;
}

export function VisualTipIcon(p: VisualTipIconProps): React.JSX.Element {
    const [consumed, reload] = useAPIWithReload(() => VisualTipClient.API.getConsumed(), []);
    const buttonRef = React.useRef<HTMLButtonElement>(null);

    // `consumed == null` is "consuming is disabled server-side" (see VisualTipLogic.isConsumeEnabled): the
    // icon then beats for everyone and records nothing, which is what a shared demo account wants.
    const unread = consumed != null && !consumed.includes(p.visualTip.key);

    return (
        <OverlayTrigger
            trigger="click"
            rootClose
            placement="auto"
            overlay={(injected: OverlayInjectedProps) => (
                <AccessibleOverlay
                    id="visual-tip-popover"
                    onClose={() => {
                        // Close through `rootClose` by clicking the reference element again, then give the
                        // focus back to the button the user came from.
                        const reference = injected.popper?.state?.elements?.reference;
                        if (reference instanceof HTMLElement)
                            reference.click();
                        buttonRef.current?.focus();
                    }}>
                    {p.content(injected)}
                </AccessibleOverlay>
            )}>
            <button
                ref={buttonRef}
                type="button"
                style={{ border: "none", background: "transparent" }}
                className={classes("sf-line-button align-self-center", unread && "sf-beat", p.className)}
                title={VisualTipMessage.Help.niceToString()}
                onClick={() => {
                    // Recorded on the first click, and only when it is not already read. `consumed == null`
                    // (disabled) posts too, as Signum's does: the server is the one that decides, and it
                    // ignores the call.
                    if (consumed == null || !consumed.includes(p.visualTip.key))
                        void VisualTipClient.API.consume(p.visualTip.key).then(() => { reload(); });
                }}>
                <FontAwesomeIcon aria-hidden={true} icon="question-circle" />
            </button>
        </OverlayTrigger>
    );
}
