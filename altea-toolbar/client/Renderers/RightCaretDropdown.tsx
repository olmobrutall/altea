import React from "react";
import Dropdown from "react-bootstrap/Dropdown";
import { Breakpoints, useBreakpoint } from "@altea/altea/client/Hooks";
import type { ToolbarResponse } from "../../data/ToolbarResponse";
import { liteKeyOrQuery } from "./ToolbarRenderer";
import "./RightCaretDropdown.css";

// Faithful port of Signum's RightCaretDropdown.tsx (Signum.Toolbar/Renderers/RightCaretDropdown.tsx): the
// ToolbarSwitcher's picker — a dropdown that opens to the RIGHT of the sidebar on desktop and downwards on
// mobile. No altea divergences beyond the import paths and the shared ToolbarResponse type.

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
        <Dropdown style={{ width: "100%" }} drop={isMobile ? "down" : "end"}>
            <Dropdown.Toggle
                variant="tertiary"
                disabled={disabled}
                className="d-flex align-items-center"
                style={{ width: "100%" }}
            >
                {selected?.icon}
                <span className="flex-grow-1 mx-2">
                    {selected ? selected.label : placeholder || "Select..."}
                </span>
            </Dropdown.Toggle>
            <Dropdown.Menu className="menu-right-of-caret" align="start">
                {options.map((opt, idx) => (
                    <Dropdown.Item
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
                    </Dropdown.Item>
                ))}
            </Dropdown.Menu>
        </Dropdown>
    );
}
