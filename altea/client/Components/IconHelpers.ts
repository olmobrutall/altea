import type { IconProp, IconName, IconPrefix } from "@fortawesome/fontawesome-svg-core";

// The non-React half of Signum's `@framework/Components/IconTypeahead` (parseIcon / fallbackIcon); the picker
// itself is ./IconTypeahead. The STORED format is Signum's: a bare icon name ("gauge"), or a "<prefix> <name>"
// pair — what the picker writes is the long form ("fa-regular fa-bell", "fa-brands fa-github"), and the short
// forms ("regular circle-check", "fas gauge") are read too. The app registers the full free solid + regular
// sets (eastwind's MainPublic does `library.add(fas, far)`), so a resolved name renders.
//
// Lives in the FRAMEWORK client (as Signum's IconTypeahead does) because every module that stores an icon
// name needs it: altea-dashboard (panel/part icons), altea-toolbar (element icons), altea-user-queries.

/** The short prefix for each spelling of a family ("fa-solid" / "solid" / "fas"). */
export const prefixes: Record<string, IconPrefix> = {
    "fa-solid": "fas",
    "fa-regular": "far",
    "fa-brands": "fab",
    "fa-light": "fal",
    "fa-duotone": "fad",
    "fa-thin": "fat",
    solid: "fas",
    fas: "fas",
    regular: "far",
    far: "far",
    brands: "fab",
    fab: "fab",
    light: "fal",
    fal: "fal",
    duotone: "fad",
    fad: "fad",
    thin: "fat",
    fat: "fat",
};

/** Signum's parseIcon: the stored icon string → a FontAwesome IconProp (undefined when empty, "_" or "none"). */
export function parseIcon(iconName: string | null | undefined): IconProp | undefined {
    if (iconName == null)
        return undefined;

    const text = iconName.trim();
    if (text == "" || text == "_" || text == "none")
        return undefined;

    const parts = text.split(/\s+/);
    if (parts.length >= 2) {
        const prefix = prefixes[parts[0].toLowerCase()];
        if (prefix != null)
            return [prefix, stripFa(parts.slice(1).join(" ")) as IconName];
    }

    return stripFa(text) as IconName;
}

function stripFa(name: string): string {
    return name.startsWith("fa-") ? name.substring(3) : name;
}

/** Signum's fallbackIcon: render SOMETHING even when the stored name is not in the loaded icon library. */
export function fallbackIcon(icon: IconProp | undefined): IconProp {
    return icon ?? "question";
}

/** Signum's `getContrastingTextColorWCAG` (@framework/Globals) — black or white text over `background`,
 *  chosen by WCAG relative luminance. altea has no Globals equivalent, so it lives here. Accepts "#rgb",
 *  "#rrggbb" and "rgb(r,g,b)"; anything else falls back to black. */
export function getContrastingTextColor(background: string | null | undefined): string | undefined {
    const rgb = parseColor(background);
    if (rgb == null)
        return undefined;

    const [r, g, b] = rgb.map(c => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });

    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Contrast against white vs. against black (WCAG 2.x relative-luminance ratio).
    return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.05) ? "#FFFFFF" : "#000000";
}

function parseColor(color: string | null | undefined): [number, number, number] | null {
    if (!color)
        return null;

    const text = color.trim();

    if (text.startsWith("#")) {
        const hex = text.slice(1);
        if (hex.length == 3)
            return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
        if (hex.length >= 6)
            return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
        return null;
    }

    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text);
    return m == null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}
