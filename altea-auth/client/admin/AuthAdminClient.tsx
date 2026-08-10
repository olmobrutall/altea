import { ajaxGet, ajaxPost, ajaxGetRaw, saveFile } from "@altea/altea/client/Services";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import type { Lite } from "@altea/altea/data/lite";
import { UserEntity } from "../../data/User";
import { RoleEntity } from "../../data/Role";
import { TypeRulePack, PermissionRulePack } from "../../data/Rules";
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
                defaultColumns: [token(a => a.id), token(a => a.userName), token(a => a.email), token(a => a.role), token(a => a.state)],
            }));

        cb.configure(RoleEntity)
            .withView(() => import("./Role"))
            .withQuerySettings(token => ({
                defaultColumns: [token(a => a.id), token(a => a.name), token(a => a.description)],
            }));

        // Rule packs (Signum's TypeRulePack / PermissionRulePack ModelEntities) open as a FrameModal via
        // Navigator.view — each needs an EntitySettings mapping the model to its view component, exactly
        // like Signum's Navigator.addSettings(new EntitySettings(TypeRulePack, …)), plus a QuickLink on the
        // Role frame (Signum's QuickLinkClient.registerQuickLink(RoleEntity, …)) as the entry point. The
        // pack is fetched first, then opened read-only-if-trivial-merge; the control saves in place.
        if (Options.types) {
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

        // DEFERRED (Phase 5): the OTHER rule-pack views (Property/Operation/Query RulePackControl) per the
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
        export function fetchPropertyRulePack(typeName: string, roleId: number | string): Promise<unknown> {
            return ajaxGet({ url: "/api/authAdmin/propertyRules/" + typeName + "/" + roleId, cache: "no-cache" });
        }
        export function savePropertyRulePack(rules: unknown): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/propertyRules" }, rules);
        }
        export function fetchOperationRulePack(typeName: string, roleId: number | string): Promise<unknown> {
            return ajaxGet({ url: "/api/authAdmin/operationRules/" + typeName + "/" + roleId, cache: "no-cache" });
        }
        export function saveOperationRulePack(rules: unknown): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/operationRules" }, rules);
        }
        export function fetchQueryRulePack(typeName: string, roleId: number | string): Promise<unknown> {
            return ajaxGet({ url: "/api/authAdmin/queryRules/" + typeName + "/" + roleId, cache: "no-cache" });
        }
        export function saveQueryRulePack(rules: unknown): Promise<void> {
            return ajaxPost({ url: "/api/authAdmin/queryRules" }, rules);
        }
        export function downloadAuthRules(): void {
            void ajaxGetRaw({ url: "/api/authAdmin/downloadAuthRules" }).then(response => saveFile(response));
        }
        export function trivialMergeRole(roles: Lite<RoleEntity>[]): Promise<Lite<RoleEntity>> {
            return ajaxPost({ url: "/api/authAdmin/trivialMergeRole" }, roles);
        }
    }
}
