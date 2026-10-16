import * as React from "react";

/**
 * The design: `classic` (Bootstrap 5.3's look, exactly) or `modern` (modern.css: neutral tokens, a variable font,
 * compact density, flatter surfaces). Stamped as `data-design` on the root element, remembered like the theme
 * mode; an app's boot script reads the same key to stamp it before the first paint.
 */
export type Design = "classic" | "modern";

export const DESIGN_STORAGE_KEY = "sf-design";
const CHANGED = "sf-design-change";

export function getStoredDesign(): Design {
    try {
        return localStorage.getItem(DESIGN_STORAGE_KEY) === "modern" ? "modern" : "classic";
    } catch {
        return "classic";
    }
}

export function setDesign(design: Design): void {
    document.documentElement.dataset.design = design;
    try {
        localStorage.setItem(DESIGN_STORAGE_KEY, design);
    } catch {
        /* a locked-down browser: it still applies for this visit */
    }
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: design }));
}

/** The current design, following every change made through `setDesign`. */
export function useDesign(): Design {
    const [design, setState] = React.useState<Design>(() => (document.documentElement.dataset.design as Design | undefined) ?? getStoredDesign());
    React.useEffect(() => {
        const handler = (e: Event): void => setState((e as CustomEvent<Design>).detail);
        window.addEventListener(CHANGED, handler);
        return () => window.removeEventListener(CHANGED, handler);
    }, []);
    return design;
}
