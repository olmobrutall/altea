import * as React from "react";
import { DropdownMenu as Menu } from "radix-ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button, type ButtonProps } from "./Button";
import { cn } from "./utils";

export const Dropdown: typeof Menu.Root = Menu.Root;
export const DropdownTrigger: typeof Menu.Trigger = Menu.Trigger;
export const DropdownGroup: typeof Menu.Group = Menu.Group;
export const DropdownSub: typeof Menu.Sub = Menu.Sub;

const item = "relative flex w-full cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-sm px-4 py-1 outline-none " +
    "text-popover-foreground no-underline data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground " +
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 aria-[current=true]:bg-primary aria-[current=true]:text-primary-foreground";

export function DropdownContent({ className, sideOffset = 2, align = "start", ...props }: React.ComponentProps<typeof Menu.Content>): React.ReactElement {
    return (
        <Menu.Portal>
            <Menu.Content sideOffset={sideOffset} align={align}
                className={cn("sf-dropdown-menu z-[1070] min-w-[10rem] overflow-y-auto rounded-md border-1 bg-popover py-2 text-base text-popover-foreground shadow-md",
                    "max-h-(--radix-dropdown-menu-content-available-height)", className)}
                {...props} />
        </Menu.Portal>
    );
}

export interface DropdownItemProps extends React.ComponentProps<typeof Menu.Item> {
    /** The current choice of a picker-style menu. */
    active?: boolean;
}

export function DropdownItem({ className, active, ...props }: DropdownItemProps): React.ReactElement {
    return <Menu.Item aria-current={active || undefined} className={cn("sf-dropdown-item", item, className)} {...props} />;
}

export function DropdownCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Menu.CheckboxItem>): React.ReactElement {
    return (
        <Menu.CheckboxItem className={cn("sf-dropdown-item", item, "ps-8", className)} {...props}>
            <Menu.ItemIndicator className="absolute start-2 inline-flex"><FontAwesomeIcon icon="check" aria-hidden={true} /></Menu.ItemIndicator>
            {children}
        </Menu.CheckboxItem>
    );
}

export function DropdownLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>): React.ReactElement {
    return <Menu.Label className={cn("sf-dropdown-header px-4 py-1 text-sm text-muted-foreground", className)} {...props} />;
}

export function DropdownSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>): React.ReactElement {
    return <Menu.Separator className={cn("sf-dropdown-divider my-2 h-px bg-border", className)} {...props} />;
}

export function DropdownSubTrigger({ className, children, ...props }: React.ComponentProps<typeof Menu.SubTrigger>): React.ReactElement {
    return (
        <Menu.SubTrigger className={cn("sf-dropdown-item", item, className)} {...props}>
            {children}
            <FontAwesomeIcon icon="chevron-right" className="ms-auto text-[.7em] rtl:rotate-180" aria-hidden={true} />
        </Menu.SubTrigger>
    );
}

export function DropdownSubContent({ className, ...props }: React.ComponentProps<typeof Menu.SubContent>): React.ReactElement {
    return (
        <Menu.Portal>
            <Menu.SubContent className={cn("sf-dropdown-menu z-[1070] min-w-[10rem] rounded-md border-1 bg-popover py-2 text-popover-foreground shadow-md", className)} {...props} />
        </Menu.Portal>
    );
}

export interface DropdownButtonProps extends Omit<ButtonProps, "title" | "children"> {
    title: React.ReactNode;
    children: React.ReactNode;
    align?: "start" | "center" | "end";
    /** Hides the caret. */
    noCaret?: boolean;
    contentClassName?: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

/** react-bootstrap's `<DropdownButton title=…>`: a button that opens a menu of `DropdownItem`s. */
export function DropdownButton({ title, children, align, noCaret, contentClassName, open, onOpenChange, ...buttonProps }: DropdownButtonProps): React.ReactElement {
    return (
        <Dropdown open={open} onOpenChange={onOpenChange}>
            <DropdownTrigger asChild>
                <Button {...buttonProps}>
                    {title}
                    {!noCaret && <FontAwesomeIcon icon="caret-down" className="ms-0.5 text-[.8em]" aria-hidden={true} />}
                </Button>
            </DropdownTrigger>
            <DropdownContent align={align} className={contentClassName}>{children}</DropdownContent>
        </Dropdown>
    );
}
