import * as React from "react";
import { Modal } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { AuthClient } from "../AuthClient";
import type { Lite } from "@altea/altea/data/lite";
import type { FindOptionsParsed } from "@altea/altea/client/FindOptions";
import { UserEntity } from "../../data/User";
import { UserADMessage } from "../../data/BaseAD";

// Port of Signum's `ActiveDirectoryClient` (Signum.Authorization/BaseAD/ActiveDirectoryClient.tsx) — the
// "invite a user from the directory" UI, shared by altea-auth-azuread and altea-auth-windowsad: an
// autocomplete entry on any UserEntity picker, and a button on the UserEntity search page.
//
// altea divergences, documented inline:
//  - the client-side permission gate is a BOOLEAN read from /api/activeDirectory/canInviteUsers whenever
//    the CURRENT USER changes (altea's metadata blob carries no permissions — see ActiveDirectoryServer for
//    the full rationale). Signum reads it straight out of the blob, which is itself re-fetched per login, so
//    following `onCurrentUserChanged` is what reproduces its per-role freshness.
//  - Signum opens `AutoLineModal` to ask for the search text; altea has no AutoLineModal, so this module
//    carries the one-input modal it needs (`SearchTextModal` below) — same two fields (label +
//    initial value), same result (the typed string, or undefined on cancel).
//  - `Finder.API.AutocompleteRequest` carried a `types` field; the route always searches users, so the
//    API here takes `subString` / `count` directly.

export namespace ActiveDirectoryClient {

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

    /**
     * Signum's `ActiveDirectoryClient.start({routes, inviteUsers})`. Called from the ADMIN bundle: it
     * touches Navigator / Finder settings, so it must not load for an anonymous visitor.
     */
    export function start(options: { inviteUsers: boolean }): void {
        if (!options.inviteUsers)
            return;

        // Re-resolve the gate whenever the CURRENT USER changes, never once at start-up. The permission is
        // per-ROLE, so a single answer would be wrong twice over: `start()` runs before autoLogin resolves
        // anyone (the route would 403 as anonymous and the invite UI would never appear, even for an
        // authorized user), and a later user / role switch would keep the previous role's answer.
        // Anonymous is answered locally — asking would only 403.
        AuthClient.onCurrentUserChanged.push(() => { void refreshCanInviteUsers(); });
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

        Finder.ButtonBarQuery.onButtonBarElements.push(ctx => {
            if (ctx.findOptions.queryKey != UserEntity.typeName || !canInviteUsers)
                return undefined;

            const search = getSearch(ctx.findOptions);

            return {
                order: -1,
                button: <button className="btn btn-info ms-2"
                    onClick={() => {
                        void SearchTextModal.show({
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

    /** Signum's `getSearch(fo)` — the value of the pinned split-value filter, i.e. what is in the search box. */
    function getSearch(fo: FindOptionsParsed): string | null {
        const value = fo.filterOptions.firstOrNull(a => a.pinned?.splitValue == true)?.value;
        return !value ? null : value as string;
    }

    /** Signum's `importADUser` — search, let the user pick, and create the local row. */
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

// ---- SearchTextModal ------------------------------------------------------------------------------------
//
// Signum asks for the search text with `AutoLineModal.show({ type: { name: "string" }, … })`. altea has no
// AutoLineModal, and pulling one in for a single free-text prompt would be a much bigger surface than the
// prompt itself — so the module carries it: one labelled input, Enter or OK resolves the typed string,
// Escape or Cancel resolves undefined.

interface SearchTextModalProps extends IModalProps<string | undefined> {
    title: React.ReactNode;
    label: string;
    initialValue: string;
}

function SearchTextModalComponent(p: SearchTextModalProps): React.ReactElement {
    const [show, setShow] = React.useState(true);
    const [value, setValue] = React.useState(p.initialValue);
    const answer = React.useRef<string | undefined>(undefined);

    function handleOk(): void {
        answer.current = value;
        setShow(false);
    }

    return (
        <Modal show={show} onExited={() => p.onExited!(answer.current)} onHide={() => setShow(false)} size="lg">
            <div className="modal-header">
                <h5 className="modal-title">{p.title}</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                <form onSubmit={e => { e.preventDefault(); handleOk(); }}>
                    <label className="form-label" htmlFor="adSearchText">{p.label}</label>
                    <input id="adSearchText" type="text" className="form-control" autoFocus
                        value={value} onChange={e => setValue(e.currentTarget.value)} />
                </form>
            </div>
            <div className="modal-footer">
                <button className="btn btn-primary sf-entity-button" onClick={handleOk} disabled={!value}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
                <button className="btn btn-light sf-entity-button" onClick={() => setShow(false)}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

export namespace SearchTextModal {
    export function show(options: { title: React.ReactNode; label: string; initialValue: string }): Promise<string | undefined> {
        return openModal<string | undefined>(<SearchTextModalComponent
            title={options.title} label={options.label} initialValue={options.initialValue} />);
    }
}
