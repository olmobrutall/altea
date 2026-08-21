import * as Database from "@altea/altea/server/Database";
import { getEntityPack } from "@altea/altea/server/operationServer";
import { cleanTypeName, getRegisteredTypes, resolveCleanType } from "@altea/altea/data/registration";
import { Entity } from "@altea/altea/data/entity";
import { SkillCode, Schema as S } from "../SkillCode";

// Port of Signum.Agent's Skills/RetrieveSkill.cs — the whole entity plus its `canExecute` map, so the model
// knows which operations would be REJECTED before it tries one.
//
// altea divergences:
//  - `TypeLogic.GetType(name)` → `resolveCleanType(name)` (altea's reflection registry).
//  - `PrimaryKey.Parse(id, type)` → `Entity.parseId(id)`, the static that coerces a route/lite id to the
//    type's own PK form.
//  - `new EntityPackTS(entity, canExecutes)` → `getEntityPack(entity)`, which already builds the pair.
export class RetrieveSkill extends SkillCode {

    constructor() {
        super();

        this.shortDescription = "Retrieves full entity by name";
        this.isAllowed = () => true;

        this.registerTool({
            name: "RetrieveEntity",
            description: "Returns a full entity (and his can executes) given its type and id",
            returnType: "EntityPack",
            parameters: S.args({
                typeName: S.string("The clean type name, without the Entity suffix"),
                id: S.string(),
            }),
            invoke: async args => {
                const typeName = String(args["typeName"]);
                const ctor = resolveCleanType(typeName);
                if (ctor == undefined)
                    throw new Error(`Type '${typeName}' not found.${typeNameHint(typeName)}`);

                const type = ctor as unknown as typeof Entity;
                try {
                    const entity = await Database.retrieve(type as never, type.parseId(String(args["id"])));
                    return await getEntityPack(entity as Entity);
                } catch (e) {
                    throw new Error(`${e instanceof Error ? e.message : String(e)}\n`
                        + "Hint: the entity with that ID may not exist. Check the ID or use a search to find the correct one."
                        + typeNameHint(typeName));
                }
            },
        });
    }
}

/** Signum's AddTypeNameHint — name the near misses on the way out. */
function typeNameHint(typeName: string): string {
    const similar = getRegisteredTypes()
        .map(cleanTypeName)
        .filter(k => k.toLowerCase().includes(typeName.toLowerCase()))
        .slice(0, 5);
    return similar.length > 0 ? `\nHint: similar type names: ${similar.join(", ")}` : "";
}
