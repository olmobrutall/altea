import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { afterAll } from "vitest";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { GlobalLazy } from "@altea/altea/server/globalLazy";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims, type IUserEntity } from "@altea/altea/data/security";
import type { Lite } from "@altea/altea/data/lite";
import { toInt } from "@altea/altea/data/basics";
import { cleanTypeName } from "@altea/altea/data/registration";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { OperationSymbol } from "@altea/altea/data/operations";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { PropertyRouteLogic } from "@altea/altea/server/propertyRouteLogic";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { OperationAuthLogic } from "@altea/altea-auth/server/OperationAuthLogic";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { PropertyAuthLogic } from "@altea/altea-auth/server/PropertyAuthLogic";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity, RoleEntity_InheritsFrom, MergeStrategy } from "@altea/altea-auth/data/Role";
import {
    RuleTypeEntity, RuleTypeConditionEntity, RuleTypeConditionEntity_Condition,
    RulePropertyEntity, RuleOperationEntity, RulePermissionEntity,
    TypeAllowed, PropertyAllowed, OperationAllowed, TypeConditionSymbol,
} from "@altea/altea-auth/data/Rules";
import { PermissionSymbol, BasicPermission } from "@altea/altea/data/permissionSymbol";
import {
    SampleEntity, SamplePanelEntity, SampleWidgetEntity, SampleLogEntity,
    SampleOperation, SampleTypeCondition, SampleLogTypeCondition,
} from "../data/sample";
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
    /**
     * Sales' rules exactly (Sample type Read), PLUS `BasicPermission.AutomaticUpgradeOfProperties`. It
     * exists to pin the OTHER side of that gate: with the permission, a property carrying no rule of its
     * own follows its type (Read ⇒ read-only); without it — every other role here — it is hidden.
     */
    AutoUpgrade: "AuthTest_AutoUpgrade",
    /** Union + no parents. Sample: fallback None + condition [Public] → Read (row-level). */
    Restricted: "AuthTest_Restricted",
    /**
     * Union, inherits Restricted (so Sample stays None + [Public]→Read). SampleLog: fallback None +
     * condition [FilteringByTarget] → Read — the QUERY-AUDITOR condition, so this role sees a log row only
     * while its query pins the log's target to a Sample it may read.
     */
    LogReader: "AuthTest_LogReader",
} as const;

// Close the pooled connection when a file's tests finish (each `node --test` file is its own process).
//
// Only under the RUNNER: `generateEnvironment` imports this module from a plain `node` process (the
// `gen:postgres` script), where a suite hook has no suite to attach to and vitest throws "failed to find
// the current suite" before the generator can do anything. That made the one documented way to (re)build
// the test database unusable — which only showed once a schema change made a rebuild necessary.
if (process.env["VITEST"] != undefined)
    afterAll(async () => { await Connector.default?.closeConnection(); });

let started: Promise<Connector> | undefined;

// Connect + build the in-memory schema + register the auth stack — nothing else (no DDL, no seed).
export function start(options?: { initialize?: boolean }): Promise<Connector> {
    return (started ??= (async () => {
        const sb = new SchemaBuilder();
        const connector = await AuthTestStarter.connectorFromEnv(sb.schema, process.env.ALTEA_AUTH_TEST_DB!);
        Connector.default = connector;
        sb.settings.isPostgres = connector.isPostgres;
        // Tests mutate rule rows inside a rolled-back `Transaction.noCommit` scope and read them back
        // through the globalLazy caches — so make those reloads NEST in the ambient txn (read-your-writes)
        // instead of the production `Transaction.forceNew` (which reads committed state only).
        sb.schema.globalLazyReadUncommitted = true;
        AuthTestStarter.registerLogic(sb);
        sb.complete();
        // The generator skips it: on a database with no tables yet (a first run) there is nothing to read.
        if (options?.initialize !== false)
            await connector.schema.initialize();
        return connector;
    })());
}

// One-shot: drop/recreate the tables and seed the role/rule fixture. Run via `gen:*` before a test run.
export async function generateAuthEnvironment(): Promise<Connector> {
    // `start()` ends in `schema.initialize()`, which reads the type / symbol caches and THROWS on a
    // mismatch — and a stale database (a newly declared symbol with no row yet) is exactly the situation
    // `gen` exists to fix, so that pre-clean read has to be tolerant. Same seam the terminal's create/sync
    // uses (StartParameters.withIgnoredDatabaseMismatches); the mismatches are discarded because the very
    // next statements drop and regenerate everything.
    const { result: connector } = await StartParameters.withIgnoredDatabaseMismatches(() => start({ initialize: false }));
    // `start()` turns on globalLazyReadUncommitted for the TESTS, whose pattern is to mutate inside a
    // rolled-back scope and read back through the caches. The generator is not a test: it writes real
    // rows and its lazies are warmed by `schema.initialize()` below, whose promises outlive the ambient
    // transaction they were created in — so nesting (Transaction.create) hands them a finished
    // transaction and the first statement dies with "Transaction not started". Reading COMMITTED state
    // (Transaction.forceNew) is both correct here and what production does.
    connector.schema.globalLazyReadUncommitted = false;
    // Every global lazy was warmed by the start() above, against the database the next line DROPS — so
    // whatever they hold is about to become ids that no longer exist. Dropping every table is the
    // ultimate invalidation, but nothing tells them that (`invalidateWith` hooks entity events, and
    // cleanDatabase fires none). Left stale, PropertyRouteLogic's cache hands the seed a route that
    // looks SAVED, its `isNew` check skips the insert, and the rule pointing at it fails on the foreign
    // key — on every OTHER run, since a failed run leaves the table empty and the next one then works.
    GlobalLazy.resetAll(false);
    await connector.cleanDatabase();
    await connector.schema.generationScript()?.executeNonQuery();
    // NOT tolerant: after the regeneration the caches must load cleanly, or the fixture is wrong.
    await connector.schema.initialize();
    await seed();
    return connector;
}

// ---- Impersonation -------------------------------------------------------------------------------

const fakeUser = (): Lite<IUserEntity> => UserEntity.newLite(toInt(1), "impersonation");

/** Run `fn` as the current user of `role`. AuthLogic reads
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
    const autoUpgrade = await mkRole(Roles.AutoUpgrade, MergeStrategy.Union, []);
    const restricted = await mkRole(Roles.Restricted, MergeStrategy.Union, []);
    const logReader = await mkRole(Roles.LogReader, MergeStrategy.Union, [restricted]);

    const caches = await TypeLogic.caches();
    const typeId = caches.typeToId(SampleEntity);
    const typeLite = TypeEntity.newLite(typeId, cleanTypeName(SampleEntity));
    // A property rule points at a route ROW, so seed the two the rules below name.
    const secretRoute = await PropertyRouteLogic.toPropertyRouteEntity(PropertyRoute.parse(SampleEntity, "secret"));
    if (secretRoute.isNew)
        await secretRoute.save();
    const saveOp = OperationSymbol.newLite(SampleOperation.Save.id, SampleOperation.Save.key);
    const publicSym = TypeConditionSymbol.newLite(SampleTypeCondition.Public.id, SampleTypeCondition.Public.key);

    // Sales: single-dimension rules on Sample.
    await RuleTypeEntity.create({ role: sales.toLite(), resource: typeLite, fallback: TypeAllowed.Read, conditionRules: [] }).save();
    await RulePropertyEntity.create({ role: sales.toLite(), resource: secretRoute, fallback: PropertyAllowed.None, conditionRules: [] }).save();
    await RuleOperationEntity.create({ role: sales.toLite(), operation: saveOp, type: typeLite, fallback: OperationAllowed.Allow, conditionRules: [] }).save();

    // AutoUpgrade: Sales' type rule, plus the permission that turns an un-ruled property back into
    // "follow the type" instead of None.
    await RuleTypeEntity.create({ role: autoUpgrade.toLite(), resource: typeLite, fallback: TypeAllowed.Read, conditionRules: [] }).save();
    await RulePermissionEntity.create({
        role: autoUpgrade.toLite(),
        resource: PermissionSymbol.newLite(
            BasicPermission.AutomaticUpgradeOfProperties.id, BasicPermission.AutomaticUpgradeOfProperties.key),
        allowed: true,
    }).save();

    // Manager: overrides the type (Write) + secret (Read); NO Save rule → inherits Sales' Allow.
    await RuleTypeEntity.create({ role: manager.toLite(), resource: typeLite, fallback: TypeAllowed.Write, conditionRules: [] }).save();
    await RulePropertyEntity.create({ role: manager.toLite(), resource: secretRoute, fallback: PropertyAllowed.Read, conditionRules: [] }).save();

    // Restricted: row-level — fallback None, but [Public] → Read.
    await RuleTypeEntity.create({
        role: restricted.toLite(),
        resource: typeLite,
        fallback: TypeAllowed.None,
        conditionRules: [RuleTypeConditionEntity.create({
            rowOrder: toInt(0),
            allowed: TypeAllowed.Read,
            conditions: [RuleTypeConditionEntity_Condition.create({ symbol: publicSym })],
        })],
    }).save();

    // LogReader: the QUERY-AUDITOR condition on SampleLog — fallback None, [FilteringByTarget] → Read.
    const logTypeLite = TypeEntity.newLite(caches.typeToId(SampleLogEntity), cleanTypeName(SampleLogEntity));
    const filteringSym = TypeConditionSymbol.newLite(
        SampleLogTypeCondition.FilteringByTarget.id, SampleLogTypeCondition.FilteringByTarget.key);
    await RuleTypeEntity.create({
        role: logReader.toLite(),
        resource: logTypeLite,
        fallback: TypeAllowed.None,
        conditionRules: [RuleTypeConditionEntity.create({
            rowOrder: toInt(0),
            allowed: TypeAllowed.Read,
            conditions: [RuleTypeConditionEntity_Condition.create({ symbol: filteringSym })],
        })],
    }).save();

    // Data rows for the STANDALONE-part filter test: two Samples partitioned by `confidential`, each with a
    // panel (which carries a widget). Saving the owner auto-wires each part's @backReference up the chain, so
    // `panel.sample` / `widget.panel.sample` resolve — the navigation the part filter rebases the root's
    // [Public] condition onto. Restricted (fallback None + [Public]→Read) must see ONLY the public sample's
    // part(s) when the part is queried directly.
    await SampleEntity.create({
        name: "PublicSample", secret: "s", confidential: false,
        panels: [SamplePanelEntity.create({ title: "P-pub", secret: "s", widgets: [SampleWidgetEntity.create({ caption: "W-pub" })] })],
    }).save();
    await SampleEntity.create({
        name: "ConfidentialSample", secret: "s", confidential: true,
        panels: [SamplePanelEntity.create({ title: "P-conf", secret: "s", widgets: [SampleWidgetEntity.create({ caption: "W-conf" })] })],
    }).save();

    // One log row about each Sample. LogReader may read the PUBLIC one's log (its target is readable) and
    // not the confidential one's — but ONLY while the query says which target it is asking about.
    const pub = await table(SampleEntity).filter(s => s.name == "PublicSample").single() as SampleEntity;
    const conf = await table(SampleEntity).filter(s => s.name == "ConfidentialSample").single() as SampleEntity;
    await SampleLogEntity.create({ action: "log-public", target: pub.toLite() }).save();
    await SampleLogEntity.create({ action: "log-confidential", target: conf.toLite() }).save();
}
