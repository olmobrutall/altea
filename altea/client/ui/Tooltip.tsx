import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn, renderChild } from "./utils";

/** Bootstrap's stacking order, so a migrated overlay and a Bootstrap modal still layer correctly. */
export const zIndex = { dropdown: 1000, modal: 1055, popover: 1070, tooltip: 1080 } as const;

export type Side = "top" | "right" | "bottom" | "left";

/** A small square turned 45°, sitting on the edge of the popup facing its anchor. */
const arrow = "size-2 rotate-45 data-[side=top]:-bottom-1 data-[side=bottom]:-top-1 data-[side=left]:-right-1 data-[side=right]:-left-1";

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
        <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger render={children} delay={delay} />
            <TooltipPrimitive.Portal>
                <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-[1080]">
                    <TooltipPrimitive.Popup className={cn("sf-tooltip max-w-[200px] rounded-md bg-dark px-2 py-1 text-center text-sm text-dark-foreground", className)}>
                        {tooltip}
                        <TooltipPrimitive.Arrow className={cn(arrow, "bg-dark")} />
                    </TooltipPrimitive.Popup>
                </TooltipPrimitive.Positioner>
            </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
    );
}

const AnchorContext = React.createContext<{ anchor: HTMLElement | null, setAnchor: (e: HTMLElement | null) => void } | null>(null);

export type PopoverProps = React.ComponentProps<typeof PopoverPrimitive.Root>;

export function Popover(props: PopoverProps): React.ReactElement {
    const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
    return (
        <AnchorContext.Provider value={{ anchor, setAnchor }}>
            <PopoverPrimitive.Root {...props} />
        </AnchorContext.Provider>
    );
}

export interface PopoverTriggerProps extends Omit<React.ComponentProps<typeof PopoverPrimitive.Trigger>, "render"> {
    asChild?: boolean;
}

export function PopoverTrigger({ asChild, children, nativeButton, ...props }: PopoverTriggerProps): React.ReactElement {
    return <PopoverPrimitive.Trigger {...props} {...renderChild(asChild, children, nativeButton)} />;
}

/** Positions the popup against an element that does not open it (a field whose button does). */
export function PopoverAnchor({ children }: { children: React.ReactElement<{ ref?: React.Ref<HTMLElement> }>, asChild?: boolean }): React.ReactElement {
    const ctx = React.useContext(AnchorContext);
    const childRef = children.props.ref;
    return React.cloneElement(children, {
        ref: (e: HTMLElement | null) => {
            ctx?.setAnchor(e);
            if (typeof childRef === "function") childRef(e);
            else if (childRef) (childRef as React.RefObject<HTMLElement | null>).current = e;
        },
    });
}

export interface PopoverContentProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
    title?: React.ReactNode;
    arrow?: boolean;
    side?: Side;
    align?: "start" | "center" | "end";
    sideOffset?: number;
    collisionPadding?: number;
    /** Move the focus into the popup when it opens (default true). */
    autoFocus?: boolean;
    ref?: React.Ref<HTMLDivElement>;
}

export function PopoverContent({ className, title, arrow: showArrow, side = "bottom", align = "center", sideOffset = 6, collisionPadding = 5, autoFocus = true, children, ...props }: PopoverContentProps): React.ReactElement {
    const ctx = React.useContext(AnchorContext);
    return (
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}
                anchor={ctx?.anchor ?? undefined} className="z-[1070]">
                <PopoverPrimitive.Popup initialFocus={autoFocus ? undefined : false}
                    className={cn("sf-popover max-w-[276px] rounded-md border-1 bg-popover text-sm text-popover-foreground shadow-md outline-none",
                        title == null && "p-3", className)}
                    {...props}>
                    {title != null && <div className="sf-popover-header rounded-t-md border-b bg-muted px-3 py-2 font-medium">{title}</div>}
                    {title != null ? <div className="sf-popover-body p-3">{children}</div> : children}
                    {showArrow && <PopoverPrimitive.Arrow className={cn(arrow, "border-1 bg-popover")} />}
                </PopoverPrimitive.Popup>
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
}

export const Collapsible: typeof CollapsiblePrimitive.Root = CollapsiblePrimitive.Root;

export interface CollapsibleTriggerProps extends Omit<React.ComponentProps<typeof CollapsiblePrimitive.Trigger>, "render"> {
    asChild?: boolean;
}

export function CollapsibleTrigger({ asChild, children, nativeButton, ...props }: CollapsibleTriggerProps): React.ReactElement {
    return <CollapsiblePrimitive.Trigger {...props} {...renderChild(asChild, children, nativeButton)} />;
}

export function CollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Panel>): React.ReactElement {
    return <CollapsiblePrimitive.Panel className={cn("sf-collapsible overflow-hidden", className as string)} {...props} />;
}
