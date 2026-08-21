import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import * as AppContext from "@altea/altea/client/AppContext";
import { Lite } from "@altea/altea/data/lite";
import { SearchMessage } from "@altea/altea/data/uiMessages";
import type { ResultRow } from "@altea/altea/data/dynamicQuery/queryRequest";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { UserEntity } from "@altea/altea-auth/data/User";
import { ActiveDirectoryMessage } from "@altea/altea-auth/data/BaseAD";
import { ActiveDirectoryClient } from "@altea/altea-auth/client/admin/ActiveDirectoryClient";
import * as ProfilePhoto from "@altea/altea-auth/client/public/ProfilePhoto";
import { AzureADConfigurationEmbedded } from "../data/AzureAD";
import { ADGroupEntity, type ADGroupRequest } from "../data/ADGroup";
import { CachedProfilePhotoEntity } from "../data/CachedProfilePhoto";
import { ActiveDirectoryGroupModel, ActiveDirectoryUserModel } from "../data/ActiveDirectoryQueries";

// Port of Signum.Authorization.AzureAD's AzureADClient.tsx — the ADMIN-side registrations: the
// configuration editor, the AD-group view, the two directory search pages' default filters, and the
// profile-photo provider.
//
// altea divergences, documented inline:
//  - `Navigator.addSettings(new EntitySettings(T, view))` / `Finder.addSettings({ queryName, … })` →
//    `cb.configure(T).withView(…).withQuerySettings(…)` (see ClientBuilder). The two directory queries are
//    named by their ROW MODEL, not by an enum member (see data/ActiveDirectoryQueries.ts).
//  - the photo provider can only answer for a FULL UserEntity: it needs the user's Entra object id, and
//    altea's Lite carries no lite MODEL to hold it (see ProfilePhoto's header). A Lite therefore falls back
//    to the initials circle.
//  - `ChangeLogClient.registerChangeLogModule` has no altea counterpart.

export namespace AzureADClient {

    export interface StartOptions {
        /** Register the AD-group view and the two directory search pages. */
        adGroups?: boolean;
        /** Serve user avatars from Azure: `true` straight from Graph, `"cached"` from the local copy. */
        profilePhotos?: boolean | "cached";
    }

    export function start(cb: ClientBuilder, options: StartOptions = {}): void {

        cb.configure(AzureADConfigurationEmbedded).withView(() => import("./AzureADConfiguration"));

        // The cached-photo table's query settings — Signum's server-side
        // `WithQuery(() => e => new { e.Id, e.CreationDate, e.InvalidationDate, e.Size, e.User, e.Photo })`.
        // Registered UNCONDITIONALLY, not under `profilePhotos`: the table is part of the schema either way
        // (the host starts CachedProfilePhotoLogic), and `cb.configure` is also what registers the entity's
        // client TypeInfo — without it /find/CachedProfilePhotoEntity fails with "No TypeInfo".
        cb.configure(CachedProfilePhotoEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(p => p.id),
                    token(p => p.user),
                    token(p => p.size),
                    token(p => p.photo),
                    token(p => p.invalidationDate),
                    token(p => p.creationDate),
                ],
            }));

        if (options.profilePhotos) {
            ProfilePhoto.urlProviders.push((u, size) => {
                // See the header: only a loaded UserEntity carries the external id.
                if (u instanceof Lite)
                    return null;

                const oid = u.externalId;
                if (oid == null)
                    return null;

                return options.profilePhotos === "cached"
                    ? API.cachedAzureUserPhotoUrl(size, oid)
                    : AppContext.toAbsoluteUrl(`/api/azureUserPhoto/${size}/${oid}`);
            });
        }

        if (options.adGroups) {
            cb.configure(ADGroupEntity)
                .withView(() => import("./ADGroup"))
                .withQuerySettings(token => ({
                    defaultColumns: [
                        token(a => a.id),
                        token(a => a.displayName),
                    ],
                }));

            // Signum's `new EntitySettings(ADGroupEntity, …, { isCreable: "Never" })`. Not decoration: an AD
            // group's PRIMARY KEY is its Entra object id (see data/ADGroup.ts), so a hand-created row would
            // stand for no real group. altea's fluent `configure` covers view + query settings only, so this
            // reaches for the settings directly.
            Navigator.getOrAddSettings(ADGroupEntity).isCreable = "Never";

            Finder.addSettings({
                queryName: ActiveDirectoryUserModel,
                defaultFilters: [
                    {
                        groupOperation: "Or",
                        pinned: { label: SearchMessage.Search.niceToString(), splitValue: true, active: "WhenHasValue" },
                        filters: [
                            { token: "displayName", operation: "Contains" },
                            { token: "givenName", operation: "Contains" },
                            { token: "surname", operation: "Contains" },
                            { token: "mail", operation: "Contains" },
                        ],
                    },
                    {
                        pinned: { label: () => ActiveDirectoryMessage.OnlyActiveUsers.niceToString(), active: "Checkbox_Checked", column: 1, row: 0 },
                        token: "accountEnabled", operation: "EqualTo", value: true,
                    },
                    { token: "creationType", operation: "DistinctTo", value: "Invitation" },
                ],
                // Signum relies on its server-declared query columns and merely HIDES two of them; altea
                // derives the default set from the row model (id + the first fields), so the visible set is
                // stated here — otherwise `objectId` would show as an "Id" column, which is precisely what
                // Signum's hiddenColumns exists to prevent.
                defaultColumns: [
                    "displayName",
                    "userPrincipalName",
                    "mail",
                    "jobTitle",
                    "department",
                    "accountEnabled",
                ],
                hiddenColumns: [
                    { token: "objectId" },
                    { token: "onPremisesImmutableId" },
                ],
                defaultOrders: [
                    { token: "displayName", orderType: "Ascending" },
                ],
            } as Finder.QuerySettings);

            Finder.addSettings({
                queryName: ActiveDirectoryGroupModel,
                defaultFilters: [
                    {
                        groupOperation: "Or",
                        pinned: { label: SearchMessage.Search.niceToString(), splitValue: true, active: "WhenHasValue" },
                        filters: [
                            { token: "displayName", operation: "Contains" },
                        ],
                    },
                ],
                defaultColumns: [
                    "displayName",
                    "description",
                    "securityEnabled",
                    "visibility",
                ],
                hiddenColumns: [
                    { token: "objectId" },
                ],
                defaultOrders: [
                    { token: "displayName", orderType: "Ascending" },
                ],
            } as Finder.QuerySettings);
        }
    }

    /** Signum's findActiveDirectoryGroup — pick a directory group and import it as an ADGroupEntity. */
    export function findActiveDirectoryGroup(): Promise<Lite<ADGroupEntity> | undefined> {
        return Finder.findRow({
            queryName: ActiveDirectoryGroupModel,
            filterOptions: [
                { token: "hasUser", value: null, pinned: { column: 1, row: 0, active: "WhenHasValue" } },
            ],
        }, { searchControlProps: { allowChangeOrder: false } })
            .then(a => a && API.createADGroup(toADGroupRequest(a.row, a.searchControl)));
    }

    /** Signum's findManyActiveDirectoryGroup. */
    export function findManyActiveDirectoryGroup(): Promise<Lite<ADGroupEntity>[] | undefined> {
        return Finder.findManyRows({
            queryName: ActiveDirectoryGroupModel,
            filterOptions: [
                { token: "hasUser", value: null, pinned: { column: 1, row: 0, active: "WhenHasValue" } },
            ],
        }, { searchControlProps: { allowChangeOrder: false } })
            .then(a => a && Promise.all(a.rows.map(r => API.createADGroup(toADGroupRequest(r, a.searchControl)))));
    }

    /** Read the `id` / `displayName` cells out of a picked result row. */
    export function toADGroupRequest(row: ResultRow, scl: SearchControlLoaded): ADGroupRequest {
        const columns = scl.state.resultTable!.columns;
        return {
            id: row.columns[columns.indexOf("objectId")] as string,
            displayName: row.columns[columns.indexOf("displayName")] as string,
        };
    }

    /** Read an ExternalUser out of a picked result row (the invite-a-user flow). */
    export function toExternalUser(row: ResultRow, scl: SearchControlLoaded): ActiveDirectoryClient.ExternalUser {
        const columns = scl.state.resultTable!.columns;
        return {
            displayName: row.columns[columns.indexOf("displayName")] as string,
            jobTitle: row.columns[columns.indexOf("jobTitle")] as string,
            externalId: row.columns[columns.indexOf("objectId")] as string,
            upn: row.columns[columns.indexOf("userPrincipalName")] as string,
        };
    }

    export namespace API {

        export function createADGroup(request: ADGroupRequest): Promise<Lite<ADGroupEntity>> {
            return ajaxPost({ url: "/api/createADGroup" }, request);
        }

        /** Signum's `forceCacheInvalidationKey` — bust the browser cache after a photo refresh. */
        export const Options = { forceCacheInvalidationKey: undefined as string | undefined };

        export function cachedAzureUserPhotoUrl(size: number, oid: string): Promise<string | null> {
            const inv = Options.forceCacheInvalidationKey ? `?inv=${encodeURIComponent(Options.forceCacheInvalidationKey)}` : "";
            return ajaxGet({ url: `/api/cachedAzureUserPhoto/${size}/${oid}${inv}`, cache: "default" });
        }
    }
}
