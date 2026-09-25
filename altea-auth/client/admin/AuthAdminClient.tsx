import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxGet, ajaxPost, ajaxGetRaw, saveFile } from "@altea/altea/client/Services";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { tryGetTypeMetadata, tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { Metadata } from "@altea/altea/data/metadata";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/data/propertyRoute";
import { Entity } from "@altea/altea/data/entity";
import type { TypeContext, StyleContext } from "@altea/altea/client/TypeContext";
import { tasks, type LineBaseController, type LineBaseProps } from "@altea/altea/client/Lines/LineBase";
import type { Lite } from "@altea/altea/data/lite";
import { UserEntity } from "../../data/User";
import { UserTicketEntity } from "../../data/UserTicket";
import { SessionLogEntity } from "../../data/SessionLog";
import { RoleEntity } from "../../data/Role";
import { TypeRulePack, PermissionRulePack, OperationRulePack, QueryRulePack, PropertyRulePack, TypeAllowedBasic, PropertyAllowed } from "../../data/Rules";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { BasicPermission } from "@altea/altea/data/permissionSymbol";
import { AuthClient } from "../AuthClient";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import { Finder } from "@altea/altea/client/Finder";
import * as AppContext from "@altea/altea/client/AppContext";
import { getQueryKey, type PseudoType } from "@altea/altea/client/Reflection";
import type { QueryTokenString } from "@altea/altea/client/QueryTokenString";
import { QueryToken, SubTokensOptionsAll } from "@altea/altea/client/QueryToken";
import { isFilterCondition } from "@altea/altea/client/FindOptions";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { CollectionMessage } from "@altea/altea/data/dynamicQueries";
import { SearchMessage } from "@altea/altea/data/uiMessages";
import { TypeConditionSymbol } from "../../data/Rules";
import type { Type, BaseEntity } from "@altea/altea/data/entity";

// Port of Signum.Authorization's AuthAdminClient.tsx — see port/Auth.md.
//
// The ADMIN side of authorization: the User / Role management views + query settings, and the rule-pack
// API. Signum's `start` also registers the
// rule-pack VIEW controls (Type/Property/Operation/Query/Permission RulePackControl), the
// isViewable/isCreable/isReadonly navigator events + TypeContext member gates (driven by per-type
// `typeAllowed` in the reflection blob), and the auth-rules quick links / omnibox / download button.
//
// This first cut wires what the engine supports today (coarse): the User + Role admin views + query
// settings, plus the `API` surface (which targets the AuthAdminController — Phase 5). The rule-pack
// controls + client enforcement events are DEFERRED to Phase 5 (rule-pack models/controls +
// AuthAdminController); the `Options` flags mark where they slot in.

export namespace AuthAdminClient {
    export const Options: { types: boolean; properties: boolean; operations: boolean; queries: boolean; permissions: boolean } =
        { types: false, properties: false, operations: false, queries: false, permissions: false };

    export function start(cb: ClientBuilder, options?: Partial<typeof Options>): void {
        Options.types = options?.types ?? false;
        Options.properties = options?.properties ?? false;
        Options.operations = options?.operations ?? false;
        Options.queries = options?.queries ?? false;
        Options.permissions = options?.permissions ?? false;

        cb.configure(UserEntity)
            .withView(() => import("./User"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.userName),
                    token(a => a.email),
                    token(a => a.role),
                    token(a => a.state),
                ],
            }));

        // The five columns UserTicketLogic's own query shows. The
        // server registration takes none (no QueryDescription), so they are CLIENT default columns. No
        // view — a ticket is engine-written, and the search page IS the "my remembered devices" list.
        cb.configure(UserTicketEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.user),
                    token(a => a.ticket),
                    token(a => a.connectionDate),
                    token(a => a.device),
                ],
            }));

        // SessionLogEntity's default columns, a CLIENT setting here (the
        // server registration takes none — no QueryDescription). No view: a session row is engine-written,
        // and the search page IS the report. `sessionEnd` / `sessionTimeOut` are only ever filled here
        // because the logout call Signum leaves out IS wired — see server/SessionLogLogic.
        cb.configure(SessionLogEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.user),
                    token(a => a.sessionStart),
                    token(a => a.sessionEnd),
                    token(a => a.sessionTimeOut),
                ],
            }));

        cb.configure(RoleEntity)
            .withView(() => import("./Role"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.description),
                ],
                // A "Download AuthRules" button on the Role
                // search control (exports every dimension's rules to AuthRules.xml), gated on the AdminRules
                // permission, exactly as the "!DownloadAuthRules" omnibox twin below does. The endpoint
                // is authorized server-side either way.
                extraButtons: () => !AuthClient.isPermissionAuthorized(BasicPermission.AdminRules) ? [] : [{
                    order: -1,
                    button: <button type="button" className="btn btn-info" onClick={() => API.downloadAuthRules()}>
                        <FontAwesomeIcon aria-hidden={true} icon="download" /> {AuthAdminMessage.DownloadAuthRules.niceToString()}
                    </button>,
                }],
            }));

        // "!DownloadAuthRules", the same export the Role search's
        // button above runs. It resolves to `undefined` because the action handles itself (it downloads a
        // file) rather than navigating anywhere.
        //
        // This is the registration that moved `OmniboxSpecialAction` back into core, where Signum keeps
        // it: the registry had lived in @altea/altea-omnibox, which depends on THIS package, so registering
        // from here would have closed a package cycle.
        registerSpecialAction({
            key: "DownloadAuthRules",
            allowed: () => AuthClient.isPermissionAuthorized(BasicPermission.AdminRules),
            onClick: () => { API.downloadAuthRules(); return Promise.resolve(undefined); },
        });

        // The rule packs are ModelEntities, so they open as a FrameModal through
        // Navigator.view — each needs an EntitySettings mapping the model to its view component, exactly
        // Navigator.view, plus a QuickLink on the Role frame as the entry point. The
        // pack is fetched first, then opened read-only-if-trivial-merge; the control saves in place.
        if (Options.types) {
            // Client type-auth enforcement: gate viewability/creability/readonly on the role's per-type
            // allowance. A type the role cannot read is NOT viewable → EntityLink renders it as plain
            // text; a non-`Write` type isn't creable / is read-only.
            //
            // ABSENCE IS THE DENIAL. The server drops a type the role cannot read from the blob entirely
            // (Signum's TypeExtension returning null) and keeps an entry — an empty `{ kind }` if it has
            // nothing else to say — for every type it CAN read. So a missing entry means forbidden, not
            // unrestricted, and a present entry with no `maxTypeAllowed` means Write.
            //
            // Two absences are NOT denials, and both have to be told apart from it by what the client
            // already knows, because the blob by definition says nothing about either:
            //
            //  - before the first blob has been applied, nothing has an entry. Boot fetches it before
            //    anything renders, but a gate answering "deny" from an empty store would be answering
            //    about the fetch, not about the role;
            //  - a type the SERVER does not have — a ModelEntity declared in client code, which never
            //    reaches `getRegisteredTypes()` over there. Only a persisted entity has a table, and only
            //    a type with a table can be the one the filter removed.
            const typeAllowance = (typeName: string): TypeAllowedBasic => {
                const tm = tryGetTypeMetadata(typeName);
                if (tm != null)
                    return tm.maxTypeAllowed ?? TypeAllowedBasic.Write;
                const ctor = tryGetTypeInfo(typeName)?.ctor;
                return Metadata.isApplied() && ctor != null && isPersistedEntity(ctor)
                    ? TypeAllowedBasic.None
                    : TypeAllowedBasic.Write;
            };

            Navigator.isViewableEvent().push(typeName => typeAllowance(typeName) !== TypeAllowedBasic.None);
            Navigator.isCreableEvent().push(typeName => typeAllowance(typeName) === TypeAllowedBasic.Write);
            Navigator.isReadonlyEvent().push(typeName => typeAllowance(typeName) < TypeAllowedBasic.Write);

            // "No results found" is a lie when a QUERY-AUDITOR type condition is what emptied the table:
            // the rows are there, the role simply may not SEE them until it says which ones it wants.
            // See queryAuditorNoResultMessage.
            Finder.onNoResultMessage().push(queryAuditorNoResultMessage);

            cb.configure(TypeRulePack).withView(() => import("./TypeRulePackControl"));
            QuickLinkClient.registerQuickLink(RoleEntity, new QuickLinkAction("types",
                () => AuthAdminMessage.TypeRules.niceToString(),
                ctx => void API.fetchTypeRulePack(ctx.lite.id!).then(pack =>
                    Navigator.view(pack, { buttons: "close", title: AuthAdminMessage.TypeRules.niceToString() + " — " + ctx.lite.toString() })),
                { icon: "shield-halved", iconColor: "red", color: "danger", group: null }));
        }

        if (Options.permissions) {
            cb.configure(PermissionRulePack).withView(() => import("./PermissionRulePackControl"));
            QuickLinkClient.registerQuickLink(RoleEntity, new QuickLinkAction("permissions",
                () => AuthAdminMessage.PermissionRules.niceToString(),
                ctx => void API.fetchPermissionRulePack(ctx.lite.id!).then(pack =>
                    Navigator.view(pack, { buttons: "close", title: AuthAdminMessage.PermissionRules.niceToString() + " — " + ctx.lite.toString() })),
                { icon: "shield-halved", iconColor: "orange", color: "warning", group: null }));
        }

        // Operation / Query / Property rules are PER-TYPE, and are NOT reached from a Role
        // QuickLink but drilled into from the TypeRules grid — each TypeAllowedRule row in TypeRulePackControl
        // links straight to the (role, type) operation/query/property pack. Here we only register the model
        // views so `Navigator.view(pack)` can open them; the grid supplies the (typeName, roleId).
        if (Options.operations)
            cb.configure(OperationRulePack).withView(() => import("./OperationRulePackControl"));

        if (Options.queries)
            cb.configure(QueryRulePack).withView(() => import("./QueryRulePackControl"));

        if (Options.properties) {
            // Client property-auth enforcement (the line task + PropertyRoute's
            // IsAllowed callback). Until now the property dimension existed ONLY on the server, in the
            // serializer: a `None` property still rendered (blank) and a `Read` one still looked editable
            // until the save silently discarded the edit.
            //
            // Two seams, one policy (propertyAllowance below):
            //   - a LineBase task: every Line runs it, so it covers plain fields, EntityTable cells and
            //     anything else built on a Line;
            //   - PropertyRoute.isAllowedCallback: for the places that decide BEFORE rendering a line —
            //     EntityTable drops a whole unreadable column rather than leaving a titled, empty one.
            tasks().push(taskAuthorizeProperties);
            PropertyRoute.isAllowedCallback = route =>
                route.propertyRouteType == PropertyRouteType.FieldOrProperty
                    && propertyAllowance(route.rootType, route.propertyString()) === PropertyAllowed.None
                    ? AuthAdminMessage.Property0IsNotAllowed.niceToString(route.toString())
                    : null;

            cb.configure(PropertyRulePack).withView(() => import("./PropertyRulePackControl"));
        }

        // DEFERRED: richer navigator gates (isViewable/isReadonly from per-type typeAllowed in the blob) per the
        // Options flags; the navigatorIsViewable/isCreable/isReadonly events + TypeContext member gates
        // (need per-type `typeAllowed` in the blob); the download-auth-rules button and the richer
        // User / Role Finder filters (profile photo, "only active", trivial-merge). See
        // AuthAdminClient.start.
    }

    // The rule-pack endpoints (AuthAdminController). The rule-pack MODELS
    // (TypeRulePack / PermissionRulePack / …) land in Phase 5; typed as `unknown` here until then.
    export namespace API {
        export function fetchPermissionRulePack(roleId: number | string): Promise<PermissionRulePack> {
            return ajaxGet({ url: "/api/authAdmin/permissionRules/" + roleId, cache: "no-cache" });
        }
        export function savePermissionRulePack(pack: PermissionRulePack): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/permissionRules" }, pack);
        }
        export function fetchTypeRulePack(roleId: number | string): Promise<TypeRulePack> {
            return ajaxGet({ url: "/api/authAdmin/typeRules/" + roleId, cache: "no-cache" });
        }
        export function saveTypeRulePack(pack: TypeRulePack): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/typeRules" }, pack);
        }
        export function fetchPropertyRulePack(typeName: string, roleId: number | string): Promise<PropertyRulePack> {
            return ajaxGet({ url: "/api/authAdmin/propertyRules/" + typeName + "/" + roleId, cache: "no-cache" });
        }
        export function savePropertyRulePack(pack: PropertyRulePack): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/propertyRules" }, pack);
        }
        export function fetchOperationRulePack(typeName: string, roleId: number | string): Promise<OperationRulePack> {
            return ajaxGet({ url: "/api/authAdmin/operationRules/" + typeName + "/" + roleId, cache: "no-cache" });
        }
        export function saveOperationRulePack(pack: OperationRulePack): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/operationRules" }, pack);
        }
        export function fetchQueryRulePack(typeName: string, roleId: number | string): Promise<QueryRulePack> {
            return ajaxGet({ url: "/api/authAdmin/queryRules/" + typeName + "/" + roleId, cache: "no-cache" });
        }
        export function saveQueryRulePack(pack: QueryRulePack): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/queryRules" }, pack);
        }
        // The owned-part closure for a type: [ownerCleanName, ...partCleanNames]. Drives the per-type
        // drill-in that shows one rule table per type (owner + parts) in the same modal.
        export function fetchPartClosure(typeName: string): Promise<string[]> {
            return ajaxGet({ url: "/api/authAdmin/partClosure/" + typeName, cache: "no-cache" });
        }
        export function downloadAuthRules(): void {
            void ajaxGetRaw({ url: "/api/authAdmin/downloadAuthRules" }).then(response => saveFile(response));
        }
        export function trivialMergeRole(roles: Lite<RoleEntity>[]): Promise<Lite<RoleEntity>> {
            return ajaxPost({ url: "/api/authAdmin/trivialMergeRole" }, roles);
        }
    }

    /**
     * Tell the user WHICH filter a query-auditor type condition is waiting for.
     *
     * A condition registered with `TypeConditionLogic.registerWhenAlreadyFilteringBy` grants rows to a
     * caller that pinned a property to a value it may read — so the module that registered it also knows
     * the TOKEN a user has to filter by. Register that pair here (Signum's
     * `AuthAdminClient.registerQueryAuditorToken`) and an empty result names the token instead of the
     * bare rule. @altea/altea-diff-log registers `OperationLog.Target`.
     *
     * The registry lives in `AppContext.clientState`, so the re-registration every credential change
     * triggers replaces it rather than appending to it.
     */
    export function registerQueryAuditorToken(
        queryName: PseudoType,
        token: string | QueryTokenString<any>,
        typeCondition: TypeConditionSymbol,
    ): void {
        queryAuditorTokens().push({ queryKey: getQueryKey(queryName), token: token.toString(), typeCondition });
    }

    export function queryAuditorTokens(): QueryAuditorToken[] {
        return AppContext.clientState.authQueryAuditorTokens ??= [];
    }
}

export interface QueryAuditorToken {
    queryKey: string;
    token: string;
    typeCondition: TypeConditionSymbol;
}

declare module "@altea/altea/client/AppContext" {
    interface IClientState {
        authQueryAuditorTokens?: QueryAuditorToken[];
    }
}

/**
 * Why an ALLOWED search legitimately came back empty.
 *
 * A type whose type-auth FALLBACK is `None` is reachable only through its condition rules, and a
 * QUERY-AUDITOR condition among them decides from the CALLER'S OWN QUERY rather than from the row: "you
 * may read these rows because you already pinned them to something you are allowed to read". An
 * unfiltered search over such a type therefore matches nothing — not because nothing is there, but
 * because nothing was asked for. The server ships the auditing conditions' keys per type
 * (`TypeMetadata.queryAuditors`, stamped by AuthReflection).
 *
 * Two messages, as in Signum: the generic one when no module has said which token the rule wants, and the
 * specific one naming the very tokens to filter by. In both cases a filter that ALREADY pins something
 * (an `EqualTo`) means the search really did match nothing, so nothing is said.
 *
 * altea divergences:
 *  - a GLOBAL Finder handler (Finder.onNoResultMessage) rather than a per-type `QuerySettings`
 *    assignment. Signum can snapshot `getAllTypes()` at start; altea loads the reflection blob AFTER the
 *    client modules register, so the answer has to be read at render time — which also keeps it correct
 *    after a login / impersonation change;
 *  - Signum's `similarToken` (which strips a leading `Entity.`) is plain string equality here, because
 *    altea's tokens are rootless already;
 *  - the token is rendered by resolving it against the query's own token tree (sync, client-side —
 *    altea has no QueryDescription), falling back to the raw key.
 */
function queryAuditorNoResultMessage(sc: SearchControlLoaded): React.ReactElement | undefined {
    const fo = sc.state.resultFindOptions;
    if (fo == null)
        return undefined;

    const tis = sc.entityColumnTypeInfos();
    const auditors = [...new Set(tis.flatMap(ti => (ti.ctor != null ? tryGetTypeMetadata(ti.ctor)?.queryAuditors : undefined) ?? []))];
    if (auditors.length == 0)
        return undefined;

    const tokens = AuthAdminClient.queryAuditorTokens()
        .filter(a => a.queryKey == fo.queryKey && auditors.includes(a.typeCondition.key));

    const type = tis.map((ti, i) => <strong key={i}>{ti.getNicePluralName()}</strong>).joinCommaHtml(CollectionMessage.Or.niceToString());

    if (tokens.length == 0) {
        if (fo.filterOptions.some(f => isFilterCondition(f) && f.operation == "EqualTo"))
            return undefined;
        const symbols = auditors.map((a, i) => <strong key={i}>{a}</strong>).joinCommaHtml(CollectionMessage.And.niceToString());
        return warning(SearchMessage.NoResultsFoundBecauseTheRule0DoesNotAllowedToExplore1WithoutFilteringFirst
            .niceToString().formatHtml(symbols, type));
    }

    if (fo.filterOptions.some(f => isFilterCondition(f) && f.operation == "EqualTo"
        && tokens.some(t => f.token?.fullKey() == t.token)))
        return undefined;

    const tokenCode = tokens.map((a, i) => <strong key={i}>{niceTokenName(sc.props.queryToken, a.token)}</strong>)
        .joinCommaHtml(CollectionMessage.Or.niceToString());
    return warning(SearchMessage.NoResultsFoundBecauseYouAreNotAllowedToExplore0WithoutFilteringBy1First
        .niceToString().formatHtml(type, tokenCode));
}

function warning(content: React.ReactElement): React.ReactElement {
    return <span className="text-warning"><FontAwesomeIcon aria-hidden={true} icon="hand" /> {content}</span>;
}

// A token key as a reader would recognise it, resolved hop by hop against the query's own token tree
// (`QueryToken.subTokens` is synchronous for one level, which is all a registered auditor token needs in
// practice). An unresolvable key falls back to itself, so an out-of-date registration still says something.
function niceTokenName(root: QueryToken, fullKey: string): string {
    let current: QueryToken = root;
    for (const step of fullKey.split(".")) {
        const next = current.subTokens(SubTokensOptionsAll).firstOrNull(t => t.key.toLowerCase() == step.toLowerCase());
        if (next == null)
            return fullKey;
        current = next;
    }
    return current.niceName();
}

// The role's allowance for one property route. The best case across every type-condition slice, because
// the client has no row to evaluate conditions against, and hiding a property the user may well be allowed
// to edit for THIS row would be the worse error: the server still enforces the exact per-instance answer
// on the way in (the request deserializer) and out (the serializer).
//
// A route is shipped only where it is STRICTER THAN ITS TYPE, so an absent entry falls back to the type's
// own allowance — which is Write when the type is unrestricted, and None when the type is not in the blob
// at all (the role cannot read it, so neither can it read any property of it).
function propertyAllowance(rootType: Type<BaseEntity>, path: string): PropertyAllowed {
    const tm = tryGetTypeMetadata(rootType);
    if (tm == null)
        // Absent: denied if it could have been removed, unrestricted otherwise — the same three-way read
        // as `typeAllowance` above, and for the same reasons.
        return Metadata.isApplied() && isPersistedEntity(rootType) ? PropertyAllowed.None : PropertyAllowed.Write;
    // `routes`, not `fields`: the pair asked with here is (root entity, whole path), which is what
    // `ownerRootedRoute` climbed the TypeContext chain to rebuild. A label would be asked for with
    // (declaring type, member) instead, and never needs the climb.
    // TypeAllowedBasic and PropertyAllowed are the same three ascending levels (None 0, Read 1, Write 2).
    const typeAllowed: number = tm.maxTypeAllowed ?? TypeAllowedBasic.Write;
    return tm.routes?.[path]?.propertyAllowed ?? typeAllowed as PropertyAllowed;
}

/**
 * The OWNER-ROOTED route a line edits, as (root entity type, propertyString) — the exact pair a property
 * rule is keyed by (RulePropertyEntity.rootType + path).
 *
 * The reconciliation this does is the whole point: the UI re-roots its PropertyRoute at every embedded /
 * model it renders (RenderEntity → `PropertyRoute.root(ti.ctor)`), so a
 * line inside `Order.shipAddress` arrives as `(AddressEmbedded).city` — while the rules, the serializer
 * and `PropertyRoute.generateRoutes` all speak `(Order).shipAddress.city`. So climb the TypeContext chain,
 * prepending each ancestor's own path, until the root is a persisted Entity.
 *
 * Climbing STOPS at a persisted Entity on purpose: an EntityLine to another entity re-roots too, and there
 * the sub-entity's properties are governed by ITS OWN rules — prepending would invent
 * "Order.customer.firstName", which is not a rule anyone can write. A `@part` row is likewise its own root.
 */
function ownerRootedRoute(ctx: TypeContext<unknown>): { rootType: Type<BaseEntity>; path: string } | undefined {
    const route = ctx.propertyRoute;
    if (route == null || route.propertyRouteType != PropertyRouteType.FieldOrProperty)
        return undefined;

    let rootType = route.rootType;
    let path = route.propertyString();
    // `parent` is typed StyleContext — only a TypeContext carries a propertyRoute — so narrow as we climb.
    for (let p: StyleContext | undefined = ctx.parent; p != null && !isPersistedEntity(rootType); p = p.parent) {
        const pr = (p as TypeContext<unknown>).propertyRoute as PropertyRoute | undefined;
        if (pr == null || pr.rootType === rootType || pr.propertyRouteType != PropertyRouteType.FieldOrProperty)
            continue;
        path = pr.propertyString() + "." + path;
        rootType = pr.rootType;
    }
    return { rootType, path };
}

function isPersistedEntity(ctor: Type<BaseEntity>): ctor is Type<Entity> {
    return ctor === Entity || ctor.prototype instanceof Entity;
}

// None → the line is not rendered at all; Read → it renders read-only.
function taskAuthorizeProperties(lineBase: LineBaseController<LineBaseProps, unknown>, state: LineBaseProps): void {
    const owner = ownerRootedRoute(state.ctx);
    if (owner == null)
        return;
    switch (propertyAllowance(owner.rootType, owner.path)) {
        case PropertyAllowed.None: state.visible = false; break;
        case PropertyAllowed.Read: state.ctx.readOnly = true; break;
    }
}

// NOTE: the maxTypeAllowed + propertyAllowed fields these gates read are declared once, by interface
// expansion of TypeMetadata / FieldMetadata, in ../../data/Rules — the DATA layer, so client and server
// share one declaration and the two halves cannot drift.
