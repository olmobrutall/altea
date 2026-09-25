import type { PrimaryKey, Type, Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { RoleEntity } from "../data/Role";
import { Synchronizer, type Replacements } from "@altea/altea/server/sync/synchronizer";
import { SqlPreCommand, SqlPreCommandSimple, SqlPreCommandConcat, Spacing, combineCommands } from "@altea/altea/server/sync/sqlPreCommand";
import type { TypeEntity } from "@altea/altea/data/typeEntity";
import { Connector } from "@altea/altea/server/connection/connector";
import { updateSqlSync, insertSqlSyncGraph, deleteSqlSyncGraph, insertOwnedRowsSqlSync } from "@altea/altea/server/save";
import { TypeConditionSymbol, type RuleEntity } from "../data/Rules";

// Shared helpers for the AuthRules XML import/export, used by each dimension's `exportXml` / `importXml`
// — see port/Auth.md. The per-dimension logics own their section's
// row shape + how it maps to a rule; this module owns the mechanical bits (role grouping, section assembly,
// the per-role sync script, enum parsing) so they aren't repeated five times.

// fast-xml-parser XMLBuilder attribute prefix. The BUILDER marks attributes with this in the JS object; the
// PARSER reads them back as plain keys (attributeNamePrefix ""). The XML on the wire is identical either way.
export const ATTR = "@_";

// ---- Export ------------------------------------------------------------------------------------

export const attrs = (o: Record<string, string | undefined>): Record<string, string> => {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (v != null) r[ATTR + k] = v;
    return r;
};

// Group rule rows by their role key.
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
//
// Each dimension passes only the stored rules that still DIFFER from what the role would inherit — Signum's
// export filter (`where !allowed.Equals(allowedBase)`). A stored rule can stop mattering without being
// touched (its type rule changed, or a parent role's did) and the editor does not revisit the other
// dimensions when that happens: the export leaves it out, and importing the file removes it
// ({@link syncRulesScript}).
//
// Each role's rows are SORTED by `sortKey` — Signum's `orderby resource`, over the same resource string
// (`Resource`; a property's `Type|path`, an operation's `Key/Type`) — so the file is diffable: without it
// they came out in table order, and a rule re-saved in the editor moved to the end of its role.
export function section<T>(
    elementName: string,
    orderedRoleKeys: string[],
    roleName: (key: string) => string,
    byRole: Map<string, T[]>,
    rowObj: (row: T) => Record<string, unknown>,
    sortKey: (element: Record<string, unknown>) => string = e => attr(e, "Resource"),
): { Role: Record<string, unknown>[] } {
    const Role = orderedRoleKeys
        .filter(k => (byRole.get(k)?.length ?? 0) > 0)
        .map(k => ({
            ...attrs({ Name: roleName(k) }),
            [elementName]: byRole.get(k)!.map(rowObj)
                .map(e => ({ e, key: sortKey(e) }))
                .sort((a, b) => a.key.localeCompare(b.key, "en"))
                .map(x => x.e),
        }));
    return { Role };
}

/** An attribute of an element object built with {@link attrs} ("" when absent) — for a `section` sortKey. */
export const attr = (element: Record<string, unknown>, name: string): string => String(element[ATTR + name] ?? "");

// The nested `<Condition Name="a, b" Allowed="…">` rows of a conditioned rule (Type / Operation / Property),
// ordered by their persisted `rowOrder`. `enumName` renders the allowed value; `condKey` resolves each symbol id.
export function conditionsXml(
    rows: { rowOrder: number; allowed: number; conditions: { symbol: { id: PrimaryKey } }[] }[],
    enumName: (v: number) => string,
    condKey: (id: PrimaryKey) => string,
): Record<string, unknown>[] {
    return [...rows]
        .orderBy(a => a.rowOrder)
        .map(cr => attrs({
            Name: cr.conditions.map(c => condKey(c.symbol.id)).join(", "),
            Allowed: enumName(cr.allowed),
        }));
}

// ---- Import ------------------------------------------------------------------------------------

// The parsed shapes (XMLParser with attributeNamePrefix "", every element name in `isArray`).
export interface XmlCondition { Name: string; Allowed: string; }
export interface XmlRow { Resource: string; Allowed: string; Condition?: XmlCondition[]; }
export interface XmlRoleBlock { Name: string; Type?: XmlRow[]; Permission?: XmlRow[]; Query?: XmlRow[]; Operation?: XmlRow[]; Property?: XmlRow[]; }

export type XmlElem = "Type" | "Permission" | "Query" | "Operation" | "Property";

// Signum's replacement keys for the resources more than one section names.
export const typeReplacementKey = "AuthRules:TypeEntity";
export const typeConditionReplacementKey = "AuthRules:TypeConditionSymbol";

export interface AuthImportCtx {
    /** File role name → database role, after the role renames (Signum's `roles`). */
    roles: Map<string, Lite<RoleEntity>>;
    replacements: Replacements;
    /** Signum's TypeLogic.NameToType: the model types that have a TypeEntity row, by clean name. */
    nameToType: Map<string, Type<Entity>>;
    /** Signum's TypeLogic.TypeToEntity. */
    typeToEntity(ctor: Type<Entity>): TypeEntity;
    /** The TypeConditionSymbols, by key. */
    typeConditions: Map<string, TypeConditionSymbol>;
    /** A file row dropped because its resource no longer resolves — listed as a `-- Skipped` line. */
    noteSkipped(kind: string, resource: string): void;
}

/** The `<Role>` blocks of one section (`root.Element(rootName).Elements("Role")`). */
export function roleBlocks(auth: Record<string, unknown>, rootName: string): XmlRoleBlock[] {
    return (auth[rootName] as { Role?: XmlRoleBlock[] } | undefined)?.Role ?? [];
}

/** Every row of one element across a section's role blocks. */
export function sectionRows(auth: Record<string, unknown>, rootName: string, elem: XmlElem): XmlRow[] {
    return roleBlocks(auth, rootName).flatMap(rb => rb[elem] ?? []);
}

export function parseEnum<E extends Record<string, string | number>>(enumObj: E, name: string): E[keyof E] {
    const v = (enumObj as Record<string, unknown>)[name.trim()];
    if (typeof v !== "number")
        throw new Error(`Import: '${name}' is not a valid ${Object.keys(enumObj).filter(k => isNaN(Number(k)))[0] ?? "enum"} value`);
    return v as E[keyof E];
}

/** An enum value as its member name, whichever of the two a rule holds. */
export function enumName(enumObj: Record<string, string | number>, value: unknown): string {
    return typeof value === "number" ? String(enumObj[value]) : String(value);
}

/** .NET's bool.Parse. */
export function parseBool(s: string): boolean {
    const t = s.trim().toLowerCase();
    if (t !== "true" && t !== "false")
        throw new Error(`Import: '${s}' is not a valid Boolean`);
    return t === "true";
}

/** .NET's bool.ToString(). */
export const boolText = (b: boolean): string => b ? "True" : "False";

/** A `<Condition Name="a, b">`'s symbols, rename-applied; a name that is no symbol is dropped (Signum's TryToSymbol + NotNull). */
export function conditionSymbols(c: XmlCondition, ctx: AuthImportCtx): TypeConditionSymbol[] {
    return c.Name.split(",").map(s => s.trim()).filter(Boolean)
        .map(n => ctx.typeConditions.get(ctx.replacements.apply(typeConditionReplacementKey, n)))
        .filter((s): s is TypeConditionSymbol => s != null);
}

// ---- The import script -------------------------------------------------------------------------

export interface RuleSync<R extends RuleEntity> {
    rootName: string;
    elementName: XmlElem;
    /** The resource's nice name, for the comments (Signum's `typeof(R).NiceName()`). */
    resourceName: string;
    stored: R[];
    /** A stored rule's resource key (Signum's `ToKey(rt.Resource)`). */
    storedKey(rule: R): string;
    /** Signum's `toResource`: the file's `Resource` as that key, or undefined when it no longer resolves. */
    toResource(resource: string): string | undefined | Promise<string | undefined>;
    /** The resource as the comments print it (its `ToString()`); the key by default. */
    resourceText?(key: string): string;
    /** A new rule of `role` for the resource, holding the row's allowance (Signum's parseAllowed + SetRuleAllowed). */
    create(role: Lite<RoleEntity>, key: string, x: XmlRow): R | Promise<R>;
    /** Signum's `AllowedComment`. */
    allowedComment(rule: R): string;
    /** Signum's SetRuleAllowed + UpdateSqlSync: the SQL that gives `current` the allowance of `should`, or
     *  undefined when it already has it. */
    update(current: R, should: R): SqlPreCommand | undefined | Promise<SqlPreCommand | undefined>;
}

/**
 * Signum's AuthCache.ImportXmlInternal: the script that makes one dimension's stored rules what the file
 * says — a Synchronizer over role → resource → rule. A stored rule the file does not list is deleted and a
 * role missing from the section loses all its rules there; a resource that no longer resolves is dropped.
 * Rules are compared as stored: the export already left out the ones equal to what the role inherits.
 */
export async function syncRulesScript<R extends RuleEntity>(auth: Record<string, unknown>, ctx: AuthImportCtx, spec: RuleSync<R>): Promise<SqlPreCommand | undefined> {
    const current = new Map<string, R[]>();
    for (const rule of spec.stored) {
        const list = current.get(rule.role.key());
        if (list == null) current.set(rule.role.key(), [rule]); else list.push(rule);
    }

    const should = new Map<string, { role: Lite<RoleEntity>; rules: Map<string, R> }>();
    for (const rb of roleBlocks(auth, spec.rootName)) {
        const role = ctx.roles.get(rb.Name);
        if (role == null)
            throw new Error(`Key '${rb.Name}' not found in the roles of the file`);
        const rules = new Map<string, R>();
        for (const x of rb[spec.elementName] ?? []) {
            const key = await spec.toResource(x.Resource);
            if (key == null) continue;
            if (rules.has(key))
                throw new Error(`There are some repeated ${spec.resourceName} rules for ${role}: ${key}`);
            rules.set(key, await spec.create(role, key, x));
        }
        should.set(role.key(), { role, rules });
    }

    const text = (key: string): string => spec.resourceText?.(key) ?? key;
    const comment = (role: Lite<RoleEntity>, key: string, allowed: string): string =>
        `${spec.resourceName} ${text(key)} for ${role.toString()} (${allowed})`;
    const insert = (role: Lite<RoleEntity>, key: string, rule: R): SqlPreCommand =>
        addComment(insertSqlSyncGraph(rule), comment(role, key, spec.allowedComment(rule)))!;

    return Synchronizer.synchronizeScriptAsync(Spacing.Double, should, current,
        (_role, s) => combineCommands(Spacing.Simple, [...s.rules].map(([key, rule]) => insert(s.role, key, rule))),
        async (_role, rules) => combineCommands(Spacing.Simple, await Promise.all(rules.map(rule => deleteSqlSyncGraph(rule)))),
        (_role, s, rules) => Synchronizer.synchronizeScriptAsync(Spacing.Simple, s.rules, new Map(rules.map(r => [spec.storedKey(r), r])),
            (key, rule) => insert(s.role, key, rule),
            async (key, rule) => addComment(await deleteSqlSyncGraph(rule), comment(s.role, key, spec.allowedComment(rule))),
            async (key, sh, rule) => {
                const from = spec.allowedComment(rule);
                return addComment(await spec.update(rule, sh), `${spec.resourceName} ${text(key)} for ${s.role.toString()} (${from} -> ${spec.allowedComment(sh)})`);
            }));
}

/** Signum's AddComment on the first statement of a command. */
function addComment(command: SqlPreCommand | undefined, comment: string): SqlPreCommand | undefined {
    if (command instanceof SqlPreCommandSimple)
        return command.addComment(comment);
    if (command instanceof SqlPreCommandConcat && command.commands.length > 0)
        return new SqlPreCommandConcat(command.spacing, [addComment(command.commands[0], comment)!, ...command.commands.slice(1)]);
    return command;
}

/** `update` for a rule holding a single value (`allowed`, an enum read through `enumObj` when given). */
export function updateAllowed(enumObj?: Record<string, string | number>): <R extends RuleEntity & { allowed: unknown }>(current: R, should: R) => SqlPreCommand | undefined {
    const text = (v: unknown): string => enumObj != null ? enumName(enumObj, v) : String(v);
    return <R extends RuleEntity & { allowed: unknown }>(current: R, should: R): SqlPreCommand | undefined => {
        if (text(current.allowed) === text(should.allowed))
            return undefined;
        current.allowed = should.allowed;
        return updateSqlSync(Connector.current().schema.table(current.getType()), current);
    };
}

// The shape the Type / Operation / Property rules share: a fallback plus ordered, AND-ed condition rows.
export interface ConditionedRule extends RuleEntity {
    fallback: unknown;
    conditionRules: { rowOrder: number; allowed: unknown; conditions: { symbol: Lite<TypeConditionSymbol> }[] }[];
}

/** `allowedComment` / `update` for a conditioned rule, its allowances read through `enumObj`. */
export function conditionedRules<R extends ConditionedRule>(enumObj: Record<string, string | number>): {
    allowedComment(rule: R): string;
    update(current: R, should: R): SqlPreCommand | undefined | Promise<SqlPreCommand | undefined>;
} {
    // A stored rule's rows come back in table order; the evaluation order is `rowOrder`.
    const rowsKey = (rule: ConditionedRule): string => (rule.id == null ? rule.conditionRules : rule.conditionRules.orderBy(a => a.rowOrder))
        .map(cr => `${cr.conditions.map(c => String(c.symbol.id)).orderBy(k => k).join("&")}:${enumName(enumObj, cr.allowed)}`)
        .join(";");
    const fallback = (rule: ConditionedRule): string => enumName(enumObj, rule.fallback);
    return {
        // Signum's AllowedComment for a WithConditions.
        allowedComment(rule: R): string {
            return rule.conditionRules.length === 0 ? fallback(rule) : `${fallback(rule)} + ${rule.conditionRules.length} conditions`;
        },
        async update(current: R, should: R): Promise<SqlPreCommand | undefined> {
            const sameRows = rowsKey(current) === rowsKey(should);
            const sameFallback = fallback(current) === fallback(should);
            if (sameRows && sameFallback)
                return undefined;
            let update: SqlPreCommand | undefined;
            if (!sameFallback) {
                current.fallback = should.fallback;
                update = updateSqlSync(Connector.current().schema.table(current.getType()), current);
            }
            if (sameRows)
                return update;
            // The condition rows are REPLACED, as Signum rewrites the MList: the stored ones go, the file's go in.
            const removed = combineCommands(Spacing.Simple, await Promise.all(current.conditionRules.map(cr => deleteSqlSyncGraph(cr as unknown as Entity))));
            current.conditionRules = should.conditionRules;
            return SqlPreCommand.combine(Spacing.Simple, update, removed, insertOwnedRowsSqlSync(current));
        },
    };
}
