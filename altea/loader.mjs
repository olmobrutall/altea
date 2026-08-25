// Node module resolver hook for running the tspc-emitted JS directly — the ONE copy for the whole workspace
// (every other package and the app reach it as `node --import @altea/altea/register.mjs`).
//
// Why it is needed: the shared preset compiles with moduleResolution "bundler" (presets/base.json), so
// sources use extensionless relative imports (`./sync/sqlBuilder`) and tsc emits them VERBATIM — while
// Node's ESM loader demands an explicit extension and rejects a directory import outright. Anything that
// runs the emitted dist/*.js under plain node — the test suites, the terminal host, the API server — needs
// this hook; vite does not, because it resolves like a bundler.
//
// It rewrites a relative extensionless specifier to `.js`, then to `/index.js`; the second covers folder
// barrels (`../data/globals` → `globals/index.js`), which Node rejects outright rather than falling back.
//
// The `.js` candidate is tried FIRST, before the specifier as written. Measured on eastwind's terminal
// (2.4k modules, 7.8k resolutions): ~1.6k of those specifiers are extensionless, so the "fallback" IS the
// common path, and reaching it by letting the bare resolve throw ERR_MODULE_NOT_FOUND cost ~0.4s of
// startup. A specifier node can already load as written (.js/.mjs/.cjs, .json, .node, .wasm) skips the
// rewrite entirely, and when neither candidate resolves the bare specifier is resolved LAST — so the error
// still names what the source actually wrote.
//
// Note this is a SYNCHRONOUS hook (module.registerHooks), not module.register's off-thread one — see
// register.mjs.

const RELATIVE = /^(?:\.{1,2}\/|\/|[a-zA-Z]:[\\/])/;
const LOADABLE = /\.(?:[mc]?js|json|node|wasm)$/;

export function resolve(specifier, context, nextResolve) {
    if (!RELATIVE.test(specifier) || LOADABLE.test(specifier))
        return nextResolve(specifier, context);

    try { return nextResolve(specifier + ".js", context); } catch { /* not a file — try as written */ }

    // The specifier AS WRITTEN comes before `/index.js`: a CJS `require('./sub')` of a directory resolves
    // through that directory's package.json `main`, which `/index.js` would silently override. ESM rejects
    // the directory (ERR_UNSUPPORTED_DIR_IMPORT), so a barrel falls through to the candidate below.
    try { return nextResolve(specifier, context); } catch { /* not a CJS directory — try the barrel */ }

    try { return nextResolve(specifier + "/index.js", context); } catch { /* report the original below */ }

    return nextResolve(specifier, context);
}
