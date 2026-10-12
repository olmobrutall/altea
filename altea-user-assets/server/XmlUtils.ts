import { Enum } from "@altea/altea/data/enum";
import type { int } from "@altea/altea/data/basics";
import { QueryTokenEmbedded } from "../data/Queries";

// The readers every user-asset (de)serializer needs over a fast-xml-parser tree (see UserAssetsImporter's
// parseAssets): every ELEMENT is an array, a single child included, while an ATTRIBUTE (`@_Name`) stays a
// scalar string. One copy here instead of one per asset type.

/** The parser's attribute prefix: `x[A + "Name"]` reads the `Name` attribute. */
export const A = "@_";

/** An attribute (or text) as a string; `undefined` when absent. */
export function str(value: unknown): string | undefined {
    return value == null ? undefined : String(value);
}

/** A boolean attribute (`true` / `True`, as .NET writes it); `fallback` when absent. */
export function bool(value: unknown, fallback = false): boolean {
    if (value == null)
        return fallback;
    return value === true || String(value).toLowerCase() === "true";
}

/** A numeric attribute; `null` when absent. */
export function num(value: unknown): number | null {
    return value == null ? null : Number(value);
}

/** An integer attribute; `null` when absent. */
export function integer(value: unknown): int | null {
    return value == null ? null : Number(value) as int;
}

/** An enum attribute holding the member NAME, as its ordinal. An unknown member throws — the right
 *  behaviour for a malformed import. (Enum.toValue wants the narrow member-name union; XML gives a string.) */
export function toEnum<E extends Record<string, string | number>>(e: E, name: string): number {
    return Enum.toValue(e, name as Extract<keyof E, string>);
}

/** Like {@link toEnum}, but `fallback` when the attribute is absent or names no member. */
export function enumOr<E extends Record<string, string | number>>(e: E, name: string | undefined, fallback: number): number {
    if (name == undefined)
        return fallback;
    try {
        return toEnum(e, name);
    } catch {
        return fallback;
    }
}

/** The first (usually only) element of a parsed child; `undefined` when absent. */
export function first(value: unknown): Record<string, unknown> | undefined {
    const v = Array.isArray(value) ? value[0] : value;
    return v != null && typeof v === "object" ? v as Record<string, unknown> : undefined;
}

/** A parsed child as a list of elements. A text-only element (parsed as a bare string) comes back as
 *  `{ "#text": value }`, so a caller always reads a record. */
export function list(value: unknown): Record<string, unknown>[] {
    if (value == null)
        return [];
    const array = Array.isArray(value) ? value : [value];
    return array.map(v => typeof v === "object" && v != null ? v as Record<string, unknown> : { "#text": v });
}

/** The `childName` elements inside a wrapper element: `<Filters><Filter/>…</Filters>`. */
export function arr(wrapper: unknown, childName: string): Record<string, unknown>[] {
    return list(first(wrapper)?.[childName]);
}

/** A query token read from its string. */
export function token(tokenString: string): QueryTokenEmbedded {
    return QueryTokenEmbedded.create({ tokenString });
}

/** Whether two blobs hold the same bytes — to keep a loaded (immutable, or snapshotted) binary untouched. */
export function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array): boolean {
    return a != null && a.length === b.length && a.every((v, i) => v === b[i]);
}
