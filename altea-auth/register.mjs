// Registers the extensionless-import resolver hook (loader.mjs) on the module
// loader thread. Used via `node --import ./register.mjs` so `node --test` can
// run the tspc-emitted, bundler-style dist JS without a vite bundling step.
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
