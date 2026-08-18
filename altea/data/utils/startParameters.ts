// Port of Signum's StartParameters (Signum.Utilities/StartParameters.cs). The best development experience is
// to THROW when the application and the database disagree at startup — but in some deployments it is better to
// start at all costs:
//
//   • green / blue deployments, where the app and the DB are briefly mismatched;
//   • a schema that legitimately trails the code (a fresh database before `terminal create` / `sync`).
//
// Enable that by ASSIGNING an array: every mismatch is then collected instead of thrown, and whoever enabled
// it decides what to do (log them, expose them on a diagnostics page, fail a health check).
//
// altea divergences:
//  - `IgnoredCodeErrors` is not ported: it exists for Signum's Dynamic (runtime-compiled entities), which altea
//    has no counterpart for. Add it with its first consumer, not before.
//  - `SelectCatch` is not ported for the same reason — nothing in altea produces it yet.

export namespace StartParameters {
    /** Assign an array to ENABLE tolerant startup (see the header); leave undefined to throw on a mismatch. */
    export let ignoredDatabaseMismatches: Error[] | undefined = undefined;

    /** Report a database/code mismatch: throws unless tolerant startup is enabled, in which case it is
     *  collected. Signum writes this as a `try { throw } catch (…) when (Ignored… != null)` precisely so the
     *  developer sees a real exception (with its stack) in development. */
    export function reportDatabaseMismatch(error: Error): void {
        if (ignoredDatabaseMismatches == undefined)
            throw error;

        ignoredDatabaseMismatches.push(error);
    }

    /** Run `fn` with tolerant startup enabled, returning whatever it collected. Used by the terminal's
     *  create / sync path: the schema is BEING brought up to date, so a mismatch is expected, not a fault. */
    export async function withIgnoredDatabaseMismatches<T>(fn: () => Promise<T>): Promise<{ result: T; mismatches: Error[] }> {
        const previous = ignoredDatabaseMismatches;
        const collected: Error[] = [];
        ignoredDatabaseMismatches = collected;
        try {
            return { result: await fn(), mismatches: collected };
        } finally {
            ignoredDatabaseMismatches = previous;
        }
    }
}
