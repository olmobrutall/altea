import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum's CacheMessage enum (Signum.Caching/CacheMessage.cs). altea message containers are
// `{ Member: msg("Default") }` objects; a bare `msg()` infers the English default from the PascalCase
// member name, and `.niceToString(...)` formats {0}/{1} and prefers a loaded translation.
export const CacheMessage = {
    Loading: msg(),
    CacheStatistics: msg("Cache statistics"),
    Disable: msg(),
    Enable: msg(),
    Clear: msg(),
    ServerBroadcast: msg("Server broadcast"),
    SqlDependency: msg("Sql dependency"),
    Tables: msg(),
    Lazies: msg(),
    InvalidationExceptions: msg("Invalidation exceptions"),
    LazyStats: msg("Lazy stats"),
    Type: msg(),
    Hits: msg(),
    Invalidations: msg(),
    Loads: msg(),
    LoadTime: msg("Load time"),
    NotLoaded: msg("Not loaded"),
    TableStats: msg("Table stats"),
    Table: msg(),
    Count: msg(),
};
