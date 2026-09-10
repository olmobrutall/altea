// The wire shapes of the cache admin API — see docs/port/Cache.md.
//
// Declared ONCE in the DATA layer so the server builder and the React page share one definition instead of
// two hand-kept copies (the convention altea-omnibox uses for its result DTOs).

// One cached table's statistics. `count` is null while the table has not been loaded yet — the panel
// shows "Not loaded" rather than 0, since 0 is also a legitimate row count.
export interface CacheTableTS {
    tableName: string;
    typeName: string;
    count: number | null;
    hits: number;
    invalidations: number;
    loads: number;
    sumLoadTime: string;
    subTables?: CacheTableTS[];
    // ALTEA ADDITION: the columns a TRIMMED semi-cached lite table holds. "Only the display columns of only
    // the referenced rows" is the guarantee that keeps a cached Master type from dragging a Transactional
    // one into memory, so the panel shows it rather than leaving it to be trusted.
    columns?: string[];
}

export interface ResetLazyStatsTS {
    typeName: string;
    hits: number;
    invalidations: number;
    loads: number;
    sumLoadTime: string;
}

// The whole panel payload. `sqlDependency` is ALWAYS false — there are no query notifications to lean on
// (see docs/port/Cache.md) — and is kept only so the panel reads the same as Signum's.
export interface CacheStateTS {
    isEnabled: boolean;
    sqlDependency: boolean;
    serverBroadcast: string | null;
    tables: CacheTableTS[];
    lazies: ResetLazyStatsTS[];
}

// The bodies of the two ANONYMOUS broadcast endpoints. They carry a shared secret, because they are
// reachable without a session: the sending process is a sibling server, not a user.
export interface InvalidateAllRequest {
    secretHash: string;
}

export interface InvalidateTableRequest {
    secretHash: string;
    methodName: string;
    argument: string;
    // A per-PROCESS id, so two processes of the same app on one machine are told apart — which is what
    // lets a node safely list its own URL.
    origin: string;
}
