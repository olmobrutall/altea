import { StartParameters } from "../utils/startParameters";

// Port of Signum's `EnumerableExtensions.JoinRelaxed` (Signum.Utilities). Joins what the DATABASE has
// ("current") to what the CODE declares ("should") by a key, and — crucially — REPORTS the keys that appear on
// only one side instead of silently dropping them. The join itself yields only the common keys, so a caller
// can build its cache from the rows it actually matched.
//
// This is the shape every startup cache in Signum uses (TypeLogic's TypeCaches, SymbolLogic, QueryLogic,
// EmailModelLogic / WordModelLogic / SMSModelLogic). Before it, altea open-coded "skip what doesn't match" in
// each of them, which loses the developer alert: a renamed entity, a removed symbol or a model class that was
// never synced would look like everything was fine.
//
// Whether a mismatch throws is StartParameters' decision (see that module): it throws in development so you
// run `sync`, and can be collected instead for a deployment that must start with a trailing schema.

export function joinRelaxed<K, C, S, R>(
    currentCollection: Iterable<C>,
    shouldCollection: Iterable<S>,
    currentKeySelector: (c: C) => K,
    shouldKeySelector: (s: S) => K,
    resultSelector: (current: C, should: S) => R,
    action: string,
): R[] {
    const current = new Map<K, C>();
    for (const c of currentCollection)
        current.set(currentKeySelector(c), c);

    const should = new Map<K, S>();
    for (const s of shouldCollection)
        should.set(shouldKeySelector(s), s);

    const extra = [...current.keys()].filter(k => !should.has(k));
    const missing = [...should.keys()].filter(k => !current.has(k));

    const differences = getDifferences(extra, missing);
    if (differences != undefined)
        StartParameters.reportDatabaseMismatch(new Error(`Mismatches ${action}:\n${differences}\nConsider Synchronize.`));

    const result: R[] = [];
    for (const [key, c] of current) {
        const s = should.get(key);
        if (s != undefined)
            result.push(resultSelector(c, s));
    }
    return result;
}

/** Signum's `GetDifferences` — the message body: what the DB has that the code doesn't ("Extra"), and what the
 *  code declares that the DB doesn't ("Missing"). undefined when the two agree. */
function getDifferences<K>(extra: K[], missing: K[]): string | undefined {
    const list = (keys: K[]): string => keys.map(k => "  " + String(k)).join(",\n");

    if (extra.length !== 0 && missing.length !== 0)
        return ` Extra:\n${list(extra)}\nMissing:\n${list(missing)}`;
    if (extra.length !== 0)
        return ` Extra:\n${list(extra)}`;
    if (missing.length !== 0)
        return ` Missing:\n${list(missing)}`;

    return undefined;
}
