import type { UserConfigExport } from "vitest/config";

/** See the doc comment in vitest.shared.mjs — this only gives the call a type. */
export interface AlteaVitestOptions {
    /** Where the suites live, relative to the package. Default "test". */
    testDir?: string;
    /** tsconfig's rootDir, so the compiled twin can be found. Default "" (dist mirrors the package). */
    rootDir?: string;
    /** tsconfig's outDir. Default "dist". */
    outDir?: string;
    /** Loaded into the workers if present. Default ".env.postgres"; `--mode <name>` overrides it. */
    envFile?: string;
    /**
     * Whether the suites need the quote-transformer, and so must run tspc's output. Default true.
     * False only for quote-transformer-test, whose suites invoke the transformer rather than being
     * subject to it.
     */
    compiled?: boolean;
    /** Merged over the `test` block, for anything a package needs to differ on. */
    test?: Record<string, unknown>;
}

export declare function alteaVitestConfig(
    /** The caller's `import.meta.url` — how each package locates itself. */
    packageUrl: string,
    options?: AlteaVitestOptions,
): UserConfigExport;
