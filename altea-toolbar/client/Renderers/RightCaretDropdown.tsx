import React from "react";
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "@altea/altea/client/ui/Dropdown";
import { BootstrapButton } from "@altea/altea/client/Operations/EntityOperations";
import { Breakpoints, useBreakpoint } from "@altea/altea/client/Hooks";
import type { ToolbarResponse } from "../../data/ToolbarResponse";
import { liteKeyOrQuery } from "./ToolbarRenderer";
import "./RightCaretDropdown.css";

// Port of Signum.Toolbar's Renderers/RightCaretDropdown.tsx — see port/Toolbar.md.
//
// The ToolbarSwitcher's picker: a dropdown that opens to the RIGHT of the sidebar on desktop and downwards
// on mobile.

export interface RightCaretDropdownOption {
    value: ToolbarResponse<any>;
    label: string;
    icon?: React.ReactNode;
}

interface RightCaretDropdownProps {
    options: RightCaretDropdownOption[];
    value: ToolbarResponse<any> | null;
    onChange: (value: ToolbarResponse<any>, e: React.MouseEvent) => void;
    disabled?: boolean;
    placeholder?: string;
}

export function RightCaretDropdown({
    options,
    value,
    onChange,
    disabled,
    placeholder,
}: RightCaretDropdownProps): React.JSX.Element {
    const selected = options.find(o => o.value === value);

    const isMobile = useBreakpoint() <= Breakpoints.sm;

    return (
        <div style={{ width: "100%" }}>
            <Dropdown>
                <DropdownTrigger asChild>
                    <BootstrapButton
                        variant="tertiary"
                        disabled={disabled}
                        className="sf-dropdown-toggle flex items-center"
                        style={{ width: "100%" }}
                    >
                        {selected?.icon}
                        <span className="grow mx-2">
                            {selected ? selected.label : placeholder || "Select..."}
                        </span>
                    </BootstrapButton>
                </DropdownTrigger>
                {/* RightCaretDropdown.css styles react-bootstrap's `.dropdown-menu.menu-right-of-caret.show`,
                    which the kit menu does not carry: the 3-column grid is restated here. */}
                <DropdownContent side={isMobile ? "bottom" : "right"} align="start"
                    className="menu-right-of-caret grid grid-cols-3 min-w-[280px] max-w-[400px] p-4 max-sm:min-w-0 max-sm:max-w-none">
                    {options.map((opt, idx) => (
                        <DropdownItem
                            key={idx}
                            onClick={e => onChange(opt.value, e)}
                            className="switcher-item"
                            active={opt.value === value}
                            title={opt.label}
                            aria-label={opt.label}
                            data-toolbar-content={liteKeyOrQuery(opt.value.content)}
                        >
                            <div className="switcher-item-icon">{opt.icon}</div>
                            <small>{opt.label}</small>
                        </DropdownItem>
                    ))}
                </DropdownContent>
            </Dropdown>
        </div>
    );
}
