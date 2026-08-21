import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Administrator } from "@altea/altea/server/Administrator";
import { table as tableQuery } from "@altea/altea/server/table";
import { Synchronizer, Replacements } from "@altea/altea/server/sync/synchronizer";
import { SqlPreCommand, Spacing } from "@altea/altea/server/sync/sqlPreCommand";
import { insertSqlSyncGenerated, deleteSqlSync, updateSqlSync, copyRowFields } from "@altea/altea/server/save";
import { Entity } from "@altea/altea/data/entity";
import "@altea/altea/data/globals"; // Array.prototype.toMap
import type { SkillCodeInfo } from "../data/ChatbotProtocol";
import { SkillCodeEntity } from "../data/SkillCustomization";
import { describeParameters, SkillCode } from "./SkillCode";

// Port of Signum.Agent's SkillCodeLogic.cs — the registry that maps a `SkillCode` CLASS to its
// `SkillCodeEntity` row, and the schema generate/synchronize that keeps the table in step with the code.
//
// altea divergences, documented inline:
//  - the registry is keyed by CLASS NAME with a CONSTRUCTOR as the value (`Map<string, () => SkillCode>`),
//    not `Dictionary<string, Type>` + `Activator.CreateInstance`: TypeScript has no `Type` handle that can
//    be constructed from a string, so registration hands over a factory. `Register<T>()` becomes
//    `register(SearchSkill)` — the class itself, whose `.name` is the key.
//  - Signum's auto-register scope (`SkillCodeLogic.AutoRegister()`, set while an agent factory runs so the
//    base constructor self-registers) is not needed: nothing self-registers here, because a factory is
//    explicit. `AgentLogic.registerAgent` instead ASSERTS that every skill its factory produced is
//    registered — the same protection, checked at the same moment, without a global mode flag.
//  - `GetDefaultSkillCodeInfo` reads the DECLARED tools and properties (see SkillCode.ts) instead of
//    reflecting methods and attributes. `ReturnType` comes from the tool declaration.
export namespace SkillCodeLogic {

    export type SkillCodeClass = new () => SkillCode;

    /** Signum's `RegisteredCodes`. */
    const registeredCodes = new Map<string, SkillCodeClass>();

    let typeToEntity: ResetLazy<Map<string, SkillCodeEntity>> | undefined;

    /** Signum's `Register(Type)` / `Register<T>()`. */
    export function register(skillClass: SkillCodeClass): void {
        const already = registeredCodes.get(skillClass.name);
        if (already != undefined && already !== skillClass)
            throw new Error(`SkillCode '${skillClass.name}' is already registered with a different class.`);
        registeredCodes.set(skillClass.name, skillClass);
    }

    export function isRegistered(skillClass: SkillCodeClass): boolean {
        return registeredCodes.get(skillClass.name) === skillClass;
    }

    export function registeredClasses(): SkillCodeClass[] {
        return [...registeredCodes.values()];
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(SkillCodeEntity).withQuery();

        sb.schema.generating.push(schemaGenerating);
        sb.schema.synchronizing.push(synchronizeSkillCodes);

        // Signum's TypeToEntity / EntityToType pair; one lazy suffices here, since the class name is the
        // key on both sides (`entity.className` IS the class's name).
        typeToEntity = sb.globalLazy(async () => {
            const rows = await ExecutionMode.global(() => tableQuery(SkillCodeEntity).toArray());
            return rows.toMap(r => r.className);
        }, { invalidateWith: [SkillCodeEntity] });
    }

    /** Signum's `ToSkillCodeEntity(type)`. */
    export async function toSkillCodeEntity(skillClass: SkillCodeClass | string): Promise<SkillCodeEntity> {
        const className = typeof skillClass === "string" ? skillClass : skillClass.name;
        const map = await lazy().value();
        const entity = map.get(className);
        if (entity == undefined)
            throw new Error(`SkillCodeEntity for '${className}' not found — run a synchronize.`);
        return entity;
    }

    /** Signum's `ToType(codeEntity)` — the class a registry row names. */
    export function toClass(codeEntity: SkillCodeEntity): SkillCodeClass {
        const skillClass = registeredCodes.get(codeEntity.className);
        if (skillClass == undefined)
            throw new Error(`SkillCode class '${codeEntity.className}' is not registered.`);
        return skillClass;
    }

    /** A fresh instance of a registered class, by name (Signum's Activator.CreateInstance path). */
    export function create(className: string): SkillCode {
        const skillClass = registeredCodes.get(className);
        if (skillClass == undefined)
            throw new Error(`SkillCode type '${className}' is not registered.`);
        return new skillClass();
    }

    function lazy(): ResetLazy<Map<string, SkillCodeEntity>> {
        if (typeToEntity == undefined)
            throw new Error("SkillCodeLogic.start was not called");
        return typeToEntity;
    }

    // ---- introspection (Signum's GetDefaultSkillCodeInfo) --------------------------------------

    export function getDefaultSkillCodeInfo(instanceOrName: SkillCode | string): SkillCodeInfo {
        const instance = typeof instanceOrName === "string" ? create(instanceOrName) : instanceOrName;

        return {
            defaultShortDescription: instance.shortDescription,
            defaultInstructions: instance.originalInstructions,
            properties: instance.properties.map(p => ({
                propertyName: p.name,
                attributeName: p.attributeName,
                valueHint: p.valueHint ?? null,
                propertyType: p.propertyType,
                defaultValue: p.getAsString(),
            })),
            tools: instance.getTools().map(t => ({
                mcpName: t.name,
                description: t.description ?? null,
                returnType: t.returnType ?? "void",
                parameters: describeParameters(t.parameters),
            })),
            subSkills: instance.subSkills.map(ss => ({
                className: ss.code.name,
                activation: ss.activation,
                info: getDefaultSkillCodeInfo(ss.code),
            })),
        };
    }

    // ---- generate / synchronize (Signum's Schema_Generating / Schema_Synchronizing) ------------

    /** The rows that SHOULD exist, keyed by class name. */
    export function shouldRowsForSync(): Map<string, SkillCodeEntity> {
        return new Map([...registeredCodes.keys()]
            .sort()
            .map(className => [className, SkillCodeEntity.create({ className })]));
    }

    function schemaGenerating(schema: Schema): SqlPreCommand | undefined {
        const table = schema.tryTable(SkillCodeEntity);
        if (table == null)
            return undefined;

        const should = [...shouldRowsForSync().values()];
        if (should.length === 0)
            return undefined;

        return SqlPreCommand.combine(Spacing.Simple,
            ...should.map(e => insertSqlSyncGenerated(table, e as unknown as Entity)));
    }

    const skillCodeReplacementKey = "SkillCode";

    async function synchronizeSkillCodes(replacements: Replacements): Promise<SqlPreCommand | undefined> {
        const table = Connector.current().schema.tryTable(SkillCodeEntity);
        if (table == null)
            return undefined;

        const current = (await Administrator.tryRetrieveAll(SkillCodeEntity, replacements)).toMap(r => r.className);

        return Synchronizer.synchronizeScriptReplacing<SkillCodeEntity, SkillCodeEntity>(
            replacements,
            skillCodeReplacementKey,
            Spacing.Double,
            shouldRowsForSync(),
            current,
            (_k, e) => insertSqlSyncGenerated(table, e as unknown as Entity),
            (_k, c) => deleteSqlSync(table, c as unknown as Entity),
            (_k, e, c) => {
                // Matched (possibly through a RENAME): keep the persisted id, since every
                // SkillCustomization.skillCode FK points at it.
                copyRowFields(c as unknown as Entity, e as unknown as Entity);
                return updateSqlSync(table, c as unknown as Entity);
            },
        );
    }
}
