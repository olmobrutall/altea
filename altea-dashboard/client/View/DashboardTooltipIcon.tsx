import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Popover, PopoverContent, PopoverTrigger } from "@altea/altea/client/ui/Tooltip";
import HtmlViewer from "./HtmlViewer";
import { DashboardMessage } from "../../data/Dashboard";

// Port of Signum's Signum.Dashboard/View/DashboardTooltipIcon.tsx — the ⓘ next to a part title that opens
// the part's (HTML) tooltip on click and closes on an outside click. altea divergence: the body renders
// through the local HtmlViewer (Signum.HtmlEditor is not ported).
//
// A click-opened popover, not a hover tooltip: the kit Popover owns the outside-click and Escape dismissal
// (returning the focus to the trigger) that react-bootstrap's Overlay needed hand-written listeners for.

export interface DashboardTooltipIconProps {
    tooltipHtml: string;
    placement?: "auto" | "top" | "bottom" | "left" | "right";
    className?: string;
    iconClassName?: string;
}

export function DashboardTooltipIcon(p: DashboardTooltipIconProps): React.JSX.Element {
    const [show, setShow] = React.useState(false);

    return (
        <Popover open={show} onOpenChange={setShow}>
            {/* A <button>, not a <span>: the trigger is what opens the explanation, and as a span with an
                onClick it could not be reached or activated from the keyboard at all. */}
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className={p.className}
                    onClick={e => e.stopPropagation()}
                    aria-label={DashboardMessage.MoreInformation.niceToString()}
                    style={{ cursor: "pointer", background: "none", border: 0, padding: 0, lineHeight: 1, color: "inherit" }}>
                    <FontAwesomeIcon aria-hidden={true} icon="circle-info" className={p.iconClassName} />
                </button>
            </PopoverTrigger>
            <PopoverContent className="dashboard-tooltip-content" autoFocus={false}
                side={p.placement == null || p.placement == "auto" ? "right" : p.placement} align="start" sideOffset={8} collisionPadding={16}>
                <HtmlViewer text={p.tooltipHtml} />
            </PopoverContent>
        </Popover>
    );
}
