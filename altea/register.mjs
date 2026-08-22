// Registers the extensionless-import resolver hook (loader.mjs) on the module loader thread, so a plain
// `node` run can execute the tspc-emitted, bundler-style dist JS without a bundling step — see loader.mjs.
//
// This is the WORKSPACE-WIDE copy: it is published through the package's `exports`, so every other package
// and the app say `node --import @altea/altea/register.mjs` instead of keeping a duplicate. (This package's
// own scripts say `./register.mjs` — the file is right here.)
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
