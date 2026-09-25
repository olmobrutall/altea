import { readFileSync, writeFileSync } from "node:fs";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import type { Lite } from "@altea/altea/data/lite";
import { table } from "@altea/altea/server/table";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { GlobalLazy } from "@altea/altea/server/globalLazy";
import { SystemEventLogLogic } from "@altea/altea/server/systemEventLogLogic";
import { ConsoleSwitch } from "@altea/altea/server/consoleSwitch";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { SqlPreCommand, SqlPreCommandSimple, Spacing, combineCommands } from "@altea/altea/server/sync/sqlPreCommand";
import { openSqlFileRetry, syncFileName } from "@altea/altea/server/sync/openSqlFile";
import { Connector } from "@altea/altea/server/connection/connector";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { FieldReference } from "@altea/altea/server/schema/field";
import { updateSqlSync, insertSqlSyncGraph, deleteSqlSyncGraph, insertOwnedRowsSqlSync } from "@altea/altea/server/save";
import { AuthLogic } from "./AuthLogic";
import { MergeStrategy, RoleEntity, RoleEntity_InheritsFrom } from "../data/Role";
import { UserEntity } from "../data/User";
import { TypeConditionSymbol } from "../data/Rules";
import { ATTR, attrs, enumName, parseEnum, parseBool, boolText, type AuthImportCtx } from "./AuthRulesXml";

// Port of the AuthRules half of Signum.Authorization's AuthLogic.cs (ExportRules, ImportRulesScript,
// LoadRoles, SynchronizeRoles, ImportAuthRules, ImportExportAuthRules) — see port/Auth.md.
//
// One `<Auth>` document: a `<Roles>` section this file owns plus one section per dimension, each
// dimension registering its own block through `AuthLogic.registerXmlExporter` / `registerXmlImporter`.
//
// Divergences from Signum:
//  - The scripts have no `use <database>` line: they run on the connection that executes them.
//  - A dropped file row (its resource no longer exists) is listed as a `-- Skipped …` comment.
//  - ImportAuthRules does not re-run Schema.initialize(): every caller has.
export namespace AuthImportExport {

    const rolesReplacementKey = "Roles";

    // ---- Export ----------------------------------------------------------------------------------

    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: ATTR, format: true, suppressEmptyNode: true });

    /** Signum's ExportRules. */
    export async function exportAuthRules(): Promise<string> {
        await SystemEventLogLogic.log("Export AuthRules");

        const graph = await AuthLogic.roleGraph();
        const orderedRoleKeys = await AuthLogic.rolesInOrder(/* includeTrivialMerge */ false);
        const roleName = (key: string): string => graph.rolesByKey.get(key)?.name ?? key;

        const roleObjs = orderedRoleKeys.map(k => {
            const r = graph.rolesByKey.get(k)!;
            return attrs({
                Name: r.name,
                MergeStrategy: graph.getMergeStrategy(k) === MergeStrategy.Intersection ? "Intersection" : undefined,
                Contains: [...graph.relatedTo(k)].map(roleName).join(","),
                Description: r.description != null && r.description !== "" ? r.description : undefined,
            });
        });

        // Each dimension contributes its section, ordered by section name.
        const auth: Record<string, unknown> = { Roles: roleObjs.length ? { Role: roleObjs } : {} };
        const sections = await Promise.all(AuthLogic.xmlExportersInOrder().map(e => e({ orderedRoleKeys, roleName })));
        for (const { name, content } of sections.orderBy(s => s.name))
            auth[name] = content;

        return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n${builder.build({ Auth: auth })}`;
    }

    // ---- Import ----------------------------------------------------------------------------------

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        isArray: name => ["Role", "Type", "Permission", "Query", "Operation", "Property", "Condition"].includes(name),
    });

    interface XmlRole { Name: string; MergeStrategy?: string; IsTrivialMerge?: string; Contains?: string; Description?: string; }

    function parse(xml: string): { auth: Record<string, unknown>; roles: XmlRole[] } {
        const doc = parser.parse(xml) as { Auth?: Record<string, unknown> };
        const auth = doc.Auth ?? {};
        return { auth, roles: (auth.Roles as { Role?: XmlRole[] } | undefined)?.Role ?? [] };
    }

    const containsNames = (x: XmlRole): string[] => (x.Contains ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const mergeStrategyOf = (x: XmlRole): MergeStrategy => x.MergeStrategy != null ? parseEnum(MergeStrategy, x.MergeStrategy) : MergeStrategy.Union;

    function getOrThrow<V>(map: Map<string, V>, key: string): V {
        const v = map.get(key);
        if (v === undefined)
            throw new Error(`Key '${key}' not found`);
        return v;
    }

    /**
     * Signum's ImportRulesScript: the SQL that makes the stored rules what the file says, or undefined when
     * they already are. The ROLE GRAPH is not imported — it must already match (see synchronizeRoles), or
     * this throws {@link InvalidRoleGraphException}. A role only the database has gets a warning comment.
     */
    export async function importRulesScript(xml: string, interactive: boolean, autoReplacement?: Replacements["autoReplacement"]): Promise<SqlPreCommand | undefined> {
        const replacements = new Replacements();
        replacements.interactive = interactive;
        replacements.autoReplacement = autoReplacement;

        const { auth, roles } = parse(xml);
        const graph = await AuthLogic.roleGraph();
        let rolesDic = new Map([...graph.rolesByKey.values()].filter(r => !r.isTrivialMerge).map(r => [r.name, r.toLite() as Lite<RoleEntity>]));
        const rolesXml = new Map(roles.filter(x => x.IsTrivialMerge == null || !parseBool(x.IsTrivialMerge)).map(x => [x.Name, x]));

        replacements.askForReplacements(new Set(rolesXml.keys()), new Set(rolesDic.keys()), rolesReplacementKey);
        rolesDic = replacements.applyReplacementsToNew(rolesDic, rolesReplacementKey);

        try {
            const xmlOnly = [...rolesXml.keys()].filter(k => !rolesDic.has(k));
            if (xmlOnly.length > 0)
                throw new InvalidOperationError(`roles ${xmlOnly.join(", ")} not found on the database`);

            for (const [name, x] of rolesXml) {
                const r = getOrThrow(rolesDic, name);
                if (r.toString() !== x.Name)
                    throw new InvalidOperationError(`Role ${r} has been renamed to ${x.Name}`);

                const currentMergeStrategy = enumName(MergeStrategy, graph.getMergeStrategy(r.key()));
                const shouldMergeStrategy = enumName(MergeStrategy, mergeStrategyOf(x));
                if (currentMergeStrategy !== shouldMergeStrategy)
                    throw new InvalidOperationError(`Merge strategy of ${r} is ${currentMergeStrategy} in the database but is ${shouldMergeStrategy} in the file`);

                const currentTrivialMerge = graph.rolesByKey.get(r.key())!.isTrivialMerge;
                const shouldTrivialMerge = x.IsTrivialMerge != null && parseBool(x.IsTrivialMerge);
                if (currentTrivialMerge !== shouldTrivialMerge)
                    throw new InvalidOperationError(`${r} is Trivial Merge ${boolText(currentTrivialMerge)} in the database but is ${boolText(shouldTrivialMerge)} in the file`);

                joinStrict(
                    [...graph.relatedTo(r.key())].map(k => graph.rolesByKey.get(k)!.name),
                    containsNames(x).map(s => getOrThrow(rolesDic, s).toString()),
                    `subRoles of ${r}`);
            }
        } catch (e) {
            if (e instanceof InvalidOperationError)
                throw new InvalidRoleGraphException("The role graph does not match:\n" + e.message);
            throw e;
        }

        const dbOnlyWarnings = combineCommands(Spacing.Simple, [...rolesDic.keys()].filter(n => !rolesXml.has(n))
            .map(n => new SqlPreCommandSimple(`-- Alien role ${n} not configured!!`)));

        const caches = await TypeLogic.caches();
        const nameToType = new Map(caches.allTypeEntities().map(te => [te.cleanName, caches.getType(te.id)]));
        const skipped: string[] = [];
        const ctx: AuthImportCtx = {
            roles: rolesDic,
            replacements,
            nameToType,
            typeToEntity: ctor => caches.tryTypeToEntity(ctor)!,
            typeConditions: new Map((await SymbolLogic.cache(TypeConditionSymbol)).symbols().map(s => [s.key, s])),
            noteSkipped: (kind, resource) => {
                const line = `-- Skipped ${kind} ${resource} (not found)`;
                if (!skipped.includes(line)) skipped.push(line);
            },
        };

        const sections: (SqlPreCommand | undefined)[] = [];
        for (const importer of AuthLogic.xmlImporters())
            sections.push(await importer(auth, ctx));
        const result = combineCommands(Spacing.Triple, sections);

        if (replacements.hasReplacements())
            SafeConsole.writeLineColor(Color.red, "There are renames! Remember to export after executing the script");

        if (result == null && dbOnlyWarnings == null)
            return undefined;

        return SqlPreCommand.combine(Spacing.Triple,
            new SqlPreCommandSimple("-- BEGIN AUTH SYNC SCRIPT"),
            dbOnlyWarnings,
            combineCommands(Spacing.Simple, skipped.map(s => new SqlPreCommandSimple(s))),
            result,
            new SqlPreCommandSimple("-- END AUTH SYNC SCRIPT"));
    }

    /**
     * Signum's ImportAuthRules: build the script without asking (a rename is answered by `autoReplacement`,
     * or fails), print it and run it in one transaction — for deploys and code migrations.
     */
    export async function importAuthRules(xml: string, autoReplacement?: Replacements["autoReplacement"]): Promise<void> {
        const script = await importRulesScript(xml, false, autoReplacement);
        if (script == null) {
            SafeConsole.writeLineColor(Color.green, "AuthRules already synchronized");
            return;
        }

        await Transaction.create(async () => {
            SafeConsole.writeLineColor(Color.yellow, "Executing AuthRules changes...");
            SafeConsole.writeLineColor(Color.darkYellow, script.plainSql());
            await Connector.current().executeNonQuery(script.plainSql());
        });
        GlobalLazy.resetAll(false);

        await SystemEventLogLogic.log("Import AuthRules");
    }

    // ---- Roles -----------------------------------------------------------------------------------

    /** Signum's LoadRoles: create the file's `<Roles>` (a new database has none). */
    export async function loadRoles(xml: string): Promise<void> {
        const roleInfos = parse(xml).roles.map(x => ({
            name: x.Name,
            mergeStrategy: mergeStrategyOf(x),
            isTrivialMerge: x.IsTrivialMerge != null && parseBool(x.IsTrivialMerge),
            subRoles: containsNames(x),
            description: x.Description ?? null,
        }));

        const roles = new Map(roleInfos.map(a => [a.name, RoleEntity.create({
            name: a.name,
            mergeStrategy: a.mergeStrategy,
            isTrivialMerge: a.isTrivialMerge,
            description: a.description,
        })]));

        for (const ri of roleInfos)
            roles.get(ri.name)!.inheritsFrom = ri.subRoles.map(r => RoleEntity_InheritsFrom.create({ inheritsFrom: getOrThrow(roles, r).toLite() }));

        // Signum saves the list as one graph; here each role goes once the roles it contains have ids.
        const pending = [...roleInfos];
        while (pending.length > 0) {
            const ready = pending.filter(ri => ri.subRoles.every(s => !getOrThrow(roles, s).isNew));
            if (ready.length === 0)
                throw new Error(`The roles ${pending.map(p => p.name).join(", ")} contain each other`);
            for (const ri of ready) {
                await roles.get(ri.name)!.save();
                pending.splice(pending.indexOf(ri), 1);
            }
        }
    }

    /**
     * Signum's SynchronizeRoles, in its two parts: the roles themselves (created / deleted / updated), then
     * their `Contains` and the trivial-merge names. Interactive, each part is a script shown through
     * openSqlFileRetry (saved in `syncDirectory`); otherwise the changes are saved directly — and a deleted
     * role's users are moved to another role first.
     */
    export async function synchronizeRoles(xml: string, interactive: boolean, syncDirectory: string, autoReplacement?: Replacements["autoReplacement"]): Promise<void> {
        const schema = Connector.current().schema;
        const table = schema.table(RoleEntity);
        const inheritsFromTable = schema.table(RoleEntity_InheritsFrom);
        const sb = Connector.current().sqlBuilder;

        const rolesXml = new Map(parse(xml).roles.map(x => [x.Name, x]));

        const dbRoles = new Map((await retrieveRoles()).filter(a => !a.isTrivialMerge).map(r => [r.toLite().key(), r]));
        let rolesDic = new Map([...(await AuthLogic.rolesInOrder(false))].reverse().map(k => getOrThrow(dbRoles, k)).map(r => [r.name, r]));

        const replacements = new Replacements();
        replacements.interactive = interactive;
        replacements.autoReplacement = autoReplacement;

        replacements.askForReplacements(new Set(rolesDic.keys()), new Set(rolesXml.keys()), rolesReplacementKey);
        rolesDic = replacements.applyReplacementsToOld(rolesDic, rolesReplacementKey);

        {
            console.log("Part 1: Synchronize roles without relationships");

            const roleInsertsDeletes = await synchronizeAsync(Spacing.Double, rolesXml, rolesDic,
                async (name, x) => {
                    const newRole = RoleEntity.create({
                        name,
                        mergeStrategy: mergeStrategyOf(x),
                        description: x.Description ?? null,
                        isTrivialMerge: false,
                        inheritsFrom: [],
                    });

                    if (interactive)
                        return insertSqlSyncGraph(newRole);
                    console.log("Created:" + newRole.toString());
                    await newRole.save();
                    return undefined;
                },
                async (_name, role) => {
                    if (interactive) {
                        if (!await SafeConsole.ask(`Delete role '${role}' from the database?`))
                            return undefined;
                        return SqlPreCommand.combine(Spacing.Simple, deleteInheritedBy(role), await deleteSqlSyncGraph(role));
                    }

                    const roleLite = role.toLite() as Lite<RoleEntity>;
                    if ((await usersOf(roleLite)).length > 0) {
                        const alternative = role.inheritsFrom[0]?.inheritsFrom
                            ?? (await retrieveRoles()).find(a => !a.isTrivialMerge && enumName(MergeStrategy, a.mergeStrategy) === "Union" && a.inheritsFrom.length === 0)?.toLite() as Lite<RoleEntity> | undefined // Min User
                            ?? (() => { throw new Error(`Unable to find alternative role for ${role} to move the users to`); })();
                        const updated = await moveUsers(roleLite, alternative);
                        console.log(`Moved ${updated} users from role ${role} to ${alternative}`);
                    }

                    for (const tm of (await retrieveRoles()).filter(a => a.isTrivialMerge && a.inheritsFrom.some(i => i.inheritsFrom.is(roleLite)))) {
                        const alternative = await AuthLogic.getOrCreateTrivialMergeRole(tm.inheritsFrom.map(i => i.inheritsFrom).filter(a => !a.is(roleLite)));
                        const tmLite = tm.toLite() as Lite<RoleEntity>;
                        if ((await usersOf(tmLite)).length > 0) {
                            const updated = await moveUsers(tmLite, alternative);
                            console.log(`Moved ${updated} users from role ${tm} to ${alternative}`);
                        }
                        await tm.delete();
                        console.log("Deleted:" + tm.toString());
                    }

                    await deleteInheritedBy(role).executeNonQuery();
                    await role.delete();
                    console.log("Deleted:" + role.toString());
                    return undefined;
                },
                async (name, x, role) => {
                    const oldName = role.name;
                    role.name = name;
                    role.mergeStrategy = mergeStrategyOf(x);
                    role.description = x.Description ?? null;
                    role.isTrivialMerge = false;
                    if (interactive)
                        return updateSqlSync(table, role)?.addComment(oldName);
                    if (role.isDirty()) {
                        console.log("Updated:" + role.toString());
                        await role.save();
                    }
                    return undefined;
                });

            if (interactive) {
                if (roleInsertsDeletes != null) {
                    await openSqlFileRetry(SqlPreCommand.combine(Spacing.Triple,
                        new SqlPreCommandSimple("-- BEGIN ROLE SYNC SCRIPT"),
                        roleInsertsDeletes,
                        new SqlPreCommandSimple("-- END ROLE  SYNC SCRIPT"))!, syncDirectory, scriptFileName("Auth_Roles"));

                    if (!await SafeConsole.ask("Did you run the previous script (Sync Roles)?"))
                        return;
                } else {
                    SafeConsole.writeLineColor(Color.green, "Already synchronized");
                }
                GlobalLazy.resetAll(false);
            }
        }

        {
            console.log("Part 2: Synchronize roles relationships and trivial merges");
            rolesDic = new Map((await retrieveRoles()).filter(a => !a.isTrivialMerge).map(r => [r.name, r]));
            rolesDic = replacements.applyReplacementsToOld(rolesDic, rolesReplacementKey);

            const parseInheritedFrom = (x: XmlRole): Lite<RoleEntity>[] => containsNames(x).map(rs => getOrThrow(rolesDic, rs).toLite() as Lite<RoleEntity>);

            const roleRelationships = await synchronizeAsync(Spacing.Double, rolesXml, rolesDic,
                () => { throw new Error("No new roles should be at this stage. Did you execute the script?"); },
                async () => undefined,
                async (_name, x, role) => {
                    const should = parseInheritedFrom(x);
                    const current = role.inheritsFrom.map(i => i.inheritsFrom.key());
                    if (should.length === current.length && should.every(s => current.includes(s.key())))
                        return undefined;

                    if (interactive) {
                        const removed = combineCommands(Spacing.Simple, await Promise.all(role.inheritsFrom.map(i => deleteSqlSyncGraph(i))));
                        role.inheritsFrom = should.map(s => RoleEntity_InheritsFrom.create({ inheritsFrom: s }));
                        return SqlPreCommand.combine(Spacing.Simple, updateSqlSync(table, role), removed, insertOwnedRowsSqlSync(role));
                    }
                    role.inheritsFrom = should.map(s => RoleEntity_InheritsFrom.create({ inheritsFrom: s }));
                    console.log("Updated:" + role.toString());
                    await role.save();
                    return undefined;
                });

            const trivialMerges: (SqlPreCommand | undefined)[] = [];
            for (const tr of (await retrieveRoles()).filter(a => a.isTrivialMerge)) {
                const name = AuthLogic.calculateTrivialMergeName(tr.inheritsFrom.map(i => i.inheritsFrom));
                if (tr.name === name)
                    continue;
                tr.name = name;
                if (interactive)
                    trivialMerges.push(updateSqlSync(table, tr));
                else
                    await tr.save();
            }
            const trivialMergesScript = combineCommands(Spacing.Double, trivialMerges);

            if (roleRelationships != null || trivialMergesScript != null) {
                await openSqlFileRetry(SqlPreCommand.combine(Spacing.Triple,
                    new SqlPreCommandSimple("-- BEGIN ROLE SYNC SCRIPT"),
                    roleRelationships,
                    trivialMergesScript,
                    new SqlPreCommandSimple("-- END ROLE  SYNC SCRIPT"))!, syncDirectory, scriptFileName("Auth_RoleRels"));

                if (!await SafeConsole.ask("Did you run the previous script (Sync Roles Relationships)?"))
                    return;
            } else {
                SafeConsole.writeLineColor(Color.green, "Already synchronized");
            }
        }

        GlobalLazy.resetAll(false);

        // The rows of OTHER roles that contain `role` (Signum's UnsafeDeletePreCommandMList over InheritsFrom).
        function deleteInheritedBy(role: RoleEntity): SqlPreCommandSimple {
            const column = (inheritsFromTable.fields["inheritsFrom"].field as FieldReference).column.name;
            return new SqlPreCommandSimple(
                `DELETE FROM ${sb.objectName(inheritsFromTable.name)} WHERE ${sb.sqlEscape(column)} = ${sb.isPostgres ? "$1" : "@p0"};`,
                [{ name: "p0", value: role.id }]).addComment(role.name);
        }
    }

    // Signum names each script "<prefix> {0:yyyy-MM-dd HH_mm_ss}.sql".
    const scriptFileName = (prefix: string): string => prefix + syncFileName(new Date()).slice("Sync".length);

    async function retrieveRoles(): Promise<RoleEntity[]> {
        return await table(RoleEntity).toArray() as RoleEntity[];
    }

    async function usersOf(role: Lite<RoleEntity>): Promise<UserEntity[]> {
        return await table(UserEntity).filter(u => u.role.is(role)).toArray() as UserEntity[];
    }

    // Signum's UnsafeUpdate of the users' role (altea has no unsafe update: each user is saved).
    async function moveUsers(from: Lite<RoleEntity>, to: Lite<RoleEntity>): Promise<number> {
        const users = await usersOf(from);
        for (const u of users) {
            u.role = to;
            await u.save();
        }
        return users.length;
    }

    // Signum's Synchronizer.SynchronizeScript, with async callbacks (a non-interactive sync saves as it goes).
    async function synchronizeAsync<N, O>(
        spacing: Spacing,
        newDictionary: Map<string, N>,
        oldDictionary: Map<string, O>,
        createNew: (key: string, n: N) => Promise<SqlPreCommand | undefined>,
        removeOld: (key: string, o: O) => Promise<SqlPreCommand | undefined>,
        mergeBoth: (key: string, n: N, o: O) => Promise<SqlPreCommand | undefined>,
    ): Promise<SqlPreCommand | undefined> {
        const list: (SqlPreCommand | undefined)[] = [];
        for (const key of new Set([...newDictionary.keys(), ...oldDictionary.keys()])) {
            const n = newDictionary.get(key);
            const o = oldDictionary.get(key);
            list.push(n === undefined ? await removeOld(key, o!) : o === undefined ? await createNew(key, n) : await mergeBoth(key, n, o));
        }
        return combineCommands(spacing, list);
    }

    // Signum's EnumerableExtensions.JoinStrict, for two name lists that must hold the same names.
    function joinStrict(current: string[], should: string[], action: string): void {
        const extra = current.filter(c => !should.includes(c));
        const missing = should.filter(s => !current.includes(s));
        if (extra.length === 0 && missing.length === 0)
            return;
        const indent = (list: string[]): string => list.join(",\n").split("\n").map(l => "  " + l).join("\n");
        const differences = extra.length > 0
            ? missing.length > 0 ? ` Extra:\n${indent(extra)}\nMissing:\n${indent(missing)}` : ` Extra: \n${extra.join(",\n")}`
            : ` Missing:\n${missing.join(",\n")}`;
        throw new InvalidOperationError(`Mismatches ${action}:\n${differences}`);
    }

    // ---- The console -----------------------------------------------------------------------------

    /**
     * Signum's ImportExportAuthRules: import / export / sync roles over `fileName`, the scripts saved in
     * `syncDirectory`. (Signum's `tmr`, the trivial-merge refactor, is not ported.)
     */
    export async function importExportAuthRules(fileName: string, syncDirectory: string): Promise<void> {
        const read = (): string => {
            process.stdout.write(`Reading ${fileName}...`);
            const xml = readFileSync(fileName, "utf8");
            console.log("Ok");
            return xml;
        };

        const importRules = async (): Promise<void> => {
            const xml = read();
            console.log("Generating SQL script to import auth rules (without modifying the role graph or entities):");
            let command: SqlPreCommand | undefined;
            try {
                command = await importRulesScript(xml, true);
            } catch (e) {
                if (!(e instanceof InvalidRoleGraphException))
                    throw e;
                SafeConsole.writeLineColor(Color.red, e.message);
                if (await SafeConsole.ask("Sync roles first?"))
                    await syncRoles();
                return;
            }

            if (command == null)
                SafeConsole.writeLineColor(Color.green, "Already synchronized");
            else
                await openSqlFileRetry(command, syncDirectory, scriptFileName("Auth"));

            GlobalLazy.resetAll(false);
        };

        const exportRules = async (): Promise<void> => {
            writeFileSync(fileName, await exportAuthRules(), "utf8");
            console.log(`Successfully exported to ${fileName}`);
        };

        const syncRoles = async (): Promise<void> => {
            const xml = read();
            console.log("Generating script to synchronize roles...");
            await synchronizeRoles(xml, true, syncDirectory);
            if (await SafeConsole.ask("Import rules now?"))
                await importRules();
        };

        const action = await new ConsoleSwitch<() => Promise<void>>("What do you want to do with AuthRules?")
            .add("i", "Import into database", importRules)
            .add("e", "Export to local folder", exportRules)
            .add("r", "Sync roles", syncRoles)
            .choose();

        await action?.();
    }
}

/** .NET's InvalidOperationException — what the role-graph checks throw before it is wrapped. */
class InvalidOperationError extends Error { }

/** Signum's InvalidRoleGraphException: the file's role graph is not the database's. */
export class InvalidRoleGraphException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidRoleGraphException";
    }
}
