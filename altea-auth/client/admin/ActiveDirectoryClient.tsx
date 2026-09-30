import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import AutoLineModal from "@altea/altea/client/AutoLineModal";
import { TypeReference } from "@altea/altea/data/reflection";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { AuthClient } from "../AuthClient";
import type { Lite } from "@altea/altea/data/lite";
import type { FindOptionsParsed } from "@altea/altea/client/FindOptions";
import { UserEntity } from "../../data/User";
import { UserADMessage } from "../../data/BaseAD";

// Port of Signum.Authorization's BaseAD/ActiveDirectoryClient.tsx — see port/AuthDirectory.md.
//
// The "invite a user from the directory" UI, shared by altea-auth-azuread and altea-auth-windowsad: an
// autocomplete entry on any UserEntity picker, and a button on the UserEntity search page.
//
// The client-side permission gate is a BOOLEAN read from /api/activeDirectory/canInviteUsers whenever the
// CURRENT USER changes: the metadata blob carries no permissions (see ActiveDirectoryServer for why), so
// following `onCurrentUserChanged` is what keeps it fresh per role.
//
// The autocomplete API takes `subString` / `count` directly — the route always searches users, so there
// is no `types` field to pass.

export namespace ActiveDirectoryClient {

    // A stable identity, so the once-only registration below can recognise it (an inline arrow could not).
    const onUserChanged = (): void => { void refreshCanInviteUsers(); };

    /** Whether the current user may import from the directory; resolved by `start()`. */
    let canInviteUsers = false;

    export function isInviteUsersAuthorized(): boolean {
        return canInviteUsers;
    }

    async function refreshCanInviteUsers(): Promise<void> {
        if (AuthClient.currentUser() == null) {
            canInviteUsers = false;
            return;
        }
        canInviteUsers = await API.canInviteUsers().catch(() => false);
    }

    /** Called from the ADMIN bundle: it touches Navigator / Finder settings, so it must not load for an
     *  anonymous visitor. */
    export function start(options: { inviteUsers: boolean }): void {
        if (!options.inviteUsers)
            return;

        // Re-resolve the gate whenever the CURRENT USER changes, never once at start-up. The permission is
        // per-ROLE, so a single answer would be wrong twice over: `start()` runs before autoLogin resolves
        // anyone (the route would 403 as anonymous and the invite UI would never appear, even for an
        // authorized user), and a later user / role switch would keep the previous role's answer.
        // Anonymous is answered locally — asking would only 403.
        // `onCurrentUserChanged` is a SUBSCRIPTION list, not a settings registry — it is module-global on
        // purpose (AuthClient's own metadata reloader lives on it, registered at import time) and so it is
        // NOT reset with the rest of the client state. This start() may run again on a credential change,
        // so the subscription is added at most once; otherwise every switch-user would add another copy and
        // fire N redundant canInviteUsers probes.
        if (!AuthClient.onCurrentUserChanged.includes(onUserChanged))
            AuthClient.onCurrentUserChanged.push(onUserChanged);
        void refreshCanInviteUsers();

        Navigator.getSettings(UserEntity)!.autocompleteConstructor = (str, _aac) =>
            canInviteUsers && str.length > 2 ? ({
                type: UserEntity,
                customElement: <em>
                    <FontAwesomeIcon icon="address-book" title={UserADMessage.Find0InActiveDirectory.niceToString(str)} />
                    &nbsp;{UserADMessage.Find0InActiveDirectory.niceToString(str)}
                </em>,
                onClick: () => importADUser(str),
            }) : null;

        Finder.ButtonBarQuery.onButtonBarElements().push(ctx => {
            if (ctx.findOptions.queryKey != UserEntity.typeName || !canInviteUsers)
                return undefined;

            const search = getSearch(ctx.findOptions);

            return {
                order: -1,
                button: <button className="btn btn-info ms-2"
                    onClick={() => {
                        void AutoLineModal.show<string>({
                            type: new TypeReference({ typeName: "String" }),
                            modalSize: "md",
                            title: <><FontAwesomeIcon aria-hidden={true} icon="address-book" /> {UserADMessage.FindInActiveDirectory.niceToString()}</>,
                            label: UserADMessage.NameOrEmail.niceToString(),
                            initialValue: search ?? "",
                        })
                            .then(str => !str ? undefined : importADUser(str))
                            .then(u => u && Navigator.view(u))
                            .then(u => u && ctx.searchControl.handleCreated(u));
                    }}>
                    <FontAwesomeIcon icon="user-plus" />{" "}
                    {search == null ? UserADMessage.FindInActiveDirectory.niceToString()
                        : UserADMessage.Find0InActiveDirectory.niceToString(search)}
                </button>,
            };
        });
    }

    /** The value of the pinned split-value filter, i.e. what is in the search box. */
    function getSearch(fo: FindOptionsParsed): string | null {
        const value = fo.filterOptions.firstOrNull(a => a.pinned?.splitValue == true)?.value;
        return !value ? null : value as string;
    }

    /** Search, let the user pick, and create the local row. */
    export function importADUser(text: string): Promise<Lite<UserEntity> | undefined> {
        return API.findADUsers(text, 10)
            .then(externalUsers => {
                if (externalUsers.length == 0)
                    return MessageModal.showError(UserADMessage.NoUserContaining0FoundInActiveDirectory.niceToString(text));

                return SelectorModal.chooseElement(externalUsers, {
                    forceShow: true,
                    size: "md",
                    title: UserADMessage.SelectActiveDirectoryUser.niceToString(),
                    message: UserADMessage.PleaseSelectTheUserFromActiveDirectoryThatYouWantToImport.niceToString(),
                    buttonDisplay: u => <div style={{ display: "flex", flexDirection: "column" }}>
                        <strong>{u.displayName}</strong>
                        <pre className="mb-0">{u.upn}</pre>
                        {u.jobTitle && <span className="text-muted">{u.jobTitle}</span>}
                    </div>,
                })
                    .then(eu => eu ? API.createADUser(eu) : undefined);
            });
    }

    export namespace API {
        export function canInviteUsers(): Promise<boolean> {
            return ajaxGet({ url: "/api/activeDirectory/canInviteUsers" });
        }

        export function findADUsers(subString: string, count: number, signal?: AbortSignal): Promise<ExternalUser[]> {
            return ajaxGet({
                url: `/api/findADUsers?subString=${encodeURIComponent(subString)}&count=${count}`,
                signal,
            });
        }

        export function createADUser(model: ExternalUser): Promise<Lite<UserEntity>> {
            return ajaxPost({ url: "/api/createADUser" }, model);
        }
    }

    /** The wire shape of altea-auth's server-side `ExternalUser`. */
    export interface ExternalUser {
        displayName: string;
        jobTitle: string;
        upn: string;
        externalId: string | null;
    }
}
