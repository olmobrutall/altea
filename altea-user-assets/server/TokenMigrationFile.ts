import { readFileSync, writeFileSync } from "node:fs";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import type { Replacements } from "@altea/altea/server/sync/synchronizer";


// Port of Signum.UserAssets' TokenMigrations/TokenMigrationFile.cs — see port/UserAssets.md.
//
// The serialized form of the rename decisions captured during a sync, plus the per-entity
// Skip/Delete/Regenerate choices.
//
// **The JSON is a CONTRACT.** A `.tokens.json` written by Signum must be readable here and vice versa —
// that is the whole point, for an application migrating between the two — so the property names, the
// bucket shapes and the string-or-array encoding are Signum's exactly, and an absent bucket is OMITTED
// rather than written as `null`. Do not "tidy" any of that.

/**
 * Which kind of rename is being recorded. Each bucket maps to a field below, and the `subKey` a lookup
 * needs is bucket-specific — see {@link TokenMigrationFile.tryGetDictionary}:
 *
 *  - `FilterValue` — subKey = `"queryKey|tokenString"`
 *  - `Types`       — no subKey. Covers Lite type renames in filter values AND query-key renames (a query
 *                    key is essentially a type's clean name, so one dict serves both).
 *  - `Member`      — subKey = the type's clean name
 *  - `Global`      — no subKey (flat)
 */
export type RenameBucket = "FilterValue" | "Types" | "Member" | "Global";

export type UserAssetEntityActionType = "Skip" | "Delete" | "Regenerate";

export interface UserAssetEntityAction {
    entityType: string;
    /** The asset's id — a string, since user assets are uuid-keyed. */
    guid: string;
    action: UserAssetEntityActionType;
}

/**
 * One or more candidate replacements for a renamed token, tried IN ORDER at resolution time.
 *
 * A single candidate is serialized as a plain string and several as an array, for compatibility with
 * files written before multi-candidate support. That encoding is part of the file CONTRACT, which is why
 * this is a union rather than always-an-array.
 */
export type StringOrArray = string | string[];

export function valuesOf(soa: StringOrArray | undefined): string[] {
    if (soa == null)
        return [];
    return typeof soa === "string" ? [soa] : soa;
}

/** Add a candidate unless it is already there. */
export function appendValue(soa: StringOrArray | undefined, newValue: string): StringOrArray {
    const values = valuesOf(soa);
    if (values.includes(newValue))
        return soa!;
    const next = [...values, newValue];
    return next.length === 1 ? next[0]! : next;
}

export function filterValueSubKey(queryKey: string, tokenString: string): string {
    return queryKey + "|" + tokenString;
}

/** The query synchronizer's Replacements key (see `loadTypes`). */
const QUERY_REPLACEMENTS_KEY = "QueryKey";

export class TokenMigrationFile {
    /** Query-rooted token renames (the first segment of a token path). Outer key = query key. */
    tokensByQuery?: Record<string, Record<string, StringOrArray>>;

    /** Type-rooted token renames (later segments, inside a type). Outer key = the type's clean name. */
    tokensByType?: Record<string, Record<string, StringOrArray>>;

    /** Filter-value renames. Outer key = `"queryKey|tokenString"`; inner = oldValue → newValue. */
    filterValues?: Record<string, Record<string, string>>;

    /**
     * Type renames — and query-key renames, since a query key is conventionally a type's clean name.
     * One dict covers both: Lite type renames inside filter values, and query renames flushed out of a
     * schema sync's Replacements into a `.query.json`.
     */
    types?: Record<string, string>;

    /** Member renames used by the template parser. Outer key = the type's clean name. */
    members?: Record<string, Record<string, string>>;

    /** Global-variable renames in templates. Flat: oldKey → newKey. */
    globals?: Record<string, string>;

    userAssetActions?: UserAssetEntityAction[];

    get isEmpty(): boolean {
        const empty = (o: object | undefined): boolean => o == null || Object.keys(o).length === 0;
        return empty(this.tokensByQuery)
            && empty(this.tokensByType)
            && empty(this.filterValues)
            && empty(this.types)
            && empty(this.members)
            && empty(this.globals)
            && (this.userAssetActions == null || this.userAssetActions.length === 0);
    }

    static load(filePath: string): TokenMigrationFile {
        const json = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(json) as Partial<TokenMigrationFile> | null;
        if (parsed == null)
            throw new Error("Empty token migration file: " + filePath);

        // Object.assign onto a real instance, so `isEmpty` and the methods are available on a loaded
        // file (JSON.parse alone would hand back a bare object).
        return Object.assign(new TokenMigrationFile(), parsed);
    }

    /** The wire form: indented, omitting an empty bucket — so both frameworks write the same bytes. */
    toJson(): string {
        const out: Record<string, unknown> = {};
        const put = (name: string, value: object | unknown[] | undefined): void => {
            if (value == null)
                return;
            if (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)
                out[name] = value;
        };
        // Signum's declaration order, so a diff between two frameworks' files is readable.
        put("tokensByQuery", this.tokensByQuery);
        put("tokensByType", this.tokensByType);
        put("filterValues", this.filterValues);
        put("types", this.types);
        put("members", this.members);
        put("globals", this.globals);
        put("userAssetActions", this.userAssetActions);
        return JSON.stringify(out, null, 2);
    }

    print(): void {
        SafeConsole.writeLine("New Token migration:");
        SafeConsole.writeLineColor(Color.darkGray, this.toJson());
    }

    save(filePath: string): void {
        writeFileSync(filePath, this.toJson(), "utf8");
        SafeConsole.writeLine("Json file saved in:  " + filePath);
    }

    /**
     * The dict for this bucket/subKey, or undefined. Callers walking
     * history use it to chain-compose a lookup across several files without flattening them first.
     */
    tryGetDictionary(bucket: RenameBucket, subKey?: string): Record<string, string> | undefined {
        switch (bucket) {
            case "FilterValue":
                return this.filterValues?.[subKey ?? subKeyRequired(bucket)];
            case "Types":
                return this.types != null && Object.keys(this.types).length > 0 ? this.types : undefined;
            case "Member":
                return this.members?.[subKey ?? subKeyRequired(bucket)];
            case "Global":
                return this.globals != null && Object.keys(this.globals).length > 0 ? this.globals : undefined;
        }
    }

    /** The recording side, so a new decision has somewhere to go. */
    getOrCreateDictionary(bucket: RenameBucket, subKey?: string): Record<string, string> {
        switch (bucket) {
            case "FilterValue": {
                const key = subKey ?? subKeyRequired(bucket);
                return ((this.filterValues ??= {})[key] ??= {});
            }
            case "Types":
                return (this.types ??= {});
            case "Member": {
                const key = subKey ?? subKeyRequired(bucket);
                return ((this.members ??= {})[key] ??= {});
            }
            case "Global":
                return (this.globals ??= {});
        }
    }

    /** The token dict for a query key or a type clean name, created if absent. */
    getOrCreateTokenDictionary(key: string, isQuery: boolean): Record<string, StringOrArray> {
        return isQuery
            ? ((this.tokensByQuery ??= {})[key] ??= {})
            : ((this.tokensByType ??= {})[key] ??= {});
    }

    /**
     * Drain a schema sync's QUERY renames into the `types` bucket.
     *
     * That bucket is where a query-key rename belongs precisely because a query key is a type's clean
     * name, so the same dict already serves Lite type renames in filter values.
     *
     * The Replacements key ("QueryKey") is an INTERNAL sync key, not part of the file — what lands in
     * `types` is old-key → new-key, which is why a file still round-trips between the two frameworks
     * although each spells that key differently.
     */
    loadTypes(rep: Replacements): void {
        const map = rep.tryGetC(QUERY_REPLACEMENTS_KEY);
        if (map == null || map.size === 0)
            return;
        this.types = Object.fromEntries(map);
    }
}

function subKeyRequired(bucket: RenameBucket): never {
    throw new Error(`Bucket '${bucket}' requires a non-null subKey.`);
}
