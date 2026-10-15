// Vite plugins an altea application's client config uses.

const LAYER_ORDER = "@layer legacy, theme, base, components, utilities;";
const TAILWIND_DIRECTIVE = /@(?:import\s+["']tailwindcss|reference|apply|theme|source|utility|custom-variant|layer)\b/;
const LEADING_STATEMENT = /^\s*(?:@charset[^;]*;|@import[^;]*;|\/\*[\s\S]*?\*\/)/;

/**
 * Puts every stylesheet that is not written for Tailwind into the `legacy` cascade layer — Bootstrap,
 * react-widgets, and altea's own CSS until it is migrated — so a Tailwind utility or an `sf-*` component
 * rule always beats it. Inside the one layer they keep the order and specificity they had unlayered.
 *
 * Bootstrap's utilities lose their `!important`: an important declaration in an EARLIER layer beats every
 * later one, so `.mb-4 { margin-bottom: 1.5rem !important }` would override Tailwind's `mb-4` on every
 * element the class sweep rewrote. Within `legacy`, the utilities come last in bootstrap.css and still
 * beat its components.
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
            if (/[\\/]bootstrap[\\/]dist[\\/]css[\\/]/.test(file))
                body = body.replace(/\s*!important/g, "");

            const leading = [];
            for (let m = LEADING_STATEMENT.exec(body); m; m = LEADING_STATEMENT.exec(body)) {
                const statement = m[0].trim();
                if (statement.startsWith("@import") && !/\blayer\b/.test(statement))
                    leading.push(statement.replace(/;$/, " layer(legacy);"));
                else
                    leading.push(statement);
                body = body.slice(m[0].length);
            }

            return { code: `${LAYER_ORDER}\n${leading.join("\n")}\n@layer legacy {\n${body}\n}\n`, map: null };
        },
    };
}
