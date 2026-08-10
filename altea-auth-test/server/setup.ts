import { after } from "node:test";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims, type IUserEntity } from "@altea/altea/data/security";
import type { Lite } from "@altea/altea/data/lite";
import { toInt } from "@altea/altea/data/basics";
import { cleanTypeName } from "@altea/altea/data/registration";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { OperationSymbol } from "@altea/altea/data/operations";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { OperationAuthLogic } from "@altea/altea-auth/server/OperationAuthLogic";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { PropertyAuthLogic } from "@altea/altea-auth/server/PropertyAuthLogic";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity, RoleEntity_InheritsFrom, MergeStrategy } from "@altea/altea-auth/data/Role";
import {
    RuleTypeEntity, RuleTypeConditionEntity, RuleTypeConditionEntity_Conditions,
    RulePropertyEntity, RuleOperationEntity,
    TypeAllowed, PropertyAllowed, OperationAllowed, TypeConditionSymbol,
} from "@altea/altea-auth/data/Rules";
import { SampleEntity, SampleOperation, SampleTypeCondition } from "../data/sample";
import { AuthTestStarter } from "./AuthTestStarter";

// Shared bootstrap for the authorization suite (the altea-auth analog of altea-test/server/setup.ts). A
// DB-backed suite `start()`s (connect + build the in-memory schema + register the auth stack); the schema
// + the ROLE/RULE fixture is generated ONCE out of band by `generateAuthEnvironment()` (the gen:* scripts).
// DB tests are gated on ALTEA_AUTH_TEST_DB, so the files still compile with no database.

export const hasDb = !!process.env.ALTEA_AUTH_TEST_DB;

// The fixture role names (seeded by generateAuthEnvironment). See the header of authRules.test.ts / the
// README for the shape (default-allowed, single-dimension rules, inheritance, a conditioned rule).
export const Roles = {
    /** Intersection + no parents ⇒ default-allowed TRUE: sees everything with no explicit rule (the "super"). */
    Super: "AuthTest_Super",
    /** Union + no parents ⇒ default-allowed FALSE: nothing without an explicit rule. */
    Base: "AuthTest_Base",
    /** Union, inherits Base. Sample: type Read, property `secret` None, operation Save Allow. */
    Sales: "AuthTest_Sales",
    /** Union, inherits Sales. Overrides Sample type Write + `secret` Read; INHERITS Save (auto-propagate). */
    Manager: "AuthTest_Manager",
    /** Union + no parents. Sample: fallback None + condition [Public] → Read (row-level). */
    Restricted: "AuthTest_Restricted",
} as const;

// Close the pooled connection when a file's tests finish (each `node --test` file is its own process).
after(async () => { await Connector.default?.closeConnection(); });

let started: Promise<Connector> | undefined;

// Connect + build the in-memory schema + register the auth stack — nothing else (no DDL, no seed).
export function start(): Promise<Connector> {
    return (started ??= (async () => {
        const sb = new SchemaBuilder();
        const connector = await AuthTestStarter.connectorFromEnv(sb.schema, process.env.ALTEA_AUTH_TEST_DB!);
        Connector.default = connector;
        sb.settings.isPostgres = connector.isPostgres;
        AuthTestStarter.registerLogic(sb);
        sb.complete();
        await connector.schema.initialize();
        return connector;
    })());
}

// One-shot: drop/recreate the tables and seed the role/rule fixture. Run via `gen:*` before a test run.
export async function generateAuthEnvironment(): Promise<Connector> {
    const connector = await start();
    await connector.cleanDatabase();
    await connector.schema.generationScript()?.executeNonQuery();
    await connector.schema.initialize();
    await seed();
    return connector;
}

// ---- Impersonation -------------------------------------------------------------------------------

const fakeUser = (): Lite<IUserEntity> => UserEntity.newLite(toInt(1), "impersonation") as unknown as Lite<IUserEntity>;

/** Run `fn` as the current user of `role` (Signum's `using (UserHolder.UserSession(...))`). AuthLogic reads
 *  the current role from the "Role" claim, so only that claim matters. */
export function asRole<R>(role: RoleEntity, fn: () => Promise<R>): Promise<R> {
    return UserHolder.withUser(new UserWithClaims(fakeUser(), { Role: role.toLite() }), fn);
}

/** Load a seeded fixture role by name (throws if absent — did `gen` run?). */
export async function role(name: string): Promise<RoleEntity> {
    const r = await table(RoleEntity).filter(x => x.name == name).singleOrNull() as RoleEntity | null;
    if (r == null)
        throw new Error(`Fixture role '${name}' not found — run the gen:* script first.`);
    return r;
}

/** Reset every auth cache (roles + all dimensions). For tests that MUTATE rules inside a transaction. */
export function resetAuthCaches(): void {
    AuthLogic.invalidateRoles();
    TypeAuthLogic.invalidate();
    PermissionAuthLogic.invalidate();
    OperationAuthLogic.invalidate();
    QueryAuthLogic.invalidate();
    PropertyAuthLogic.invalidate();
}

// ---- The fixture ---------------------------------------------------------------------------------

async function seed(): Promise<void> {
    const mkRole = async (name: string, strategy: MergeStrategy, parents: RoleEntity[]): Promise<RoleEntity> => {
        const r = RoleEntity.create({
            name,
            mergeStrategy: strategy,
            inheritsFrom: parents.map(p => RoleEntity_InheritsFrom.create({ inheritsFrom: p.toLite() })),
        });
        await r.save();
        return r;
    };

    await mkRole(Roles.Super, MergeStrategy.Intersection, []);
    await mkRole(Roles.Base, MergeStrategy.Union, []);
    const sales = await mkRole(Roles.Sales, MergeStrategy.Union, [await role(Roles.Base)]);
    const manager = await mkRole(Roles.Manager, MergeStrategy.Union, [sales]);
    const restricted = await mkRole(Roles.Restricted, MergeStrategy.Union, []);

    const typeId = TypeLogic.typeToId(SampleEntity);
    const typeLite = TypeEntity.newLite(typeId, cleanTypeName(SampleEntity));
    const saveOp = OperationSymbol.newLite(SampleOperation.Save.id, SampleOperation.Save.key);
    const publicSym = TypeConditionSymbol.newLite(SampleTypeCondition.Public.id, SampleTypeCondition.Public.key);

    // Sales: single-dimension rules on Sample.
    await RuleTypeEntity.create({ role: sales.toLite(), resource: typeLite, fallback: TypeAllowed.Read, conditionRules: [] }).save();
    await RulePropertyEntity.create({ role: sales.toLite(), rootType: typeLite, path: "secret", fallback: PropertyAllowed.None, conditionRules: [] }).save();
    await RuleOperationEntity.create({ role: sales.toLite(), operation: saveOp, type: typeLite, fallback: OperationAllowed.Allow, conditionRules: [] }).save();

    // Manager: overrides the type (Write) + secret (Read); NO Save rule → inherits Sales' Allow.
    await RuleTypeEntity.create({ role: manager.toLite(), resource: typeLite, fallback: TypeAllowed.Write, conditionRules: [] }).save();
    await RulePropertyEntity.create({ role: manager.toLite(), rootType: typeLite, path: "secret", fallback: PropertyAllowed.Read, conditionRules: [] }).save();

    // Restricted: row-level — fallback None, but [Public] → Read.
    await RuleTypeEntity.create({
        role: restricted.toLite(),
        resource: typeLite,
        fallback: TypeAllowed.None,
        conditionRules: [RuleTypeConditionEntity.create({
            order: toInt(0),
            allowed: TypeAllowed.Read,
            conditions: [RuleTypeConditionEntity_Conditions.create({ symbol: publicSym })],
        })],
    }).save();
}
