// Bundles each CLI's compiled dist/main.js into ONE committed file, cli/<tool>/bin/<tool>.js, with its
// dependencies inlined — so an application runs `node altea/cli/altea-clone/bin/altea-clone.js` without
// building or installing anything first. Run after `tsc -b` whenever a CLI (or altea-cli-utils) changes:
//
//     node cli/bundle.mjs
import * as path from "node:path";
import * as url from "node:url";
import { build } from "esbuild";

const cli = path.dirname(url.fileURLToPath(import.meta.url));

for (const tool of ["altea-clone", "altea-simplify"]) {
    await build({
        entryPoints: [path.join(cli, tool, "dist", "main.js")],
        outfile: path.join(cli, tool, "bin", `${tool}.js`),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        // A bundled CommonJS dependency still calls require() for node's built-ins, which ESM lacks.
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
        legalComments: "none",
        logLevel: "warning",
    });
    console.log(`bundled cli/${tool}/bin/${tool}.js`);
}
