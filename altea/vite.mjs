// Vite plugins an altea application's client config uses.

const LAYER_ORDER = "@layer legacy, theme, base, semantic, components, app, utilities;";
const TAILWIND_DIRECTIVE = /@(?:import\s+["']tailwindcss|reference|apply|theme|source|utility|custom-variant|layer)\b/;
const LEADING_STATEMENT = /^\s*(?:@charset[^;]*;|@import[^;]*;|\/\*[\s\S]*?\*\/)/;
// An altea package's own stylesheet, in the workspace or installed (`@altea/altea-x/client/…`).
const ALTEA_PACKAGE_CSS = /[\\/]@?altea[\\/]altea(?:-[\w-]+)?[\\/](?:dist[\\/])?client[\\/]/;
// The semantic classes (and the component classes it imports): a layer of their own, under the packages' CSS.
const SEMANTIC_CSS = /[\\/]ui[\\/]semantic\.css$/;

/**
 * Layers every stylesheet that is not written for Tailwind (theme.css declares the order):
 *  - `legacy`: the libraries (Font Awesome). A Tailwind utility or an `sf-*` rule always beats them; inside
 *    the one layer they keep the order and specificity they had unlayered.
 *  - `semantic`: `ui/semantic.css` and the `components.css` it imports — the `sf-*` classes. Above the libraries,
 *    below the packages' own stylesheets, which adjust these classes and must keep winning.
 *  - `components`: an altea package's own stylesheet. It beats a library's rule whatever the specificity.
 *  - `app`: the application's own stylesheets. They beat every framework rule — that is how an app restyles
 *    altea — and still lose to a utility written on the element.
 */
export function alteaLegacyCssLayer() {
    return {
        name: "altea-legacy-css-layer",
        enforce: "pre",
        transform(code, id) {
            const [file, query] = id.split("?");
            if (!file.endsWith(".css") || /(^|&)(raw|url)\b/.test(query ?? ""))
                return null;

            if (TAILWIND_DIRECTIVE.test(code.replace(/\/\*[\s\S]*?\*\//g, "")))
                return null;

            // A BOM inside the layer block would become part of the first selector.
            let body = code.replace(/^﻿/, "");

            const layer = SEMANTIC_CSS.test(file) ? "semantic"
                : ALTEA_PACKAGE_CSS.test(file) ? "components"
                : /[\\/]node_modules[\\/]/.test(file) ? "legacy"
                : "app";
            const leading = [];
            for (let m = LEADING_STATEMENT.exec(body); m; m = LEADING_STATEMENT.exec(body)) {
                const statement = m[0].trim();
                if (statement.startsWith("@import") && !/\blayer\b/.test(statement))
                    leading.push(statement.replace(/;$/, ` layer(${layer});`));
                else
                    leading.push(statement);
                body = body.slice(m[0].length);
            }

            return { code: `${LAYER_ORDER}\n${leading.join("\n")}\n@layer ${layer} {\n${body}\n}\n`, map: null };
        },
    };
}

/** Every Base UI entry point the `ui` kit imports. */
const BASE_UI_ENTRIES = ["checkbox", "collapsible", "dialog", "menu", "popover", "progress", "radio", "radio-group", "select", "switch", "tabs", "tooltip"];

/**
 * Pre-bundles the kit's Base UI entry points at startup. Vite otherwise finds them only when a lazy
 * chunk first imports one (the UI kit page, a dialog with a radio group), re-optimizes, and answers
 * "504 Outdated Optimize Dep" until the page is reloaded — which altea also reports as a new deployment.
 */
export function alteaUiDeps() {
    return {
        name: "altea-ui-deps",
        config: () => ({ optimizeDeps: { include: BASE_UI_ENTRIES.map(e => "@base-ui/react/" + e) } }),
    };
}
