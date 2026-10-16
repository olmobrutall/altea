import * as React from "react";
import { DropdownItem } from "../ui/Dropdown";
import { setDesign, useDesign, type Design } from "../ui/design";
import { dropdownActive } from "./DropdownActive";

const DESIGNS: { design: Design, label: string }[] = [
    { design: "classic", label: "Classic design" },
    { design: "modern", label: "Modern design" },
];

/** The classic / modern choice, as items for ThemeModeSelector's `extraItems`. */
export function DesignMenuItems(): React.ReactElement {
    const design = useDesign();
    return (
        <>
            {DESIGNS.map(d =>
                <DropdownItem key={d.design} data-design={d.design} {...dropdownActive(design === d.design)} onClick={() => setDesign(d.design)}>
                    {d.label}
                </DropdownItem>
            )}
        </>
    );
}
