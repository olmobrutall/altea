// Node ESM resolver hook for running the tspc-emitted test JS directly.
//
// altea is compiled with moduleResolution "bundler", so its emitted dist/*.js
// use extensionless relative imports (e.g. `./sync/sqlBuilder`) — fine for the
// vite server bundle, but Node's ESM loader requires explicit extensions. This
// hook retries a failed extensionless specifier as `.js` then `/index.js`, so
// `node --test` can run the compiled output without a bundling step.
export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
        const hasExt = /\.[mc]?js$/.test(specifier);
        if (hasExt || !(specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:/.test(specifier)))
            throw err;
        for (const cand of [specifier + ".js", specifier + "/index.js"]) {
            try { return await nextResolve(cand, context); } catch { /* try next */ }
        }
        throw err;
    }
}
