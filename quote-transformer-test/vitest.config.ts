import { alteaVitestConfig } from "@altea/altea/vitest.shared.mjs";

// `compiled: false` — the ONE package where it is. These suites INVOKE the quote-transformer
// programmatically (they are its tests); they are not subject to it, so there is nothing to stamp and no
// need to run tspc's output. vite transforms this TypeScript itself, which is why the package has no dist.
export default alteaVitestConfig(import.meta.url, { testDir: "src", compiled: false });
