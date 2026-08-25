// Installs the extensionless-import resolver hook (loader.mjs) on the module loader, so a plain `node` run
// can execute the tspc-emitted, bundler-style dist JS without a bundling step — see loader.mjs.
//
// `registerHooks` (node >= 22.15) runs the hook SYNCHRONOUSLY on this thread. The off-thread alternative,
// `register("./loader.mjs", import.meta.url)`, turns every module resolution into a cross-thread round trip
// — ~1s of eastwind's terminal startup, which resolves 7.8k specifiers. Both are per-thread, and nothing in
// the workspace loads dist modules from a worker, so the reach is the same.
//
// This is the WORKSPACE-WIDE copy: it is published through the package's `exports`, so every other package
// and the app say `node --import @altea/altea/register.mjs` instead of keeping a duplicate. (This package's
// own scripts say `./register.mjs` — the file is right here.)
import { registerHooks } from "node:module";
import { resolve } from "./loader.mjs";

registerHooks({ resolve });
