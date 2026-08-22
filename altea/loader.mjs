// Node ESM resolver hook for running the tspc-emitted JS directly — the ONE copy for the whole workspace
// (every other package and the app reach it as `node --import @altea/altea/register.mjs`).
//
// Why it is needed: the shared preset compiles with moduleResolution "bundler" (presets/base.json), so
// sources use extensionless relative imports (`./sync/sqlBuilder`) and tsc emits them VERBATIM — while
// Node's ESM loader demands an explicit extension and rejects a directory import outright. Anything that
// runs the emitted dist/*.js under plain node — the test suites, the terminal host, the API server — needs
// this hook; vite does not, because it resolves like a bundler.
//
// It retries a failed extensionless specifier as `.js` then `/index.js`; the second covers folder barrels
// (`../data/globals` → `globals/index.js`), which Node rejects with ERR_UNSUPPORTED_DIR_IMPORT rather than
// ERR_MODULE_NOT_FOUND.
export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        if (err?.code !== "ERR_MODULE_NOT_FOUND" && err?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw err;
        const hasExt = /\.[mc]?js$/.test(specifier);
        if (hasExt || !(specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:/.test(specifier)))
            throw err;
        for (const cand of [specifier + ".js", specifier + "/index.js"]) {
            try { return await nextResolve(cand, context); } catch { /* try next */ }
        }
        throw err;
    }
}
