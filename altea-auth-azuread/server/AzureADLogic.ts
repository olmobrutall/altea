import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/dynamicQuery/dQueryable"; // augments Query with .toDQueryable()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ManualDynamicQueryCore } from "@altea/altea/server/dynamicQuery/dynamicQueryCore";
import type { ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { DEnumerable } from "@altea/altea/server/dynamicQuery/dEnumerable";
import { ClassType } from "@altea/altea/server/runtimeTypes";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import {
    FilterCondition, FilterOperation, Pagination, type Filter, type QueryRequest,
} from "@altea/altea/server/dynamicQuery/requests";
import { Lite } from "@altea/altea/data/lite";

import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { UserEntity, UserOperation, UserState } from "@altea/altea-auth/data/User";
import { ActiveDirectoryPermission } from "@altea/altea-auth/data/BaseAD";
import type { ExternalUser } from "@altea/altea-auth/server/ADAuthorizer";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic.server";
import { Operations } from "@altea/altea/server/operationLogic";
import { AzureADConfigurationEmbedded, AzureADTask } from "../data/AzureAD";
import { ADGroupEntity, ADGroupOperation } from "../data/ADGroup";
import {
    ActiveDirectoryGroupModel, ActiveDirectoryUserModel, OnPremisesExtensionAttributesModel,
} from "../data/ActiveDirectoryQueries";
import { AzureADAuthorizer, MicrosoftGraphCreateUserContext } from "./AzureADAuthorizer";
import { AzureADAuthenticationServer } from "./AzureADAuthenticationServer";
import { MicrosoftGraph, type GraphCollection, type GraphGroup, type GraphUser } from "./MicrosoftGraph";
import { MicrosoftGraphQueryConverter } from "./MicrosoftGraphQueryConverter";

// Port of Signum.Authorization.AzureAD's AzureADLogic.cs — the module's start-up plus every Microsoft Graph
// operation it offers: the nightly deactivate-users sweep, the two directory-backed search queries, the
// group lookup the role mapping uses, the invite-a-user flow and the profile photo.
//
// altea divergences, documented inline:
//  - The Graph SDK is replaced by REST calls (see MicrosoftGraph's header).
//  - `QueryLogic.Queries.Register(AzureADQuery.X, () => DynamicQueryCore.Manual(…))` + `.ColumnDisplayName`
//    becomes `QueryLogic.queries.register(RowModel, () => new ManualDynamicQueryCore(RowModel, …))` with the
//    captions on the model's fields (altea has no QueryDescription — see ActiveDirectoryQueries.ts).
//  - `.ToDEnumerable(queryDescription).Select(request.Columns).WithCount(response.OdataCount)` becomes
//    `DEnumerable.fromEntity(...).where(...).orderBy(...).withCount(...).toResultTable(...)`. NOTE the
//    filters/orders are ALSO applied in memory here, which Signum does not do: Graph silently ignores what
//    it cannot express (a `$search` term is a fuzzy match, `$orderby` is refused on some fields), so
//    re-applying them locally makes the page agree with the filter the user typed. It costs nothing — the
//    rows are already in hand.
//  - `As.ReplaceExpression((UserEntity u) => u.EmailOwnerData, …)` is NOT ported: altea's email-owner data
//    comes from a registry the APPLICATION fills (`EmailLogic.registerEmailOwner`), so a module cannot — and
//    need not — redefine it; eastwind's registration already includes `externalId`.
//  - `Lite.RegisterLiteModelConstructor` is NOT ported (altea has no lite-model entity — see CLAUDE.md).
//  - `Schema.Current.OnMetadataInvalidated += () => ADGroupsCache.Clear()` has no altea counterpart; the
//    group cache is time-based only, and `clearADGroupsCache()` is exposed for a host that wants to drop it.
//  - `Administrator.SaveDisableIdentity(e)` is unnecessary: ADGroupEntity has a uuid PK, so the caller
//    assigns the directory's own object id and saves (see data/ADGroup.ts).

export namespace AzureADLogic {

    /** Signum's `CacheADGroupsFor` — 30 minutes. */
    export let cacheADGroupsForMs = 30 * 60 * 1000;

    interface CachedGroups { at: number; groups: SimpleGroup[] }
    const adGroupsCache = new Map<string, CachedGroups>();

    export function clearADGroupsCache(): void {
        adGroupsCache.clear();
    }

    /** The authorizer this module installed (also reachable as `AuthLogic.authorizer`). */
    export let authorizer: AzureADAuthorizer | undefined;

    export interface StartOptions {
        /** Signum's `getConfig` — per AD VARIANT ("default" or an application-specific name). */
        getConfig: (adVariant: string | null) => AzureADConfigurationEmbedded | null;
        /** Signum's `adGroupsAndQueries`: include ADGroupEntity and register the two directory queries. */
        adGroupsAndQueries?: boolean;
        /** Signum's `deactivateUsersTask`: register the AzureADTask.DeactivateUsers simple task. */
        deactivateUsersTask?: boolean;
    }

    export function start(sb: SchemaBuilder, options: StartOptions): void {
        if (sb.alreadyDefined(start))
            return;

        authorizer = new AzureADAuthorizer(options.getConfig);
        AuthLogic.authorizer = authorizer;

        // Signum's `PermissionLogic.RegisterTypes(typeof(ActiveDirectoryPermission))`: in altea a symbol is
        // seeded merely by being declared and imported, so referencing it here is what registers it.
        void ActiveDirectoryPermission.InviteUsersFromAD;

        if (options.deactivateUsersTask)
            registerDeactivateUsersTask();

        if (options.adGroupsAndQueries) {
            // Signum's `new Graph<ADGroupEntity>.Execute(ADGroupOperation.Save)` / `.Delete`, which are
            // both the plain defaults. No SaveDisableIdentity: the uuid PK is assigned by the caller
            // (see data/ADGroup.ts).
            sb.include(ADGroupEntity)
                .withSave(ADGroupOperation.Save)
                .withDelete(ADGroupOperation.Delete)
                .withQuery();
            registerDirectoryQueries();
        }

        if (sb.webBuilder)
            AzureADAuthenticationServer.start(sb.webBuilder, { adGroups: options.adGroupsAndQueries ?? false });
    }

    /** The configuration for one variant, or a clear error (every Graph call needs one). */
    export function requireConfig(adVariant: string | null = null): AzureADConfigurationEmbedded {
        const config = authorizer?.getConfigFor(adVariant) ?? null;
        if (config == null)
            throw new Error(`No AzureADConfiguration for variant '${adVariant ?? "default"}'`);
        return config;
    }

    // ---- The nightly sweep ------------------------------------------------------------------------------

    /**
     * Signum's `SimpleTaskLogic.Register(AzureADTask.DeactivateUsers, …)` — ask Graph, in batches of 10,
     * whether each externally-linked user is still enabled, and AUTO-deactivate / reactivate accordingly.
     * `AutoDeactivate` (not `Deactivate`) so an administrator can still tell the two apart.
     */
    function registerDeactivateUsersTask(): void {
        SimpleTaskLogic.register(AzureADTask.DeactivateUsers, async ctx => {
            const config = requireConfig();
            const users = await table(UserEntity).filter(u => u.externalId != null).toArray() as UserEntity[];

            const chunks: UserEntity[][] = [];
            for (let i = 0; i < users.length; i += 10)
                chunks.push(users.slice(i, i + 10));

            await ctx.forEach(chunks, gr => `${gr.length} user(s)...`, async gr => {
                const filter = gr.map(a => `id eq '${a.externalId}'`).join(" OR ");
                const response = await MicrosoftGraph.get<GraphCollection<GraphUser>>(config, "users", {
                    select: ["id", "accountEnabled"],
                    filter,
                    count: true,
                });

                const enabled = new Map((response.value ?? []).map(u => [u.id!, u.accountEnabled === true]));

                for (const u of gr) {
                    const isEnabled = enabled.get(u.externalId!);

                    if (u.state === UserState.Active && isEnabled !== true) {
                        ctx.writeLine(`User ${u.id} (${u.userName}) with OID ${u.externalId} has been deactivated in Azure AD`);
                        await Operations.execute(u, UserOperation.AutoDeactivate);
                    }

                    if (u.state === UserState.AutoDeactivate && isEnabled === true) {
                        ctx.writeLine(`User ${u.id} (${u.userName}) with OID ${u.externalId} has been reactivated in Azure AD`);
                        await Operations.execute(u, UserOperation.Reactivate);
                    }
                }
            });

            return null;
        });
    }

    // ---- The two directory-backed queries ---------------------------------------------------------------

    function registerDirectoryQueries(): void {

        // Signum's `AzureADQuery.ActiveDirectoryUsers`.
        QueryLogic.queries.register(ActiveDirectoryUserModel, () =>
            new ManualDynamicQueryCore(ActiveDirectoryUserModel, async request => {
                const config = requireConfig();
                const converter = new MicrosoftGraphQueryConverter();

                // An `inGroup` EqualTo filter switches the call to that group's transitive members and is
                // consumed here, so it is never sent to Graph as a field filter.
                const { extracted: inGroup, rest } = extractFilter(request, "inGroup");
                const groupLite = inGroup?.value as Lite<ADGroupEntity> | undefined;

                const path = groupLite != null
                    ? `groups/${String(groupLite.id)}/transitiveMembers/microsoft.graph.user`
                    : "users";

                const response = await MicrosoftGraph.get<GraphCollection<GraphUser>>(config, path, {
                    filter: converter.getFilters(rest),
                    search: converter.getSearch(rest),
                    select: converter.getSelect(request.columns),
                    orderby: converter.getOrderBy(request.orders),
                    top: converter.getTop(request.pagination),
                    count: true,
                });

                const rows = (response.value ?? []).map(u => toUserModel(u));
                return finish(ActiveDirectoryUserModel, rows, request, rest, response["@odata.count"]);
            }));

        // Signum's `AzureADQuery.ActiveDirectoryGroups`.
        QueryLogic.queries.register(ActiveDirectoryGroupModel, () =>
            new ManualDynamicQueryCore(ActiveDirectoryGroupModel, async request => {
                const config = requireConfig();
                const converter = new MicrosoftGraphQueryConverter();

                // A `hasUser` EqualTo filter asks for that user's transitive group membership instead.
                const { extracted: hasUser, rest } = extractFilter(request, "hasUser");
                const userLite = hasUser?.value as Lite<UserEntity> | undefined;

                let path = "groups";
                if (userLite != null) {
                    // A plain const, not `userLite.id` inline: the quote-transformer captures a captured
                    // CONST into the query, and a property read off a captured object is not one.
                    const userId = userLite.id;
                    const externalId = (await table(UserEntity)
                        .filter(u => u.id == userId)
                        .map(u => u.externalId)
                        .firstOrNull()) as string | null;

                    if (externalId == null)
                        throw new Error(`User ${userLite.toString()} has no ExternalId`);

                    path = `users/${externalId}/transitiveMemberOf/microsoft.graph.group`;
                }

                const response = await MicrosoftGraph.get<GraphCollection<GraphGroup>>(config, path, {
                    filter: converter.getFilters(rest),
                    search: converter.getSearch(rest),
                    select: converter.getSelect(request.columns),
                    orderby: converter.getOrderBy(request.orders),
                    top: converter.getTop(request.pagination),
                    count: true,
                });

                const rows = (response.value ?? []).map(g => ActiveDirectoryGroupModel.create({
                    entity: null,
                            objectId: g.id ?? null,
                    displayName: g.displayName ?? null,
                    description: g.description ?? null,
                    securityEnabled: g.securityEnabled ?? null,
                    visibility: g.visibility ?? null,
                    hasUser: null,
                }));

                return finish(ActiveDirectoryGroupModel, rows, request, rest, response["@odata.count"]);
            }));
    }

    /**
     * Signum's `response.Value.Skip(skip).Select(request.Columns).WithCount(response.OdataCount)`.
     *
     * The local SKIP is not an optimisation to drop: Graph pages directory objects with an opaque cursor,
     * so there is no `$skip` — the converter asks for `elementsPerPage * currentPage` rows and the page the
     * caller wanted is the TAIL of that.
     */
    function finish(model: Function, rows: unknown[], request: QueryRequest, filters: Filter[], odataCount: number | undefined): ResultTable {
        const skip = request.pagination instanceof Pagination.Paginate ? request.pagination.skip() : 0;

        // Re-apply what Graph may have loosened (see the header note); harmless when it honoured them.
        const all = DEnumerable.fromEntity(new ClassType(model), rows)
            .where(filters)
            .orderBy(request.orders);

        const page = skip === 0 ? all : new DEnumerable(all.collection.slice(skip), all.context);

        return page
            .withCount(odataCount ?? all.collection.length)
            .toResultTable(request.columns, request.pagination);
    }

    /** Pull ONE `EqualTo` condition on `key` out of the request's filters (Signum's `Filters.Extract`). */
    function extractFilter(request: QueryRequest, key: string): { extracted: FilterCondition | undefined; rest: Filter[] } {
        let extracted: FilterCondition | undefined;
        const rest = request.filters.filter(f => {
            if (extracted == undefined && f instanceof FilterCondition
                && f.token.fullKey() === key && f.operation === FilterOperation.EqualTo) {
                extracted = f;
                return false;
            }
            return true;
        });
        return { extracted, rest };
    }

    function toUserModel(u: GraphUser): ActiveDirectoryUserModel {
        const ea = u.onPremisesExtensionAttributes;
        return ActiveDirectoryUserModel.create({
            entity: null,
            objectId: u.id ?? null,
            displayName: u.displayName ?? null,
            userPrincipalName: u.userPrincipalName ?? null,
            mail: u.mail ?? null,
            givenName: u.givenName ?? null,
            surname: u.surname ?? null,
            jobTitle: u.jobTitle ?? null,
            department: u.department ?? null,
            officeLocation: u.officeLocation ?? null,
            employeeType: u.employeeType ?? null,
            onPremisesExtensionAttributes: ea == null ? null : OnPremisesExtensionAttributesModel.create({
                extensionAttribute1: ea["extensionAttribute1"] ?? null,
                extensionAttribute2: ea["extensionAttribute2"] ?? null,
                extensionAttribute3: ea["extensionAttribute3"] ?? null,
                extensionAttribute4: ea["extensionAttribute4"] ?? null,
                extensionAttribute5: ea["extensionAttribute5"] ?? null,
                extensionAttribute6: ea["extensionAttribute6"] ?? null,
                extensionAttribute7: ea["extensionAttribute7"] ?? null,
                extensionAttribute8: ea["extensionAttribute8"] ?? null,
                extensionAttribute9: ea["extensionAttribute9"] ?? null,
                extensionAttribute10: ea["extensionAttribute10"] ?? null,
                extensionAttribute11: ea["extensionAttribute11"] ?? null,
                extensionAttribute12: ea["extensionAttribute12"] ?? null,
                extensionAttribute13: ea["extensionAttribute13"] ?? null,
                extensionAttribute14: ea["extensionAttribute14"] ?? null,
                extensionAttribute15: ea["extensionAttribute15"] ?? null,
            }),
            onPremisesImmutableId: u.onPremisesImmutableId ?? null,
            companyName: u.companyName ?? null,
            creationType: u.creationType ?? null,
            accountEnabled: u.accountEnabled ?? null,
            inGroup: null,
        });
    }

    // ---- Directory search / import ---------------------------------------------------------------------

    /** Signum's FindActiveDirectoryUsers — the autocomplete behind "invite a user from the directory". */
    export async function findActiveDirectoryUsers(subStr: string, top: number, _signal?: AbortSignal): Promise<ExternalUser[]> {
        const config = requireConfig();
        const s = subStr.replace(/'/g, "''");

        const query =
            s.includes("@") ? `mail eq '${s}'` :
                s.includes(",") ? `startswith(givenName, '${after(s, ",").trim()}') AND startswith(surname, '${before(s, ",").trim()}') OR startswith(displayname, '${s.trim()}')` :
                    s.includes(" ") ? `startswith(givenName, '${before(s, " ").trim()}') AND startswith(surname, '${after(s, " ").trim()}') OR startswith(displayname, '${s.trim()}')` :
                        `startswith(givenName, '${s}') OR startswith(surname, '${s}') OR startswith(displayname, '${s.trim()}') OR startswith(mail, '${s.trim()}')`;

        const response = await MicrosoftGraph.get<GraphCollection<GraphUser>>(config, "users", { top, filter: query });

        return (response.value ?? []).map(a => ({
            upn: a.userPrincipalName ?? "",
            displayName: a.displayName ?? "",
            jobTitle: a.jobTitle ?? "",
            externalId: a.id ?? null,
        }));
    }

    /** Signum's GetActiveDirectoryUser. */
    export async function getActiveDirectoryUser(oid: string): Promise<ExternalUser> {
        const config = requireConfig();
        const u = await MicrosoftGraph.get<GraphUser>(config, `users/${oid}`);
        if (u == null)
            throw new Error(`User with OID '${oid}' not found in Active Directory`);

        return {
            upn: u.userPrincipalName ?? "",
            displayName: u.displayName ?? "",
            jobTitle: u.jobTitle ?? "",
            externalId: u.id ?? null,
        };
    }

    /** Signum's CreateUserFromAD — import a directory hit as a local user (or refresh the existing row). */
    export async function createUserFromAD(adUser: ExternalUser): Promise<UserEntity> {
        const config = requireConfig();
        const ada = authorizer!;

        const graphUser = await MicrosoftGraph.get<GraphUser>(config, `users/${adUser.externalId}`);
        const ctx = new MicrosoftGraphCreateUserContext(graphUser, config);

        return await ExecutionMode.global(() => Transaction.create(async () => {
            const existing = await ada.tryFindUser(ctx.externalId, ctx.userName, config.allowMatchUsersBySimpleUserName);

            if (existing != null) {
                await ada.updateUser(existing, ctx);
                return existing;
            }

            return await ada.onCreateUser(ctx);
        }));
    }

    // ---- Groups ----------------------------------------------------------------------------------------

    /** Signum's SimpleGroup record. */
    export interface SimpleGroup { id: string; displayName: string | null }

    /**
     * Signum's `CurrentADGroupsInternal(Guid oid)` — the identity's transitive group membership read with
     * the APPLICATION's credentials, cached for `cacheADGroupsForMs` (Signum's ADGroupsCache).
     */
    export async function currentADGroups(config: AzureADConfigurationEmbedded, oid: string): Promise<SimpleGroup[]> {
        const cached = adGroupsCache.get(oid);
        if (cached != null && Date.now() - cached.at < cacheADGroupsForMs)
            return cached.groups;

        const response = await MicrosoftGraph.get<GraphCollection<GraphGroup>>(
            config, `users/${oid}/transitiveMemberOf/microsoft.graph.group`,
            { top: 999, select: ["id", "displayName"] });

        const groups = (response.value ?? []).map(g => ({ id: g.id!, displayName: g.displayName ?? null }));
        adGroupsCache.set(oid, { at: Date.now(), groups });
        return groups;
    }

    /** Signum's `CurrentADGroupsInternal(string accessToken)` — delegated permissions, `/me`. NOT cached
     *  (the token is per request, and Signum does not cache this path either). */
    export async function currentADGroupsDelegated(config: AzureADConfigurationEmbedded, accessToken: string): Promise<SimpleGroup[]> {
        const response = await MicrosoftGraph.withAccessToken(accessToken, () =>
            MicrosoftGraph.get<GraphCollection<GraphGroup>>(config, "me/transitiveMemberOf/microsoft.graph.group",
                { top: 999, select: ["id", "displayName"] }));

        return (response.value ?? []).map(g => ({ id: g.id!, displayName: g.displayName ?? null }));
    }

    // ---- Photos ----------------------------------------------------------------------------------------

    /** Signum's GetUserPhoto — the square photo bytes at a Graph-supported size, or null. */
    export async function getUserPhoto(oid: string, size: number): Promise<Buffer | null> {
        const config = requireConfig();
        return await MicrosoftGraph.getBytes(config, `users/${oid}/photos/${size}x${size}/$value`);
    }
}

function before(value: string, separator: string): string {
    return value.substring(0, value.indexOf(separator));
}
function after(value: string, separator: string): string {
    return value.substring(value.indexOf(separator) + separator.length);
}

