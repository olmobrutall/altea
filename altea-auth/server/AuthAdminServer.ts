import { WebBuilder, CustomType, attachmentDisposition } from "@altea/altea/server/webApi";
import { AuthImportExport } from "./AuthImportExport";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { PermissionAuthLogic } from "./PermissionAuthLogic";
import { OperationAuthLogic } from "./OperationAuthLogic";
import { QueryAuthLogic } from "./QueryAuthLogic";
import { PropertyAuthLogic } from "./PropertyAuthLogic";
import { TypeRulePack, PermissionRulePack, OperationRulePack, QueryRulePack, PropertyRulePack } from "../data/Rules";
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

        // GET the operation rule pack for a (type, role) — PER-TYPE, like Signum. Every operation of the
        // type + the role's allowed/allowedBase.
        ws.get("/api/authAdmin/operationRules/:typeName/:roleId",
            { params: CustomType<{ typeName: string; roleId: string }>(), res: OperationRulePack },
            async (req, res) => {
                res.jsonTyped(await OperationAuthLogic.getOperationRulePack(req.params.typeName, RoleEntity.parseId(req.params.roleId)));
            });

        // POST the edited operation rule pack → persist (upsert/delete RuleOperation rows) + invalidate.
        ws.post("/api/authAdmin/operationRules",
            { req: OperationRulePack },
            async (req, res) => {
                await OperationAuthLogic.setOperationRulePack(await req.jsonTyped());
                res.status(204).end();
            });

        // GET the query rule pack for a (type, role) — PER-TYPE. Every query of the type + allowed/base.
        ws.get("/api/authAdmin/queryRules/:typeName/:roleId",
            { params: CustomType<{ typeName: string; roleId: string }>(), res: QueryRulePack },
            async (req, res) => {
                res.jsonTyped(await QueryAuthLogic.getQueryRulePack(req.params.typeName, RoleEntity.parseId(req.params.roleId)));
            });

        // POST the edited query rule pack → persist (upsert/delete RuleQuery rows) + invalidate.
        ws.post("/api/authAdmin/queryRules",
            { req: QueryRulePack },
            async (req, res) => {
                await QueryAuthLogic.setQueryRulePack(await req.jsonTyped());
                res.status(204).end();
            });

        // GET the property rule pack for a (type, role) — PER-TYPE. Every property route + allowed/base.
        ws.get("/api/authAdmin/propertyRules/:typeName/:roleId",
            { params: CustomType<{ typeName: string; roleId: string }>(), res: PropertyRulePack },
            async (req, res) => {
                res.jsonTyped(await PropertyAuthLogic.getPropertyRulePack(req.params.typeName, RoleEntity.parseId(req.params.roleId)));
            });

        // POST the edited property rule pack → persist (upsert/delete RuleProperty rows) + invalidate.
        ws.post("/api/authAdmin/propertyRules",
            { req: PropertyRulePack },
            async (req, res) => {
                await PropertyAuthLogic.setPropertyRulePack(await req.jsonTyped());
                res.status(204).end();
            });

        // GET the owned-part CLOSURE for a type — [ownerCleanName, ...partCleanNames] (parts ordered by
        // ownership depth). altea-only: a per-type dimension drill-in renders one rule table per type in
        // the same modal so a Part's property/operation/query rules stay editable even though the Part is
        // hidden from the Type-Auth grid. A type owning no parts returns just [itself].
        ws.get("/api/authAdmin/partClosure/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<string[]>() },
            (req, res) => {
                res.json(TypeAuthLogic.ownedPartClosure(req.params.typeName));
            });

        // Export ALL auth rules as a Southwind-style AuthRules.xml download (Signum's AuthAdminController
        // ExportRules). Import is a terminal operation (renames need a console / an AutoReplacement), so no
        // upload endpoint — see the eastwind terminal `import-auth`.
        ws.get("/api/authAdmin/downloadAuthRules",
            {},
            async (_req, res) => {
                const xml = await AuthImportExport.exportAuthRules();
                res.setHeader("Content-Disposition", attachmentDisposition("AuthRules.xml"));
                res.type("application/xml").send(xml);
            });
    }
}
