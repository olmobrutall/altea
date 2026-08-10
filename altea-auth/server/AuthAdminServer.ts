import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { PermissionAuthLogic } from "./PermissionAuthLogic";
import { TypeRulePack, PermissionRulePack } from "../data/Rules";
import { RoleEntity } from "../data/Role";

// Port of Signum's AuthAdminController (Rules/*Controller) — the rule-pack admin endpoints the
// AuthAdminClient calls. The packs are reflected entity graphs (ModelEntity subclasses), so the route
// declares them by their CONSTRUCTOR (req/res: TypeRulePack) — the WebBuilder resolves a bare class to
// an entity payload and (de)serializes it via the entity Serializer, exactly like Signum. No CustomType
// is needed for a BaseEntity type; CustomType stays only for the plain `{ roleId }` params shape.
// Secure-by-default (no allowAnonymous) — a logged-in user is required; a tighter BasicPermission.AdminRules
// check can be added once permission enforcement is wired.
//
// This first cut covers the TYPE and PERMISSION rule packs. Query/Operation/Property packs follow the
// same shape as their engines land.
export namespace AuthAdminServer {
    export function start(ws: WebBuilder): void {
        // GET the type rule pack for a role (every type + the role's allowed/allowedBase).
        ws.get("/api/authAdmin/typeRules/:roleId",
            { params: CustomType<{ roleId: string }>(), res: TypeRulePack },
            async (req, res) => {
                res.jsonTyped(await TypeAuthLogic.getTypeRulePack(RoleEntity.parseId(req.params.roleId)));
            });

        // POST the edited type rule pack → persist (upsert/delete RuleType rows) + invalidate the cache.
        ws.post("/api/authAdmin/typeRules",
            { req: TypeRulePack },
            async (req, res) => {
                await TypeAuthLogic.setTypeRulePack(await req.jsonTyped());
                res.status(204).end();
            });

        // GET the permission rule pack for a role (every permission + the role's allowed/allowedBase).
        ws.get("/api/authAdmin/permissionRules/:roleId",
            { params: CustomType<{ roleId: string }>(), res: PermissionRulePack },
            async (req, res) => {
                res.jsonTyped(await PermissionAuthLogic.getPermissionRulePack(RoleEntity.parseId(req.params.roleId)));
            });

        // POST the edited permission rule pack → persist (upsert/delete RulePermission rows) + invalidate.
        ws.post("/api/authAdmin/permissionRules",
            { req: PermissionRulePack },
            async (req, res) => {
                await PermissionAuthLogic.setPermissionRulePack(await req.jsonTyped());
                res.status(204).end();
            });
    }
}
