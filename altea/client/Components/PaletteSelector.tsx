import * as React from "react";
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "../ui/Dropdown";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { dropdownActive } from "./DropdownActive";

// The navbar PALETTE picker, beside ThemeModeSelector (light / dark / auto). altea owns the MECHANISM — the
// `data-palette` attribute on the root element, the remembered choice, the token contract a palette fills
// in — and the application owns the PALETTES: a stylesheet of `[data-palette=<name>]` blocks that redefine
// theme.css's tokens, one block per mode, and the list it hands to this picker. A palette is a few dozen CSS
// variables, so all of them ship with the app: nothing is downloaded when one is picked, and it works offline.

export interface Palette {
    /** The `data-palette` value its stylesheet keys on. "" is theme.css's own default. */
    name: string;
    label: string;
    /** A colour shown beside the label (the palette's primary). */
    swatch?: string;
    /** A palette that only makes sense in one mode moves the mode picker with it. */
    mode?: "light" | "dark";
}

export const PALETTE_STORAGE_KEY = "sf-palette";

/** Read the stored choice — also what an app's boot script reads to stamp `data-palette` before painting. */
export function getStoredPalette(): string {
    try {
        return localStorage.getItem(PALETTE_STORAGE_KEY) ?? "";
    } catch {
        return "";
    }
}

export function applyPalette(name: string): void {
    if (name)
        document.documentElement.dataset.palette = name;
    else
        delete document.documentElement.dataset.palette;
}

export function PaletteSelector(p: { palettes: Palette[], title?: string }): React.ReactElement {
    const [name, setName] = React.useState(() => {
        const stored = getStoredPalette();
        return p.palettes.some(x => x.name === stored) ? stored : "";
    });

    React.useEffect(() => {
        applyPalette(name);
        try {
            localStorage.setItem(PALETTE_STORAGE_KEY, name);
        } catch {
            /* a locked-down browser: the palette still applies for this visit */
        }
    }, [name]);

    function select(palette: Palette): void {
        setName(palette.name);
        // ThemeModeSelector's channel for "follow this palette's mode"; a palette with no opinion leaves an
        // explicit choice alone.
        if (palette.mode != null)
            window.dispatchEvent(new CustomEvent("change-theme-mode", { detail: palette.mode }));
    }

    const current = p.palettes.find(x => x.name === name) ?? p.palettes[0];

    return (
        <div className="sf-nav-item sf-dropdown sf-palette-dropdown" data-palette={name}>
            <Dropdown>
                <DropdownTrigger asChild>
                    <button type="button" id="changePalette" className="sf-nav-link sf-dropdown-toggle" title={p.title}>
                        <FontAwesomeIcon aria-hidden={true} icon="palette" /> {current?.label}
                    </button>
                </DropdownTrigger>
                <DropdownContent align="end">
                    {p.palettes.map(x =>
                        <DropdownItem key={x.name} data-palette={x.name} {...dropdownActive(x.name === name)} onClick={() => select(x)}>
                            <span aria-hidden={true} className="me-2 inline-block size-3 rounded-full border-1 align-[-.0625em]"
                                style={{ backgroundColor: x.swatch ?? "var(--primary)" }} />
                            {x.label}
                        </DropdownItem>
                    )}
                </DropdownContent>
            </Dropdown>
        </div>
    );
}
