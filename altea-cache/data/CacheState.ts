// The wire shapes of the cache admin API (Signum's CacheController.cs DTOs: CacheStateTS / CacheTableTS /
// ResetLazyStatsTS + the broadcast request bodies). Declared ONCE in the DATA layer so the server builder
// and the React page share one definition instead of two hand-kept copies (the same convention
// altea-omnibox uses for its result DTOs).

// One cached table's statistics (Signum's CacheTableTS). `count` is null while the table has not been
// loaded yet — the panel shows "Not loaded" rather than 0, since 0 is also a legitimate row count.
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

// One global lazy's statistics (Signum's ResetLazyStatsTS).
export interface ResetLazyStatsTS {
    typeName: string;
    hits: number;
    invalidations: number;
    loads: number;
    sumLoadTime: string;
}

// The whole panel payload (Signum's CacheStateTS). `sqlDependency` is always false in altea — see
// CacheLogic's note: SQL Server query notifications have no Node driver equivalent — and is kept only so
// the panel reads the same as Signum's.
export interface CacheStateTS {
    isEnabled: boolean;
    sqlDependency: boolean;
    serverBroadcast: string | null;
    tables: CacheTableTS[];
    lazies: ResetLazyStatsTS[];
}

// The bodies of the two ANONYMOUS broadcast endpoints (Signum's InvalidateAllRequest /
// InvalidateTableRequest). They carry a shared secret, because they are reachable without a session:
// the sending process is a sibling server, not a user.
export interface InvalidateAllRequest {
    secretHash: string;
}

export interface InvalidateTableRequest {
    secretHash: string;
    methodName: string;
    argument: string;
    // altea: Signum sends machine name + application name to recognise its own message; a per-PROCESS id
    // is more precise (it tells two processes of the same app on one machine apart).
    origin: string;
}
