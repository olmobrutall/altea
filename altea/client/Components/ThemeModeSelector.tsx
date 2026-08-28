import * as React from "react";
import { NavDropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconName } from "@fortawesome/fontawesome-svg-core";
import "@altea/altea/data/globals/stringExtensions";
import { useWindowEvent } from "../Hooks";

// Port of Signum's ThemeModeSelector (React/Components/ThemeModeSelector.tsx) — the navbar light / dark /
// auto picker. "auto" follows the OS through `prefers-color-scheme`; the choice is remembered, and bootstrap
// 5.3 does the rest through `data-bs-theme` (altea's own CSS hangs its dark rules off the same attribute:
// Lines.css, Search.css, Sidebar.css, DiffLog.css).
//
// Divergences from Signum:
//  - `data-bs-theme` is stamped on the ROOT element, where Signum stamps <body>. It is bootstrap's own
//    documented place for it, and it is the one an app's pre-React markup can already carry — eastwind's
//    index.html sets it from this same localStorage key before the bundle loads, so the loading splash comes
//    up in the right theme and there is no light flash. Descendant selectors like `[data-bs-theme=dark] .x`
//    match from either element, so nothing else changes.
//  - the SELECTED mode is persisted, not the resolved one. Signum writes `finalMode` ("dark" / "light"), so
//    picking "auto" stores whichever the OS happened to be and the choice is gone on the next load — "auto"
//    can never survive a reload, although it is the default. Fixed rather than mirrored.
//  - the icons are looked up by NAME (the app registers the free sets with `library.add`), altea's
//    convention, instead of importing the three definitions.
//  - the labels are not translated, exactly as in Signum: "Light" / "Dark" / "Auto" read the same in the
//    languages altea ships, and a message enum in core would have to be translated by every application.

/** The three states the picker offers: an explicit theme, or "follow the OS". */
export type ThemeMode = "light" | "dark" | "auto";

const THEME_MODES: ThemeMode[] = ["light", "dark", "auto"];

const ICONS: Record<ThemeMode, IconName> = {
    light: "sun",
    dark: "moon",
    auto: "circle-half-stroke",
};

export const STORAGE_KEY = "bootstrap-theme-mode";

/** Resolve a mode to a real theme, tracking the OS preference while it is "auto". */
export function useAuto(mode: ThemeMode): "dark" | "light" {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const get = (): "dark" | "light" => query.matches ? "dark" : "light";

    const [theme, setTheme] = React.useState<"dark" | "light">(mode === "auto" ? get() : mode);

    React.useEffect(() => {
        if (mode !== "auto") {
            setTheme(mode);
            return;
        }

        const fn = (): void => setTheme(get());
        query.addEventListener("change", fn);
        fn();
        return () => query.removeEventListener("change", fn);
    }, [mode]);

    return theme;
}

/** Read the stored choice — also what an app's boot script reads to theme its pre-React markup. */
export function getStoredThemeMode(): ThemeMode {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    return stored != null && THEME_MODES.includes(stored) ? stored : "auto";
}

export function ThemeModeSelector(p: { onSetMode?: (theme: "dark" | "light") => void }): React.ReactElement {

    const [mode, setMode] = React.useState<ThemeMode>(getStoredThemeMode);

    const theme = useAuto(mode);

    React.useEffect(() => {
        document.documentElement.dataset.bsTheme = theme;
        p.onSetMode?.(theme);
    }, [theme]);

    React.useEffect(() => {
        localStorage.setItem(STORAGE_KEY, mode);
    }, [mode]);

    // Signum's own channel for "a palette was picked that is dark / light, follow it" — the app-level
    // bootswatch selector dispatches it (Southwind's ThemeSelector).
    useWindowEvent("change-theme-mode", e => {
        const detail = (e as CustomEvent).detail as ThemeMode;
        if (THEME_MODES.includes(detail))
            setMode(detail);
    }, []);

    return (
        <NavDropdown id="changeTheme" className="sf-theme-mode-dropdown" data-theme-mode={mode}
            title={<FontAwesomeIcon icon={ICONS[mode]} title={mode.firstUpper()} />}
            aria-label={mode.firstUpper()}>
            {THEME_MODES.map(m =>
                <NavDropdown.Item key={m} data-theme-mode={m} active={mode === m} onClick={() => setMode(m)}>
                    <FontAwesomeIcon aria-hidden={true} icon={ICONS[m]} className="me-2" />
                    {m.firstUpper()}
                </NavDropdown.Item>
            )}
        </NavDropdown>
    );
}
