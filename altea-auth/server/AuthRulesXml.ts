import type { PrimaryKey } from "@altea/altea/data/entity";
import type { RoleEntity } from "../data/Role";
import type { Replacements } from "@altea/altea/server/sync/synchronizer";
import { TypeConditionSymbol } from "../data/Rules";

// Shared helpers for the AuthRules XML import/export, used by each dimension's `exportXml` / `importXml`
// (Signum's AuthCache.ExportXmlInternal / ImportXmlInternal). The per-dimension logics own their section's
// row shape + how it applies; this module owns the mechanical bits (role grouping, section assembly, the
// per-TYPE overlay loop, enum parsing) so they aren't repeated five times.

// fast-xml-parser XMLBuilder attribute prefix. The BUILDER marks attributes with this in the JS object; the
// PARSER reads them back as plain keys (attributeNamePrefix ""). The XML on the wire is identical either way.
export const ATTR = "@_";

// ---- Export ------------------------------------------------------------------------------------

export const attrs = (o: Record<string, string | undefined>): Record<string, string> => {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (v != null) r[ATTR + k] = v;
    return r;
};

// Group rule rows by their role key (Signum groups a dimension's rows per role).
export function groupByRole<T extends { role: { key(): string } }>(rows: T[]): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const r of rows) {
        const k = r.role.key();
        let g = m.get(k);
        if (g == null) { g = []; m.set(k, g); }
        g.push(r);
    }
    return m;
}

// Assemble a dimension section for the XMLBuilder object: `{ Role: [{ @_Name, <elementName>: [row…] }] }`,
// roles in dependency order, only roles that have rows. `rowObj` builds one element object from a rule row.
export function section<T>(
    elementName: string,
    orderedRoleKeys: string[],
    roleName: (key: string) => string,
    byRole: Map<string, T[]>,
    rowObj: (row: T) => Record<string, unknown>,
): { Role: Record<string, unknown>[] } {
    const Role = orderedRoleKeys
        .filter(k => (byRole.get(k)?.length ?? 0) > 0)
        .map(k => ({ ...attrs({ Name: roleName(k) }), [elementName]: byRole.get(k)!.map(rowObj) }));
    return { Role };
}

// The nested `<Condition Name="a, b" Allowed="…">` rows of a conditioned rule (Type / Operation / Property),
// ordered by their persisted `order`. `enumName` renders the allowed value; `condKey` resolves each symbol id.
export function conditionsXml(
    rows: { order: unknown; allowed: number; conditions: { symbol: { id: PrimaryKey } }[] }[],
    enumName: (v: number) => string,
    condKey: (id: PrimaryKey) => string,
): Record<string, unknown>[] {
    return [...rows]
        .sort((a, b) => Number(a.order) - Number(b.order))
        .map(cr => attrs({
            Name: cr.conditions.map(c => condKey(c.symbol.id)).join(", "),
            Allowed: enumName(cr.allowed),
        }));
}

// ---- Import ------------------------------------------------------------------------------------

// The parsed shapes (XMLParser with attributeNamePrefix "", every element name in `isArray`).
export interface XmlCondition { Name: string; Allowed: string; }
export interface XmlRow { Resource: string; Allowed: string; OnType?: string; Condition?: XmlCondition[]; }
export interface XmlRoleBlock { Name: string; Type?: XmlRow[]; Permission?: XmlRow[]; Query?: XmlRow[]; Operation?: XmlRow[]; Property?: XmlRow[]; }

export interface AuthImportCtx {
    /** The current-DB RoleEntity for an XML role name (rename-resolved), recording applied/skipped. */
    noteRole(xmlName: string): RoleEntity | undefined;
    /** Rename-apply a type clean-name / a condition-symbol key. */
    applyType(xmlName: string): string;
    applyCond(xmlName: string): string;
    /** Registered TypeConditionSymbols by key (post-rename lookup). */
    condSymByKey: Map<string, TypeConditionSymbol>;
    replacements: Replacements;
}

export function parseEnum<E extends Record<string, string | number>>(enumObj: E, name: string): E[keyof E] {
    const v = (enumObj as Record<string, unknown>)[name.trim()];
    if (typeof v !== "number")
        throw new Error(`Import: '${name}' is not a valid ${Object.keys(enumObj).filter(k => isNaN(Number(k)))[0] ?? "enum"} value`);
    return v as E[keyof E];
}

export function parseBool(s: string): boolean {
    return s.trim().toLowerCase() === "true";
}

// Resolve a `<Condition Name="a, b">` to its symbol lites (rename-aware).
export function condLites(c: XmlCondition, ctx: AuthImportCtx): { id: PrimaryKey; key: string }[] {
    return c.Name.split(",").map(s => s.trim()).filter(Boolean).map(n => {
        const s = ctx.condSymByKey.get(ctx.applyCond(n));
        if (s == null) throw new Error(`Import: TypeConditionSymbol '${n}' not found (after rename)`);
        return { id: s.id, key: s.key };
    });
}

// Apply a per-TYPE dimension section (Query / Operation / Property): for each role, group its rows by target
// type (the `OnType` attr, rename-applied) and by the row's identity key, then hand each type's rows to
// `apply` (which fetches the pack, overlays, and saves). Mirrors Signum's per-type SetRules.
export async function applyPerType(
    roleBlocks: XmlRoleBlock[] | undefined,
    elem: "Query" | "Operation" | "Property",
    ctx: AuthImportCtx,
    apply: (role: RoleEntity, typeName: string, byKey: Map<string, XmlRow>) => Promise<void>,
    identity: (r: XmlRow) => string,
): Promise<void> {
    for (const rb of roleBlocks ?? []) {
        const role = ctx.noteRole(rb.Name);
        if (role == null) continue;
        const rows = (rb as unknown as Record<string, XmlRow[]>)[elem] ?? [];
        const byType = new Map<string, Map<string, XmlRow>>();
        for (const r of rows) {
            const tn = ctx.applyType(r.OnType ?? r.Resource);
            let m = byType.get(tn);
            if (m == null) { m = new Map(); byType.set(tn, m); }
            m.set(identity(r), r);
        }
        for (const [typeName, byKey] of byType)
            await apply(role, typeName, byKey);
    }
}
