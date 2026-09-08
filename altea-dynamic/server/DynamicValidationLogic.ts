import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/fluentOperations";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { globalValidators } from "@altea/altea/data/reflection";
import type { FieldInfo, IntegrityCheckEnvironment } from "@altea/altea/data/reflection";
import type { Entity } from "@altea/altea/data/entity";
import { resolveType } from "@altea/altea/data/reflection";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { PropertyRouteEntity } from "@altea/altea/data/propertyRouteEntity";
import { PropertyRouteLogic } from "@altea/altea/server/propertyRouteLogic";
import { SqlPreCommandSimple } from "@altea/altea/server/sync/sqlPreCommand";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { Schema } from "@altea/altea/server/schema";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { SafeConsole } from "@altea/altea/server/safeConsole";
import chalk from "chalk";
import { DynamicValidationEntity, DynamicValidationOperation } from "../data/DynamicValidation";

// Port of Signum.Dynamic's Validations/DynamicValidationLogic.cs — the table, and the GLOBAL VALIDATION it
// hooks into.
//
// The only sibling that is a pure EVAL: a validation is asked about an entity in hand, so the script is
// compiled per row on first use and nothing is generated. That is Signum's arrangement too.
//
// It needed ONE core seam, which altea did not have: `globalValidators` (`data/reflection`), Signum's
// `Validator.GlobalValidation`. It is the one thing a per-field decorator cannot express — a rule chosen at
// RUNTIME for a type the rule's author does not own.
//
// altea divergences:
//  - **the applicability test is a PropertyRoute prefix**, not Signum's `PropertyRoute.MatchesEntity(mod)`,
//    which asks whether the modifiable being validated IS the one at the stored route. altea re-roots a
//    PropertyRoute at each embedded, so the validator is handed a route relative to its own owner rather
//    than to the root entity — hence "is the field's route inside the stored one".
//  - `DisabledMixin` is not ported, so the filter reads the entity's own `isDisabled` field.
//  - the cache is a plain array refreshed by the schema's `saved` event rather than a `GlobalLazy` with
//    `InvalidateWith`: altea's `globalLazy` is ASYNC and a validator cannot await, which is the same
//    reason @altea/altea-globals mirrors its lazy into a sync snapshot.
//  - Signum's `EntityEvents<TypeEntity>.PreDeleteSqlSync` (sweep the validations of a deleted TypeEntity) is
//    ported, and so is a sibling Signum does NOT have: the same sweep for a deleted PROPERTY ROUTE. Signum
//    registers one for Tour and Help but not here, so a synchronization that removes a route a validation
//    points at fails on `sub_entity_id`'s foreign key — a latent bug there, fixed rather than mirrored.

interface CachedValidation {
    validation: DynamicValidationEntity;
    /** The type the validation is declared for. */
    entityType: Function;
    /** The stored route, or undefined for "the whole entity". */
    route: string | undefined;
}

export namespace DynamicValidationLogic {

    /** The snapshot the validator reads — see the header on why this is not a lazy. */
    let cache: CachedValidation[] = [];
    let initialized = false;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // A route reference needs the routes table (idempotent — see the CLAUDE.md rule that a module
        // registers what a module owns).
        PropertyRouteLogic.start(sb);

        sb.include(DynamicValidationEntity)
            .withUniqueIndex(e => [e.name])
            .withSave(DynamicValidationOperation.Save)
            .withDelete(DynamicValidationOperation.Delete)
            .withQuery()
            .withOperations(op => {
                op.withConstructFrom(DynamicValidationEntity, DynamicValidationOperation.Clone, {
                    construct: e => {
                        const result = DynamicValidationEntity.create({
                            name: e.name + "_2",
                            entityType: e.entityType,
                            subEntity: e.subEntity,
                        });
                        result.eval = e.eval;
                        return result;
                    },
                });
            });

        // Signum's `EntityEvents<TypeEntity>().PreDeleteSqlSync`, plus the PropertyRouteEntity sibling it
        // lacks (see the header). Either way the validations that named the removed thing go with it.
        sb.schema.entityEvents(TypeEntity).preDeleteSqlSync.push(type =>
            deleteValidationsWhere(sb.schema, "entityType", type.id));

        sb.schema.entityEvents(PropertyRouteEntity).preDeleteSqlSync.push(property =>
            deleteValidationsWhere(sb.schema, "subEntity", property.id));

        // Signum's `sb.Schema.Initializing += () => { initialized = true; }` — until the schema is up, a
        // validation cannot be read, and reporting an error from a half-built process would be worse than
        // reporting none.
        sb.schema.initializing.push(async () => {
            await refresh();
            initialized = true;
        });

        // Signum's `InvalidateWith(typeof(DynamicValidationEntity))`.
        sb.schema.entityEvents(DynamicValidationEntity).saved.push(async () => { await refresh(); });

        globalValidators.push(dynamicValidation);
    }

    /**
     * Re-read the validations.
     *
     * Tolerates a table that is not there: this runs from `schema.initializing`, which is also what a
     * `create` / `sync` against a database WITHOUT this table runs — the same accommodation every
     * startup cache in altea makes.
     */
    export async function refresh(): Promise<void> {
        const t = Connector.current().schema.tryTable(DynamicValidationEntity);
        if (t == null || !await Administrator.existsTable(t)) {
            cache = [];
            return;
        }

        let rows: DynamicValidationEntity[];
        try {
            rows = await ExecutionMode.global(async () =>
                await table(DynamicValidationEntity).toArray() as DynamicValidationEntity[]);
        } catch (e) {
            // A TRAILING schema: the table is there but does not match the model yet — a column renamed,
            // added or removed. This runs from `schema.initializing`, which is precisely what a
            // `create` / `sync` runs against such a database — so throwing here kills the very command
            // that would fix it. Report, run with NO dynamic validations, and let the sync proceed.
            cache = [];
            SafeConsole.writeLineColor(chalk.yellow,
                "[dynamic] dynamic validations are not readable yet, running without them: "
                + (e instanceof Error ? e.message : String(e)));
            return;
        }

        cache = rows
            .filter(v => !v.isDisabled)
            .map(v => {
                const entityType = resolveType(v.entityType.className);
                return entityType == null ? undefined
                    : { validation: v, entityType, route: v.subEntity?.path ?? undefined } as CachedValidation;
            })
            .filter((c): c is CachedValidation => c != null);
    }

    /** The DELETE precommand for every validation whose `field` column holds `id`. */
    function deleteValidationsWhere(schema: Schema, field: string, id: PrimaryKey | null): SqlPreCommandSimple | undefined {
        const t = schema.tryTable(DynamicValidationEntity);
        const column = t?.fields[field]?.field.columns()[0];
        if (t == null || column == null || id == null)
            return undefined;
        const builder = Connector.current().sqlBuilder;
        return new SqlPreCommandSimple(
            `DELETE FROM ${builder.objectName(t.name)} WHERE ${builder.sqlEscape(column.name)} = ${id};`);
    }

    /**
     * Signum's `DynamicValidation(ModifiableEntity mod, PropertyInfo pi)` — the global validator itself.
     *
     * The first message wins, and a throw is re-thrown NAMED, as Signum does with
     * `e.Data["DynamicValidation"]`: a script that blows up should say which script.
     */
    export async function dynamicValidation(
        entity: Entity, fi: FieldInfo, _env: IntegrityCheckEnvironment,
    ): Promise<string | null> {

        if (!initialized || cache.length === 0)
            return null;

        for (const candidate of cache) {
            if (!(entity instanceof candidate.entityType))
                continue;

            if (!appliesTo(candidate, entity, fi))
                continue;

            const validation = candidate.validation;
            using _ = HeavyProfiler.logNoStackTrace("DynamicValidation", () => validation.name);
            try {
                const result = validation.eval.algorithm(entity, fi);
                if (result != null)
                    return result;
            } catch (e) {
                throw new Error(`DynamicValidation '${validation.name}': `
                    + (e instanceof Error ? e.message : String(e)));
            }
        }

        return null;
    }

    /**
     * Signum's `pair.PropertyRoute.MatchesEntity(mod)`, over a route STRING.
     *
     * No stored route means "the whole entity", so every field qualifies. A stored route qualifies the
     * field whose own route is AT or BELOW it — which is what Signum's route match means, and what lets a
     * validation be written for one property or for an embedded sub-tree.
     */
    function appliesTo(candidate: CachedValidation, entity: Entity, fi: FieldInfo): boolean {
        if (candidate.route == null)
            return true;

        try {
            const route = PropertyRoute.root(entity.constructor as never).add(fi.name).propertyString();
            return route === candidate.route || route.startsWith(candidate.route + ".");
        } catch {
            return false;
        }
    }
}
