import "@altea/altea/server/context.node"; // register server context storage first
import { Connector } from "@altea/altea/server/connection/connector";
import type { Schema, SchemaBuilder } from "@altea/altea/server/schema";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { OperationAuthLogic } from "@altea/altea-auth/server/OperationAuthLogic";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { PropertyAuthLogic } from "@altea/altea-auth/server/PropertyAuthLogic";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { FilterQueryArgs } from "@altea/altea/server/schema/filterQueryArgs";
import { TypeAllowedBasic, OperationAllowed, PropertyAllowed } from "@altea/altea-auth/data/Rules";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { SampleEntity, SampleLogEntity, SampleOperation, SampleTypeCondition, SampleLogTypeCondition } from "../data/sample";

// Builds the connector + registers the sample domain and the FULL authorization stack — in the same order
// as eastwind's Starter, so the tests exercise the engines exactly as the app wires them. No web builder
// (server-only: no HTTP surface, no auth middleware — tests set the current role directly via UserHolder).
export namespace AuthTestStarter {
    export async function connectorFromEnv(schema: Schema, connStr: string): Promise<Connector> {
        if (connStr.startsWith("postgres")) {
            const { PostgresConnector } = await import("@altea/altea/server/connection/postgresConnector");
            const connector = new PostgresConnector(schema, connStr);
            // Before the schema is built: it decides a generated GUID key's default generator
            // (guidKeyDefault) — an explicit async step, since there is no synchronous DB access.
            await connector.detectServerCapabilities();
            return connector;
        }
        const { SqlServerConnector } = await import("@altea/altea/server/connection/sqlServerConnector");
        return new SqlServerConnector(schema, connStr);
    }

    export function registerLogic(sb: SchemaBuilder): void {
        // Authentication + the five authorization dimensions (eastwind's order). AuthLogic first so the
        // Role/User tables + their operation symbols exist; TypeAuthLogic also starts TypeConditionLogic.
        AuthLogic.start(sb);
        TypeAuthLogic.start(sb);
        PermissionAuthLogic.start(sb);
        OperationAuthLogic.start(sb);
        QueryAuthLogic.start(sb);
        PropertyAuthLogic.start(sb);

        // The sample domain: a queryable entity + two operations + two row-level type conditions. Must run
        // BEFORE OperationLogic.start (so the operation symbols are registered before the symbol table is
        // seeded) and before sb.complete()/initialize (so the queryFilter hooks see the conditions).
        sb.include(SampleEntity)
            .withSave(SampleOperation.Save)
            .withDelete(SampleOperation.Delete)
            .withQuery();
        // Delete must never just follow the type: a role gets it only from an explicit rule.
        OperationAuthLogic.setMaxAutomaticUpgrade(SampleOperation.Delete, OperationAllowed.None);
        // …and `value` must never just follow the type either.
        PropertyAuthLogic.setMaxAutomaticUpgrade(PropertyRoute.parse(SampleEntity, "value"), PropertyAllowed.None);
        TypeConditionLogic.registerCompile(SampleEntity, SampleTypeCondition.Confidential, s => s.confidential === true);
        TypeConditionLogic.registerCompile(SampleEntity, SampleTypeCondition.Public, s => s.confidential === false);
        // DB-ONLY (no in-memory predicate) → forces the fillTypeConditions SQL path for inTypeCondition.
        TypeConditionLogic.register(SampleEntity, SampleTypeCondition.HighValue, s => s.value > 0);

        // The QUERY-AUDITOR condition — the exact registration Signum.DiffLog makes for
        // OperationLogEntity, here on the sample log: a log row is readable BECAUSE
        // the caller pinned its `target` to something they may read.
        sb.include(SampleLogEntity).withQuery();
        TypeConditionLogic.registerWhenAlreadyFilteringBy(
            SampleLogEntity, SampleLogTypeCondition.FilteringByTarget, {
            property: l => l.target,
            isConstantAuthorized: async target => target != null
                && await TypeAuthLogic.isAllowedForLite(target, TypeAllowedBasic.Read, true, FilterQueryArgs.fromLite(target)),
            useInDBForInMemoryCondition: false,
        });

        OperationLogic.start(sb);
    }
}
