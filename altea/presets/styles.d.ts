// Shared AMBIENT module declarations for the non-TypeScript files a client module side-effect-imports:
// `import "./Lines.css"`, `import "bootstrap/dist/css/bootstrap.min.css"`, `import "./x.xml?raw"`.
// The bundler (Vite) handles the real asset at build time; tsc only needs the module to EXIST.
//
// This file is the ONE copy for the whole workspace. It lives beside the presets rather than in
// `../client/` on purpose: `presets/` is claimed by no layer's include glob, so the file enters a
// program ONLY through the explicit `./styles.d.ts` entry in presets/client.json's `include` — a path
// relative to THIS directory (relative paths in an extended config resolve against the config they
// originated in, unlike the `${configDir}` ones around it). Were it inside `../client/`, every
// consuming project would also be pulling a file that belongs to @altea/altea's own client project.
//
// An ambient declaration only applies to the program that INCLUDES it, so a per-package copy used to
// be the only way; the preset-relative include is what replaces the 18 of them.
declare module "*.css";
declare module "*.scss";
declare module "*.xml?raw" {
    const content: string;
    export default content;
}
