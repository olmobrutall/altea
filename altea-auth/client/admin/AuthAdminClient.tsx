import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxGet, ajaxPost, ajaxGetRaw, saveFile } from "@altea/altea/client/Services";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { tryGetTypeMetadata } from "@altea/altea/client/Reflection";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/data/propertyRoute";
import { Entity } from "@altea/altea/data/entity";
import type { TypeContext, StyleContext } from "@altea/altea/client/TypeContext";
import { tasks, type LineBaseController, type LineBaseProps } from "@altea/altea/client/Lines/LineBase";
import type { Lite } from "@altea/altea/data/lite";
import { UserEntity } from "../../data/User";
import { RoleEntity } from "../../data/Role";
import { TypeRulePack, PermissionRulePack, OperationRulePack, QueryRulePack, PropertyRulePack, TypeAllowedBasic, PropertyAllowed } from "../../data/Rules";
import { AuthAdminMessage } from "../../data/AuthMessages";

// Port of Signum's AuthAdminClient (AuthAdminClient.tsx) — the ADMIN side of authorization: the User /
// Role management views + query settings, and the rule-pack API. Signum's `start` also registers the
// rule-pack VIEW controls (Type/Property/Operation/Query/Permission RulePackControl), the
// isViewable/isCreable/isReadonly navigator events + TypeContext member gates (driven by per-type
// `typeAllowed` in the reflection blob), and the auth-rules quick links / omnibox / download button.
//
// This first cut wires what the engine supports today (coarse): the User + Role admin views + query
// settings, plus the `API` surface (which targets the AuthAdminController — Phase 5). The rule-pack
// controls + client enforcement events are DEFERRED to Phase 5 (rule-pack models/controls +
// AuthAdminController); the `Options` flags mark where they slot in, mirroring Signum.

export namespace AuthAdminClient {
    export const Options: { types: boolean; properties: boolean; operations: boolean; queries: boolean; permissions: boolean } =
        { types: false, properties: false, operations: false, queries: false, permissions: false };

    export function start(cb: ClientBuilder, options?: Partial<typeof Options>): void {
        Options.types = options?.types ?? false;
        Options.properties = options?.properties ?? false;
        Options.operations = options?.operations ?? false;
        Options.queries = options?.queries ?? false;
        Options.permissions = options?.permissions ?? false;

        // Signum's Navigator.addSettings(new EntitySettings(UserEntity/RoleEntity, …)) + Finder.addSettings.
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

        cb.configure(RoleEntity)
            .withView(() => import("./Role"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.description),
                ],
                // Signum's AuthAdminClient RoleEntity extraButtons: a "Download AuthRules" button on the Role
                // search control (exports every dimension's rules to AuthRules.xml). Signum gates it on the
                // AdminRules client permission; altea has no client permission primitive yet (deferred), so it
                // shows for any admin — the endpoint is login-gated server-side.
                extraButtons: () => [{
                    order: -1,
                    button: <button type="button" className="btn btn-info" onClick={() => API.downloadAuthRules()}>
                        <FontAwesomeIcon aria-hidden={true} icon="download" /> {AuthAdminMessage.DownloadAuthRules.niceToString()}
                    </button>,
                }],
            }));

        // Rule packs (Signum's TypeRulePack / PermissionRulePack ModelEntities) open as a FrameModal via
        // Navigator.view — each needs an EntitySettings mapping the model to its view component, exactly
        // like Signum's Navigator.addSettings(new EntitySettings(TypeRulePack, …)), plus a QuickLink on the
        // Role frame (Signum's QuickLinkClient.registerQuickLink(RoleEntity, …)) as the entry point. The
        // pack is fetched first, then opened read-only-if-trivial-merge; the control saves in place.
        if (Options.types) {
            // Client type-auth enforcement (Signum's navigatorIsViewable/isCreable/isReadOnly): gate
            // viewability/creability/readonly on the role's per-type allowance. A `None` type is NOT
            // viewable → EntityLink renders it as plain text; a non-`Write` type isn't creable / is
            // read-only. Unrestricted types (not shipped → undefined) stay fully allowed.
            //
            // Read straight off the TypeMetadata the server stamped. Signum's `fixTypes` projection step is
            // gone with it: there is nothing to copy anywhere, so there is also nothing to RESET — a
            // re-login replaces the whole per-culture entry, and a role's allowances cannot outlive it.
            Navigator.isViewableEvent().push(typeName => {
                const tm = tryGetTypeMetadata(typeName);
                return tm == null || tm.maxTypeAllowed !== TypeAllowedBasic.None;
            });
            Navigator.isCreableEvent().push(typeName => {
                const tm = tryGetTypeMetadata(typeName);
                return tm == null || tm.maxTypeAllowed == null || tm.maxTypeAllowed === TypeAllowedBasic.Write;
            });
            Navigator.isReadonlyEvent().push(typeName => {
                const tm = tryGetTypeMetadata(typeName);
                return tm != null && tm.maxTypeAllowed != null && tm.maxTypeAllowed < TypeAllowedBasic.Write;
            });

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

        // Operation / Query / Property rules are PER-TYPE: like Signum, they are NOT reached from a Role
        // QuickLink but drilled into from the TypeRules grid — each TypeAllowedRule row in TypeRulePackControl
        // links straight to the (role, type) operation/query/property pack. Here we only register the model
        // views so `Navigator.view(pack)` can open them; the grid supplies the (typeName, roleId).
        if (Options.operations)
            cb.configure(OperationRulePack).withView(() => import("./OperationRulePackControl"));

        if (Options.queries)
            cb.configure(QueryRulePack).withView(() => import("./QueryRulePackControl"));

        if (Options.properties) {
            // Client property-auth enforcement (Signum's taskAuthorizeProperties + PropertyRoute's
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
        // User/Role Finder filters (profile photo, "only active", trivial-merge). See Signum's
        // AuthAdminClient.start.
    }

    // Signum's AuthAdminClient.API — the rule-pack endpoints (AuthAdminController). The rule-pack MODELS
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
}

// The role's allowance for one property route. Gates on `max` — the best case across every type-condition
// slice — because the client has no row to evaluate conditions against, and hiding a property the user may
// well be allowed to edit for THIS row would be the worse error: the server still enforces the exact
// per-instance answer on the way in (the request deserializer) and out (the serializer).
//
// An unrestricted route is not shipped at all, so an absent entry means Write.
function propertyAllowance(rootType: Function, path: string): PropertyAllowed {
    return tryGetTypeMetadata(rootType)?.fields[path]?.maxPropertyAllowed ?? PropertyAllowed.Write;
}

/**
 * The OWNER-ROOTED route a line edits, as (root entity type, propertyString) — the exact pair a property
 * rule is keyed by (RulePropertyEntity.rootType + path).
 *
 * The reconciliation this does is the whole point: the UI re-roots its PropertyRoute at every embedded /
 * model it renders (RenderEntity → `PropertyRoute.root(ti.ctor)`, faithfully ported from Signum), so a
 * line inside `Order.shipAddress` arrives as `(AddressEmbedded).city` — while the rules, the serializer
 * and `PropertyRoute.generateRoutes` all speak `(Order).shipAddress.city`. So climb the TypeContext chain,
 * prepending each ancestor's own path, until the root is a persisted Entity.
 *
 * Climbing STOPS at a persisted Entity on purpose: an EntityLine to another entity re-roots too, and there
 * the sub-entity's properties are governed by ITS OWN rules — prepending would invent
 * "Order.customer.firstName", which is not a rule anyone can write. A `@part` row is likewise its own root.
 */
function ownerRootedRoute(ctx: TypeContext<unknown>): { rootType: Function; path: string } | undefined {
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

function isPersistedEntity(ctor: Function): boolean {
    return ctor === Entity || ctor.prototype instanceof Entity;
}

// Signum's taskAuthorizeProperties: None → the line is not rendered at all; Read → it renders read-only.
function taskAuthorizeProperties(lineBase: LineBaseController<LineBaseProps, unknown>, state: LineBaseProps): void {
    const owner = ownerRootedRoute(state.ctx);
    if (owner == null)
        return;
    switch (propertyAllowance(owner.rootType, owner.path)) {
        case PropertyAllowed.None: state.visible = false; break;
        case PropertyAllowed.Read: state.ctx.readOnly = true; break;
    }
}

// NOTE: the min/maxTypeAllowed + *PropertyAllowed fields these gates read are declared once, by interface
// expansion of TypeMetadata / FieldMetadata, in ../../data/Rules — the DATA layer, so client and server
// share one declaration and the two halves cannot drift.
