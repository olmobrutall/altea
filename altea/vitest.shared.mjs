// The ONE vitest setup for the whole workspace. Every package's vitest.config.ts is a call to this;
// nothing about the mechanism is duplicated per package, so a new package with tests is two lines.
//
// THE PROBLEM IT SOLVES
//
// The suites cannot be handed to vitest as TypeScript. Vite transforms TS with esbuild, which does not
// run TypeScript AST transformers — so the quote-transformer would never stamp the property lambdas, and
// every `.filter(a => a.name == x)` would reach the connector meaningless. But pointing vitest at
// `dist/**.js` instead makes the compiled JS the runner's idea of "the test file", which is then what you
// land in when you click a test.
//
// So vitest is pointed at the .ts files and `load` answers each one with the bytes tspc ALREADY produced,
// plus that file's source map. The identity stays .ts (tree, navigation and breakpoints are source); the
// code executed is what the build emits, so this path cannot disagree with tspc about `__quoted`. There
// is no second compilation anywhere here, which is the point: tests run the bytes that ship.
//
// A module must also have exactly ONE identity. Library code is reachable two ways — `../../server/foo`
// from a test, and `@altea/x/server/foo` from everywhere else — and if those resolve to different ids the
// module evaluates twice. Two copies means two registries, and a type registered through one is invisible
// to the other ("No query registered for RecentAlbumModel"). `resolveId` therefore redirects every library
// .ts to its dist twin, which is where the package exports already point. Test files are exempt: nothing
// imports them by package path, so they have no twin to collide with.
import { defineConfig } from "vitest/config";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param packageUrl  the caller's `import.meta.url` — how each package locates itself.
 * @param options
 *   testDir  where the suites live, relative to the package    (default "test")
 *   rootDir  tsconfig's rootDir, so the dist twin can be found (default "", i.e. dist mirrors the package)
 *   outDir   tsconfig's outDir                                 (default "dist")
 *   envFile  loaded into the workers if present                (default ".env.postgres";
 *            `--mode sqlserver` switches to `.env.sqlserver`, and so on for any mode)
 *   compiled whether the suites need the quote-transformer, and so must run tspc's output
 *            (default true). The one package where this is false is quote-transformer-test, whose
 *            suites INVOKE the transformer programmatically rather than being subject to it — so
 *            there is nothing to stamp, and vite may transform its TypeScript itself.
 *   test     merged over the `test` block, for anything a package needs to differ on
 */
export function alteaVitestConfig(packageUrl, options = {}) {
    const pkgRoot = fileURLToPath(new URL(".", packageUrl));
    const { testDir = "test", rootDir = "", outDir = "dist", envFile, compiled = true, test = {} } = options;

    const testRoot = path.resolve(pkgRoot, testDir);
    const sourceRoot = path.resolve(pkgRoot, rootDir);
    const distRoot = path.resolve(pkgRoot, outDir);

    const inside = (root, file) => {
        const rel = path.relative(root, file);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    };

    /** The file tspc compiled from this .ts, if it has been built. */
    const twin = file => {
        if (!inside(sourceRoot, file))
            return undefined;
        const js = path.join(distRoot, path.relative(sourceRoot, file).replace(/\.ts$/, ".js"));
        return existsSync(js) ? js : undefined;
    };

    const isTs = file => file.endsWith(".ts") && !file.includes("node_modules");

    const plugin = {
        name: "altea:tspc-output",
        enforce: "pre",

        // Library .ts → its dist twin, so it shares ONE identity with the package-export path.
        async resolveId(source, importer, opts) {
            const resolved = await this.resolve(source, importer, { ...opts, skipSelf: true });
            if (resolved == null || resolved.external)
                return resolved;
            const file = resolved.id.split("?")[0];
            if (!isTs(file) || inside(testRoot, file))
                return resolved;
            const js = twin(file);
            return js == null ? resolved : { ...resolved, id: js };
        },

        // Test .ts → tspc's compiled bytes, under the .ts identity.
        load(id) {
            const file = id.split("?")[0];
            if (!isTs(file) || !inside(testRoot, file))
                return null;
            const js = twin(file);
            if (js == null)
                return null;   // unbuilt: fall through, so the error names the real cause

            const code = readFileSync(js, "utf8");
            let map = null;
            if (existsSync(js + ".map")) {
                map = JSON.parse(readFileSync(js + ".map", "utf8"));
                // The map's `sources` are relative to dist/; point them at the real .ts so stack frames
                // and breakpoints land in the file the editor is showing.
                map.sources = [file];
                delete map.sourceRoot;
            }
            return { code, map };
        },
    };

    // Vite normalises module ids to forward slashes on every platform, so this needs no separator
    // escaping. `[.]` rather than an escaped dot for the same reason: fewer backslashes, fewer mistakes.
    // testDir is a plain folder name ("test", "src"); anything exotic would need escaping added here.
    const testFilePattern = new RegExp("/" + testDir + "/.*[.]ts$");

    return defineConfig(({ mode }) => {
        // One file at a time, because a package's suites share ONE database. It is also what makes the
        // destructive schema suite safe: sequentially, the gap between its drop and its reload falls
        // BETWEEN files rather than in the middle of ~95 others reading the same tables.
        const fileParallelism = test.fileParallelism ?? false;

        return {
            plugins: compiled ? [plugin] : [],
            // What the plugin serves is already JAVASCRIPT, but the id still ends in .ts, so vite would
            // hand it to esbuild's TypeScript transform anyway. That pass elides imports whose bindings it
            // believes are type-only, silently dropping the side-effect registrations the suites depend
            // on. These files need no transform at all — unless there is no plugin, in which case
            // esbuild IS the transform and must run.
            ...(compiled ? { esbuild: { exclude: [testFilePattern] } } : {}),
            test: {
                include: [`${testDir}/**/*.test.ts`],
                // Reaches the worker processes, which is where the suites read their connection variable.
                // `--mode <name>` picks the file, so a dialect switch is `vitest run --mode sqlserver`.
                env: {
                    // "test" is vitest's own default mode, i.e. nobody named one — so the package's
                    // default applies. Any other mode names the file directly, which is what makes
                    // `vitest run --mode sqlserver` (or `--mode dev`) the dialect/environment switch.
                    //
                    // asDefaults, and that matters: vitest MERGES `test.env` over the worker's process.env,
                    // so without it a file named here beats an environment the caller already chose. That
                    // is how `pnpm --filter eastwind test live` silently ran against .env.local — withEnv
                    // loaded the right file into the process and this config overwrote it. A file read here
                    // fills in what nobody has set; it never overrides.
                    ...asDefaults(readEnv(path.resolve(pkgRoot, mode === "test" ? (envFile ?? ".env.postgres") : `.env.${mode}`))),
                    // Only a sequential run may destroy the database — see test/destructive.env.
                    ...(fileParallelism ? {} : asDefaults(readEnv(path.resolve(pkgRoot, testDir, "destructive.env")))),
                },
                fileParallelism,
                testTimeout: 30_000,
                hookTimeout: 60_000,
                ...test,
            },
        };
    });
}

/**
 * Drop the keys the surrounding process already defines, so what is left only fills gaps.
 *
 * `test.env` is merged OVER process.env in the worker, which makes anything read from a file an override
 * unless it is filtered like this — and an override is exactly wrong here: a caller who named an
 * environment (scripts/withEnv.mjs loads it into the process) has already decided.
 */
function asDefaults(values) {
    return Object.fromEntries(Object.entries(values).filter(([k]) => process.env[k] == null || process.env[k] === ""));
}

/** Optional by design: a package with no such file simply contributes nothing. */
function readEnv(file) {
    if (!existsSync(file))
        return {};
    return Object.fromEntries(readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(l => l.trim() !== "" && !l.trim().startsWith("#") && l.includes("="))
        .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}
