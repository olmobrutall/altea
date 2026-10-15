import * as React from "react";
import { Menu } from "@base-ui/react/menu";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button, type ButtonProps } from "./Button";
import { cn, renderChild } from "./utils";

export const Dropdown: typeof Menu.Root = Menu.Root;
export const DropdownGroup: typeof Menu.Group = Menu.Group;
export const DropdownSub: typeof Menu.SubmenuRoot = Menu.SubmenuRoot;

/** True inside a menu: an item built for one also works in a MenuPanel (the context menu), as a plain item. */
const InMenu = React.createContext(false);

export interface DropdownTriggerProps extends Omit<React.ComponentProps<typeof Menu.Trigger>, "render"> {
    asChild?: boolean;
}

export function DropdownTrigger({ asChild, children, nativeButton, ...props }: DropdownTriggerProps): React.ReactElement {
    return <Menu.Trigger {...props} {...renderChild(asChild, children, nativeButton)} />;
}

/** The look is the semantic .sf-dropdown-item: a BLOCK, as Bootstrap's was, so an icon and its text keep the
 *  spacing every ported item gives them itself (`me-2`, a space, `&nbsp;`). A flex row would drop a plain space. */
const item = "relative select-none";

export interface DropdownContentProps extends React.HTMLAttributes<HTMLDivElement> {
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    sideOffset?: number;
}

export function DropdownContent({ className, side = "bottom", sideOffset = 2, align = "start", ...props }: DropdownContentProps): React.ReactElement {
    return (
        <Menu.Portal>
            <Menu.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[1070]">
                <InMenu.Provider value={true}>
                    <Menu.Popup className={cn("sf-dropdown-menu static overflow-y-auto max-h-(--available-height) outline-none", className)} {...props} />
                </InMenu.Provider>
            </Menu.Positioner>
        </Menu.Portal>
    );
}

export interface DropdownItemProps extends Omit<React.ComponentProps<typeof Menu.Item>, "className"> {
    className?: string;
    /** The current choice of a picker-style menu. */
    active?: boolean;
}

export function DropdownItem({ className, active, ...props }: DropdownItemProps): React.ReactElement {
    if (!React.useContext(InMenu))
        return <MenuItem className={className} active={active} {...props as React.ButtonHTMLAttributes<HTMLButtonElement>} />;
    return <Menu.Item aria-current={active || undefined} className={cn("sf-dropdown-item", item, active && "active", className)} {...props} />;
}

export function DropdownCheckboxItem({ className, children, ...props }: Omit<React.ComponentProps<typeof Menu.CheckboxItem>, "className"> & { className?: string }): React.ReactElement {
    return (
        <Menu.CheckboxItem className={cn("sf-dropdown-item", item, "ps-8", className)} {...props}>
            <Menu.CheckboxItemIndicator className="absolute start-2 inline-flex"><FontAwesomeIcon icon="check" aria-hidden={true} /></Menu.CheckboxItemIndicator>
            {children}
        </Menu.CheckboxItem>
    );
}

/** A heading among the items (Base UI ties its own label to a group, so this is plain markup). */
export function DropdownLabel({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
    return <MenuHeader className={className} {...props} />;
}

export function DropdownSeparator({ className }: { className?: string }): React.ReactElement {
    if (!React.useContext(InMenu))
        return <MenuDivider className={className} />;
    return <Menu.Separator className={cn("sf-dropdown-divider", className)} />;
}

export function DropdownSubTrigger({ className, children, ...props }: Omit<React.ComponentProps<typeof Menu.SubmenuTrigger>, "className"> & { className?: string }): React.ReactElement {
    return (
        <Menu.SubmenuTrigger className={cn("sf-dropdown-item", item, "flex items-center gap-2", className)} {...props}>
            {children}
            <FontAwesomeIcon icon="chevron-right" className="ms-auto text-[.7em] rtl:rotate-180" aria-hidden={true} />
        </Menu.SubmenuTrigger>
    );
}

export function DropdownSubContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
    return (
        <Menu.Portal>
            <Menu.Positioner side="right" align="start" className="z-[1070]">
                <InMenu.Provider value={true}>
                    <Menu.Popup className={cn("sf-dropdown-menu static outline-none", className)} {...props} />
                </InMenu.Provider>
            </Menu.Positioner>
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

// Menus a component positions itself (the search context menu, a typeahead): plain semantic markup, no
// Base UI menu — they also hold items other packages build — so the owner handles keys and dismissal.

export function MenuPanel({ className, onKeyDown, ...props }: React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> }): React.ReactElement {
    return <div className={cn("sf-dropdown-menu", className)} onKeyDown={e => { moveFocus(e); onKeyDown?.(e); }} {...props} />;
}

/** Arrow keys walk the items, as react-bootstrap's menus did. */
function moveFocus(e: React.KeyboardEvent<HTMLElement>): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End")
        return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(".sf-dropdown-item, .dropdown-item"))
        .filter(i => !i.classList.contains("disabled") && !(i as HTMLButtonElement).disabled);
    if (items.length === 0)
        return;
    e.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
        : e.key === "ArrowDown" ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
    items[next].focus();
}

export interface MenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    active?: boolean;
}

export function MenuItem({ className, active, type = "button", ...props }: MenuItemProps): React.ReactElement {
    return <button type={type} aria-current={active || undefined} className={cn("sf-dropdown-item", item, active && "active", props.disabled && "disabled", className)} {...props} />;
}

export function MenuDivider({ className, ...props }: React.HTMLAttributes<HTMLHRElement>): React.ReactElement {
    return <hr className={cn("sf-dropdown-divider", className)} {...props} />;
}

export function MenuHeader({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
    return <h6 className={cn("sf-dropdown-header", className)} {...props} />;
}
