import * as React from "react";
import { Tooltip as TooltipPrimitive, Popover as PopoverPrimitive, Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "./utils";

/** Bootstrap's stacking order, so a migrated overlay and a Bootstrap modal still layer correctly. */
export const zIndex = { dropdown: 1000, modal: 1055, popover: 1070, tooltip: 1080 } as const;

export type Side = "top" | "right" | "bottom" | "left";

export interface WithTooltipProps {
    tooltip: React.ReactNode;
    side?: Side;
    /** The element that shows the tooltip. Must accept a ref and props (a DOM element or a forwarding component). */
    children: React.ReactElement;
    delay?: number;
    className?: string;
}

/** react-bootstrap's `<OverlayTrigger overlay={<Tooltip>…</Tooltip>}>`. */
export function WithTooltip({ tooltip, side = "top", children, delay = 300, className }: WithTooltipProps): React.ReactElement {
    if (tooltip == null || tooltip === "")
        return children;

    return (
        <TooltipPrimitive.Provider delayDuration={delay}>
            <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content side={side} sideOffset={4}
                        className={cn("sf-tooltip z-[1080] max-w-[200px] rounded-md bg-dark px-2 py-1 text-center text-sm text-dark-foreground", className)}>
                        {tooltip}
                        <TooltipPrimitive.Arrow className="fill-dark" />
                    </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
    );
}

export const Popover: typeof PopoverPrimitive.Root = PopoverPrimitive.Root;
export const PopoverTrigger: typeof PopoverPrimitive.Trigger = PopoverPrimitive.Trigger;
export const PopoverAnchor: typeof PopoverPrimitive.Anchor = PopoverPrimitive.Anchor;

export interface PopoverContentProps extends Omit<React.ComponentProps<typeof PopoverPrimitive.Content>, "title"> {
    title?: React.ReactNode;
    arrow?: boolean;
}

export function PopoverContent({ className, title, arrow, children, align = "center", sideOffset = 6, ...props }: PopoverContentProps): React.ReactElement {
    return (
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content align={align} sideOffset={sideOffset}
                className={cn("sf-popover z-[1070] max-w-[276px] rounded-md border-1 bg-popover text-sm text-popover-foreground shadow-md outline-none",
                    title == null && "p-3", className)}
                {...props}>
                {title != null && <div className="sf-popover-header rounded-t-md border-b bg-muted px-3 py-2 font-medium">{title}</div>}
                {title != null ? <div className="sf-popover-body p-3">{children}</div> : children}
                {arrow && <PopoverPrimitive.Arrow className="fill-popover" />}
            </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
    );
}

export const Collapsible: typeof CollapsiblePrimitive.Root = CollapsiblePrimitive.Root;
export const CollapsibleTrigger: typeof CollapsiblePrimitive.Trigger = CollapsiblePrimitive.Trigger;

export function CollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Content>): React.ReactElement {
    return <CollapsiblePrimitive.Content className={cn("sf-collapsible overflow-hidden", className)} {...props} />;
}
