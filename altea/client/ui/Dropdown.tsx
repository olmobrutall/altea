import * as React from "react";
import { DropdownMenu as Menu } from "radix-ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button, type ButtonProps } from "./Button";
import { cn } from "./utils";

export const Dropdown: typeof Menu.Root = Menu.Root;

/** True inside a Radix menu: an item built for one also works in a MenuPanel (the context menu), as a plain item. */
const InRadixMenu = React.createContext(false);
export const DropdownTrigger: typeof Menu.Trigger = Menu.Trigger;
export const DropdownGroup: typeof Menu.Group = Menu.Group;
export const DropdownSub: typeof Menu.Sub = Menu.Sub;

/** Laid out as a row so an icon and its text sit together; the look is the semantic .sf-dropdown-item. */
const item = "relative flex items-center gap-2 select-none";

export function DropdownContent({ className, sideOffset = 2, align = "start", ...props }: React.ComponentProps<typeof Menu.Content>): React.ReactElement {
    return (
        <Menu.Portal>
            <InRadixMenu.Provider value={true}>
                <Menu.Content sideOffset={sideOffset} align={align}
                    className={cn("sf-dropdown-menu static z-[1070] overflow-y-auto max-h-(--radix-dropdown-menu-content-available-height)", className)}
                    {...props} />
            </InRadixMenu.Provider>
        </Menu.Portal>
    );
}

export interface DropdownItemProps extends React.ComponentProps<typeof Menu.Item> {
    /** The current choice of a picker-style menu. */
    active?: boolean;
}

export function DropdownItem({ className, active, ...props }: DropdownItemProps): React.ReactElement {
    if (!React.useContext(InRadixMenu))
        return <MenuItem className={className} active={active} {...props as React.ButtonHTMLAttributes<HTMLButtonElement>} />;
    return <Menu.Item aria-current={active || undefined} className={cn("sf-dropdown-item", item, active && "active", className)} {...props} />;
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
    if (!React.useContext(InRadixMenu))
        return <MenuHeader className={className} {...props as React.HTMLAttributes<HTMLHeadingElement>} />;
    return <Menu.Label className={cn("sf-dropdown-header", className)} {...props} />;
}

export function DropdownSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>): React.ReactElement {
    if (!React.useContext(InRadixMenu))
        return <MenuDivider className={className} />;
    return <Menu.Separator className={cn("sf-dropdown-divider", className)} {...props} />;
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
            <Menu.SubContent className={cn("sf-dropdown-menu static z-[1070]", className)} {...props} />
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
// Radix menu — they also hold items other packages build — so the owner handles keys and dismissal.

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
