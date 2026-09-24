// The parts of a token's fullKey (Signum's QueryUtils.SplitRegex): split on "." except inside "[…]", so an
// indexer key that is free text — `[Skill].[Node.js]` — stays one part. Every place that takes a stored or
// wire token string apart goes through this, so the server parser, the client resolver and the stored-token
// synchronizer cannot disagree about where a part ends.
const tokenSeparator = /(?<!\[[^\]]*)\.(?![^\[]*\])/;

export function splitTokenKey(fullKey: string): string[] {
    return fullKey.split(tokenSeparator).filter(p => p.length > 0);
}

/** The fullKey of the token's parent: every part but the last, or null for a single-part key. */
export function parentTokenKey(fullKey: string): string | null {
    const parts = splitTokenKey(fullKey);
    return parts.length <= 1 ? null : parts.slice(0, -1).join(".");
}
