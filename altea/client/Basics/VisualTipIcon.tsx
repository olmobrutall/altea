import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "../../data/globals/helpers";
import { useAPIWithReload } from "../Hooks";
import { VisualTipMessage, type VisualTipSymbol } from "../../data/visualTip";
import { VisualTipClient } from "./VisualTipClient";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/Tooltip";

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
//  - Signum's `AccessibleOverlay` survives as the effect below: the popover (a Radix dialog that takes
//    the focus and closes on Escape, giving it back to the button) is named by the tip's header and
//    described by its body, which is marked `role="document"` because help content is long.

export interface VisualTipIconProps {
    visualTip: VisualTipSymbol;
    className?: string;
    /** The tip — usually a `TipPopover` (SearchControlVisualTips). */
    content: () => React.ReactElement;
}

export function VisualTipIcon(p: VisualTipIconProps): React.JSX.Element {
    const [consumed, reload] = useAPIWithReload(() => VisualTipClient.API.getConsumed(), []);
    const [open, setOpen] = React.useState(false);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const id = React.useId();

    // `consumed == null` is "consuming is disabled server-side" (see VisualTipLogic.isConsumeEnabled): the
    // icon then beats for everyone and records nothing, which is what a shared demo account wants.
    const unread = consumed != null && !consumed.includes(p.visualTip.key);

    React.useEffect(() => {
        const node = contentRef.current;
        if (!open || node == null)
            return;

        const header = node.querySelector(".sf-popover-header");
        if (header != null) {
            header.id = `${id}-header`;
            node.setAttribute("aria-labelledby", header.id);
        }

        const body = node.querySelector(".sf-popover-body");
        if (body != null) {
            body.id = `${id}-body`;
            node.setAttribute("aria-describedby", body.id);
            body.setAttribute("role", "document");
        }
    }, [open]);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    style={{ border: "none", background: "transparent" }}
                    className={classes("sf-line-button self-center", unread && "sf-beat", p.className)}
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
            </PopoverTrigger>
            <PopoverContent ref={contentRef} className="visual-tip-overlay w-auto max-w-none p-0" collisionPadding={8}>
                {p.content()}
            </PopoverContent>
        </Popover>
    );
}
