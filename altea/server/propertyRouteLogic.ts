import "./index"; // installs Entity.save()/delete()
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "./schema/schemaBuilder";
import type { ResetLazy } from "./resetLazy";
import { table } from "./table";
import { Administrator } from "./Administrator";
import { Synchronizer, type Replacements } from "./sync/synchronizer";
import { SqlPreCommand, Spacing } from "./sync/sqlPreCommand";
import { deleteSqlSync, updateSqlSync } from "./save";
import { Connector } from "./connection/connector";
import { PropertyRouteEntity } from "../data/propertyRouteEntity";
import { TypeEntity } from "../data/typeEntity";
import { PropertyRoute, isPartType, storedMemberName } from "../data/propertyRoute";
import { legacyPropertyRoutesOf } from "../data/decorators";
import { cleanTypeName } from "../data/registration";
import { SafeConsole } from "./safeConsole";
import chalk from "chalk";
import { cleanModified } from "../data/changes";
import { registerAfterDeserialization } from "../data/serializer";
import type { Entity, Type } from "../data/entity";
import type { Lite } from "../data/lite";
import type { Schema } from "./schema/schema";

// Port of Signum's `PropertyRouteLogic` (Signum/Basics/PropertyRouteLogic.cs): the table with one row per
// property route, its two caches, and the synchronization that keeps the stored paths in step with the
// schema. See `data/propertyRouteEntity.ts` for why the table exists at all.
//
// The one structural thing to know is that the rows are **NOT seeded**. There is no `schema.generating`
// hook, and both the outer and inner `createNew` are undefined — exactly as in Signum. A route row is
// created lazily, by `toPropertyRouteEntity`, when something first needs to POINT at that route (an
// authorization rule, a property's help, a tour step, a translated instance), and it is saved as part of
// that consumer's graph. So a fresh database has an EMPTY property_route table and a Signum database keeps
// every row it has; the sync only removes rows whose route no longer exists and rewrites paths that were
// renamed. Seeding instead would mean a row for every property of every type — tens of thousands of rows on
// a real schema, almost none of them ever referenced.
//
// altea divergences:
//  - **the caches are keyed by STRING, never by an entity.** Signum keys `Properties` by `TypeEntity` and
//    `PropertiesFromLite` by `Lite<PropertyRouteEntity>`, which works there because an ambient EntityCache
//    hands back one instance per row. altea gives each query its own Retriever, so two reads of the same row
//    are different objects — hence `cleanName` and the lite's `key()` (the accommodation altea-workflow's
//    `keyOf` documents).
//  - **`should` is built from the MODEL, not from `TypeLogic.TryEntityToType(rep)`.** Nothing is ever
//    inserted, so the diff needs only (cleanName, path) pairs and never a TypeEntity id — which makes it
//    tolerant of a type with no persisted row yet by construction rather than by a tolerant lookup.
//  - **the `AfterDeserialization` hook needs a SYNC snapshot.** Signum registers one (so a
//    PropertyRouteEntity POSTed by an editor resolves onto its persisted row instead of inserting a
//    duplicate) and reads its GlobalLazy straight from it. altea's serializer is synchronous while a
//    ResetLazy is asynchronous, so the lazy is mirrored into `syncSnapshot` after `schema.initialize()` and
//    on every invalidation. A MIRROR, not a peek at the lazy: between an invalidation and the reload that
//    follows it the lazy has no value at all, and the hook cannot await one — so it would miss the row that
//    already exists and insert a duplicate, which the unique index then rejects (altea-auth's slice suite
//    reproduces exactly that). Keeping the previous map until the new one lands is what closes that window.
//  - `PropertyRouteProductionCleanup` is not ported: it exists in Signum for databases whose migrations only
//    fixed the routes known in dev, and altea's answer to an unparseable row is the same synchronizer that
//    removes it (`removeOld` below), which a migration runs anyway.
export namespace PropertyRouteLogic {
    /** cleanName → path → row (Signum's `Properties`). */
    export let properties: ResetLazy<Map<string, Map<string, PropertyRouteEntity>>>;

    /** lite key → row (Signum's `PropertiesFromLite`). */
    export let propertiesFromLite: ResetLazy<Map<string, PropertyRouteEntity>>;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(PropertyRouteEntity)
            .withQuery();

        sb.schema.synchronizing.push(synchronizeProperties);

        propertiesFromLite = sb.globalLazy(
            async () => new Map((await table(PropertyRouteEntity).toArray() as PropertyRouteEntity[])
                .map(pr => [pr.toLite().key(), pr])),
            { invalidateWith: [PropertyRouteEntity] });

        properties = sb.globalLazy(
            async () => {
                const result = new Map<string, Map<string, PropertyRouteEntity>>();
                for (const pr of (await propertiesFromLite.value()).values()) {
                    const cleanName = pr.rootType.cleanName;
                    let byPath = result.get(cleanName);
                    if (byPath == undefined)
                        result.set(cleanName, byPath = new Map<string, PropertyRouteEntity>());
                    byPath.set(pr.path, pr);
                }
                return result;
            },
            { invalidateWith: [PropertyRouteEntity] });

        // The SYNC mirror of `properties`, for the serializer hook below (see the header). Refreshed after
        // schema.initialize() and whenever a route row changes.
        // AWAITED, not fire-and-forget: the hook below is what stops a second POST of the same route from
        // inserting a duplicate (the unique index would then reject it), so the snapshot has to be current
        // by the time the save returns.
        sb.schema.initializing.push(warmUp);
        sb.schema.entityEvents(PropertyRouteEntity).saved.push(async () => { await warmUp(); });

        // Signum's `AfterDeserilization.Register<PropertyRouteEntity>`: an editor (a tour's css step, a
        // dynamic validation's sub-entity) builds the route client-side, where the row's id is unknowable,
        // so it arrives id-less. Point it at the row that already exists; leave it new when there is none,
        // which is what makes the save CREATE the row on demand.
        registerAfterDeserialization(PropertyRouteEntity, pr => {
            if (pr.rootType == null || pr.path == null)
                return;
            const found = syncSnapshot.get(pr.rootType.cleanName)?.get(pr.path);
            if (found == undefined)
                return;
            pr.id = found.id;
            pr.isNew = false;
            cleanModified(pr);
        });

        // LEGACY MODE: a Signum database has routes for members altea's model cannot generate — see
        // `extraSyncRoutes` and `declaredLegacyRoutes` below. Registered here rather than left to the app,
        // because reading a `@legacyPropertyRoute` declaration is framework machinery; WHICH members carry
        // one is each module's own business, declared beside the member.
        if (sb.settings.legacyMode)
            extraSyncRoutes.push(declaredLegacyRoutes);

        // Signum's `EntityEvents<TypeEntity>().PreDeleteSqlSync`: a sync that removes a TYPE has to remove
        // its routes first, or the type's DELETE fails on this table's FK. The outer level of
        // synchronizeProperties deliberately scripts nothing for a whole missing type (`removeOld`
        // undefined, as in Signum), so this cascade is the ONLY thing that cleans them up.
        sb.schema.entityEvents(TypeEntity).preDeleteSqlSync.push(type => deleteRoutesOfType(sb.schema, type));
    }

    /** Signum's `RetrieveFromCache` — the row a stored lite points at, throwing when it is gone. */
    export async function retrieveFromCache(route: Lite<PropertyRouteEntity>): Promise<PropertyRouteEntity> {
        const found = (await propertiesFromLite.value()).get(route.key());
        if (found == undefined)
            throw new Error(`PropertyRoute ${route.key()} is not in the database`);
        return found;
    }

    /** Signum's `TryGetPropertyRouteEntity(TypeEntity, path)`, also accepting the clean name directly. */
    export async function tryGetPropertyRouteEntity(rootType: TypeEntity | string, path: string): Promise<PropertyRouteEntity | undefined> {
        const cleanName = typeof rootType === "string" ? rootType : rootType.cleanName;
        return (await properties.value()).get(cleanName)?.get(path);
    }

    /**
     * Signum's `PropertyRoute.ToPropertyRouteEntity()` extension: the persisted row for this route, or a
     * NEW unsaved one when the route has never been referenced. Returning an unsaved row rather than
     * throwing is what makes the table demand-populated — the caller saves it as part of its own graph.
     */
    export async function toPropertyRouteEntity(route: PropertyRoute): Promise<PropertyRouteEntity> {
        route.assertNotPartRoot("A stored property route");
        const rootType = route.rootType.toTypeEntity();
        const path = route.propertyString();

        const prev = await tryGetPropertyRouteEntity(rootType, path);
        if (prev != undefined)
            return prev;

        return PropertyRouteEntity.create({ rootType, path });
    }

    /**
     * The SYNCHRONOUS counterpart of {@link toPropertyRouteEntity}, off the sync snapshot (see the header) —
     * for the callers that cannot await: the XML importers, which run inside a sync `fromXml`.
     *
     * Same contract: the persisted row, or a NEW unsaved one the caller's save then creates. It is also
     * Signum's `IFromXmlContext.GetPropertyRoute(typeEntity, path)`, minus the `SingleEx` scan — Signum
     * generates every route of the type and picks the matching one, which answers the same thing except
     * that a path naming no real route comes back as a row there and undefined-shaped nonsense here; so
     * this VALIDATES the path instead, and says which file is wrong.
     */
    export function propertyRouteEntitySync(rootType: TypeEntity, path: string): PropertyRouteEntity {
        const found = syncSnapshot.get(rootType.cleanName)?.get(path);
        if (found != undefined)
            return found;

        // Not referenced yet: check the path really is a route of the type before minting a row for it.
        // The ROOT is asserted rather than the parsed route's, because a path that re-roots would move
        // the question to a different type than the row actually stores.
        const ctor = resolveCtor(rootType);
        PropertyRoute.root(ctor).assertNotPartRoot("A stored property route");
        PropertyRoute.parse(ctor, path);
        return PropertyRouteEntity.create({ rootType, path });
    }

    /**
     * Signum's `GenerateProperties(type, typeEntity, forSync)`. `forSync` includes the ARRAY-ELEMENT routes,
     * because those are real routes a stored row may name and dropping them from `should` would delete
     * exactly those rows. (Signum calls the same flag `includeMListElements`.)
     */
    export function generateProperties(ctor: Function, rootType: TypeEntity, forSync: boolean): PropertyRouteEntity[] {
        return [...modelPaths(ctor, forSync)]
            .map(path => PropertyRouteEntity.create({ rootType, path }));
    }

    /**
     * NEW here (Signum needs no counterpart): extra `propertyString()`s a type's route set must be treated
     * as CONTAINING, beyond what `PropertyRoute.generateRoutes` yields from the model.
     *
     * It exists because the routes table is the one place a MODELLING difference between the two frameworks
     * turns into DATA LOSS. `should` is what the synchronizer diffs against the stored rows, and nothing is
     * ever inserted — so an entry here can only ever PRESERVE a row, never create one. A route altea cannot
     * name is otherwise offered as a rename of whatever sorts nearest and then DROPPED, taking with it every
     * consumer row that pointed at it (an authorization rule, a property's help, a tour step, a translated
     * instance) through the PropertyRouteEntity cascade.
     *
     * An ARRAY, as `simplifyDiffTables` is: several modules may each know about routes of their own. Each
     * handler is asked per mapped ENTITY type and returns paths spelled the way a stored path is spelled —
     * build them with `storedMemberName` rather than by hand, so they cannot drift from a real route's.
     *
     * NORMAL mode registers nothing: there the database is one altea generated, so it has no route the model
     * cannot name.
     */
    export const extraSyncRoutes: ((ctor: Function) => Iterable<string>)[] = [];

    /**
     * The model's route paths for a type, plus whatever {@link extraSyncRoutes} adds. A Set, so a handler
     * naming a route the model already has is a no-op rather than a duplicate.
     */
    export function modelPaths(ctor: Function, forSync: boolean): Set<string> {
        // A `@part` owns NO routes: its members are routes of the entity that owns it
        // (`AdditionalInformation/Key` on Product), which `generateRoutes` descends into from there. So
        // the part's own set is empty rather than a second spelling of the same members — see
        // PropertyRoute.assertNotPartRoot. It is what makes the synchronizer REMOVE a part-rooted row,
        // hence the migration note in the header: convert those rows before the sync, or they are
        // dropped and every consumer pointing at one goes with them.
        if (isPartType(ctor))
            return new Set();

        // `includeCasts` is ON here, so a `@part` reached through a POLYMORPHIC reference contributes its
        // members as routes of the owner (`parts/content.(TextPart).textContent`). It has to be on for the
        // SYNC as much as for the editors: `should` is what the synchronizer diffs the stored rows
        // against, so a cast route missing from it is a row DELETED — taking every consumer with it
        // through the cascade. It is a no-op in legacy mode, where `generateRoutes` suppresses casts
        // outright (a Signum database has no counterpart for one — see there).
        const result = new Set(PropertyRoute.generateRoutes(ctor, forSync, /* includeCasts */ true).map(pr => pr.propertyString()));
        for (const handler of extraSyncRoutes)
            for (const path of handler(ctor))
                result.add(path);
        return result;
    }

    /**
     * Signum's `RetrieveOrGenerateProperties`: every route of the type, each as its PERSISTED row where one
     * exists and a fresh unsaved one otherwise — what a property-rule editor binds to.
     */
    export async function retrieveOrGenerateProperties(rootType: TypeEntity): Promise<PropertyRouteEntity[]> {
        const ctor = resolveCtor(rootType);
        const retrieved = (await properties.value()).get(rootType.cleanName);

        return generateProperties(ctor, rootType, false)
            .map(should => retrieved?.get(should.path) ?? should);
    }
}

/**
 * The built-in `extraSyncRoutes` handler: the routes a type DECLARES with `@legacyPropertyRoute`.
 *
 * That decorator records the one thing altea's model cannot show — that the method was ported from a C#
 * **property**, which Signum's `GenerateRoutes` yields a route for. Nothing is derived: whether the
 * original was a property or an EXTENSION method (altea-tree's `descendants`, altea-printing's `lines`,
 * `entityNotes` — none of which Signum has a route for) is a fact about the port, and reading it off the
 * shape of the TypeScript would be guessing at the C# from its translation.
 *
 * The path is spelled by `storedMemberName`, the rule a real route uses, unless the declaration names the
 * Signum spelling outright — which is for a member altea deliberately renamed (`durationSeconds` where
 * Signum's property is `Duration`), where only the database still cares what it was called.
 *
 * Only the type's OWN members: a property on an EMBEDDED would be a dotted route (`Owner.address.Foo`),
 * which needs walking the embedded fields — no case needs it yet, and a handler can be added when one does.
 */
export function declaredLegacyRoutes(ctor: Function): string[] {
    return [...legacyPropertyRoutesOf(ctor)]
        .map(([member, signumName]) => signumName ?? storedMemberName(member));
}

// The SYNC mirror of PropertyRouteLogic.properties (see the header): cleanName → path → row.
let syncSnapshot = new Map<string, Map<string, PropertyRouteEntity>>();

async function warmUp(): Promise<void> {
    try {
        syncSnapshot = await PropertyRouteLogic.properties.value();
    } catch (e) {
        // A TRAILING schema: the table is absent, or present but not yet matching the model — which
        // includes reading a Signum database, where `basics.type` has no `package` column and this read
        // goes THROUGH the `rootType` reference. This runs from `schema.initializing`, which is exactly
        // what `create` / `sync` runs, so throwing here would kill the command that repairs it. Warn, run
        // with an empty snapshot, and let the sync proceed — the same accommodation every startup cache in
        // altea makes.
        syncSnapshot = new Map();
        SafeConsole.writeLineColor(chalk.yellow,
            "[propertyRoute] the routes table is not readable yet, running without the snapshot: "
            + (e instanceof Error ? e.message : String(e)));
    }
}

function resolveCtor(rootType: TypeEntity): Function {
    const ctor = [...Connector.current().schema.tables.keys()]
        .find(t => cleanTypeName(t) === rootType.cleanName);
    if (ctor == undefined)
        throw new Error(`Type '${rootType.cleanName}' is not a mapped entity type`);
    return ctor;
}

// Signum's `PropertyRouteLogic_PreDeleteSqlSync`: DELETE every route of a type being removed.
function deleteRoutesOfType(schema: Schema, type: TypeEntity): SqlPreCommand | undefined {
    const prTable = schema.tryTable(PropertyRouteEntity as never);
    if (prTable == null)
        return undefined;

    const rows = pendingRoutesByType.get(type.cleanName);
    if (rows == undefined || rows.length === 0)
        return undefined;

    return SqlPreCommand.combine(Spacing.Simple, ...rows.map(r => deleteSqlSync(prTable, r)));
}

// The rows read by the LAST synchronizeProperties run, grouped by root clean name. The PreDeleteSqlSync
// handler is SYNCHRONOUS (Signum's is too, because its Database.Query is), so it cannot read the table
// itself — and it does not need to: a type delete is scripted by the same sync pass, which read every row a
// moment earlier.
let pendingRoutesByType = new Map<string, PropertyRouteEntity[]>();

// Signum's `SynchronizeProperties`. Two levels, both with `createNew` undefined (nothing is ever seeded —
// see the header): the outer groups by root type, the inner diffs that type's paths and asks for RENAMES, so
// a member renamed in code rewrites the stored path instead of deleting the row every consumer points at.
async function synchronizeProperties(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const schema = Connector.current().schema;
    const prTable = schema.tryTable(PropertyRouteEntity as never);
    if (prTable == null)
        return undefined;

    const rows = await Administrator.tryRetrieveAll(PropertyRouteEntity, replacements);

    const current = new Map<string, Map<string, PropertyRouteEntity>>();
    for (const pr of rows) {
        const cleanName = pr.rootType.cleanName;
        let byPath = current.get(cleanName);
        if (byPath == undefined)
            current.set(cleanName, byPath = new Map<string, PropertyRouteEntity>());
        byPath.set(pr.path, pr);
    }

    pendingRoutesByType = new Map([...current].map(([k, v]) => [k, [...v.values()]]));

    // `should` from the MODEL (see the header): every route of every mapped type, array elements included,
    // plus whatever `extraSyncRoutes` names for a route the model cannot generate. Only the KEYS matter,
    // since nothing is inserted — which is also why an extra entry can only ever preserve a row.
    const should = new Map<string, Map<string, string>>();
    for (const t of schema.tables.keys()) {
        const ctor = t;
        if (typeof ctor !== "function")
            continue;
        should.set(cleanTypeName(ctor),
            new Map([...PropertyRouteLogic.modelPaths(ctor, true)].map(path => [path, path])));
    }

    return Synchronizer.synchronizeScript<string, Map<string, string>, Map<string, PropertyRouteEntity>>(
        Spacing.Double,
        should,
        current,
        undefined,
        undefined,
        (cleanName, shouldPaths, currentPaths) =>
            Synchronizer.synchronizeScriptReplacing<string, PropertyRouteEntity>(
                replacements,
                `Properties For:${cleanName}`,
                Spacing.Simple,
                shouldPaths,
                currentPaths,
                undefined,
                (_path, c) => deleteSqlSync(prTable, c),
                (path, _s, c) => {
                    // Matched, possibly through a RENAME: write the model's path onto the RETRIEVED row,
                    // which keeps its persisted id — every stored FK points at it. updateSqlSync returns
                    // undefined unless the path actually drifted.
                    c.path = path;
                    return updateSqlSync(prTable, c);
                },
            ),
    );
}
