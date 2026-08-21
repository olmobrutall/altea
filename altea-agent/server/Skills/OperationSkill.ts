import { OperationLogic, Operations } from "@altea/altea/server/operationLogic";
import { getEntityPack } from "@altea/altea/server/operationServer";
import { Serializer } from "@altea/altea/data/serializer";
import { Metadata } from "@altea/altea/data/metadata";
import { cleanTypeName, getRegisteredTypes, resolveCleanType } from "@altea/altea/data/registration";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import type { ConstructSymbol, DeleteSymbol, ExecuteSymbol, From, FromMany } from "@altea/altea/data/operations";
import { SkillCode, Schema as S } from "../SkillCode";

// Port of Signum.Agent's Skills/OperationSkill.cs — the WRITE half: construct, construct-from, execute and
// delete, plus the type metadata the model needs to fill an entity in.
//
// altea divergences:
//  - `ReflectionServer.GetEntityTypeInfo(type)` / `GetEnumTypeInfo(type)` return Signum's `TypeInfoTS`;
//    altea splits reflection in two (see the repo CLAUDE.md), so `GetTypeInfo` returns the per-request
//    `TypeMetadata` — the half that carries nice names, operations and per-role allowances, which is what
//    the model needs. There is no separate enum path: an enum type has a metadata entry like any other.
//  - `entityJson.Deserialize<Entity>(SignumServer.JsonSerializerOptions)` → `Serializer.parse`, altea's
//    own entity codec. It takes the JSON TEXT, so the tool's argument is a string rather than a JsonObject
//    — which also keeps the tool schema portable across the three providers (none of them accept an
//    untyped object as reliably as a string).
//  - `OperationLogic.ServiceExecute / ServiceConstruct / …` → `Operations.execute / construct / …`.
//  - `Schema.Current.AssertAllowed(type, inUserInterface: true)` has no direct counterpart to call here;
//    type authorization is enforced on the retrieve and save paths themselves (altea's postRetrieveGates
//    and the property write-gate), so a forbidden type fails inside the operation rather than before it.
export class OperationSkill extends SkillCode {

    constructor() {
        super();

        this.shortDescription = "Executes operations in an entity like Construct / Construct_From / Execute (like Save) / Delete. "
            + "IMPORTANT: Most user actions are operations on entities (typically also QueryName), so check for available operations on an entity before rejecting the request.";
        this.isAllowed = () => true;

        this.registerTool({
            name: "GetTypeInfo",
            description: "Gets the type information of a type",
            returnType: "TypeMetadata",
            parameters: S.args({ cleanTypeName: S.string() }),
            invoke: async args => {
                const name = String(args["cleanTypeName"]);
                const ctor = typeWithHint(name);
                const metadata = Metadata.tryType(cleanTypeName(ctor));
                if (metadata == undefined)
                    throw new Error(`No metadata for type '${name}' — is it registered?`);
                return metadata;
            },
        });

        this.registerTool({
            name: "Operation_Construct",
            destructive: true,
            description: "Construct an entity using an operation",
            returnType: "EntityPack",
            parameters: S.args({ typeName: S.string(), operationKey: S.string() }),
            invoke: async args => {
                typeWithHint(String(args["typeName"])); // the hint-producing check Signum does first
                const symbol = resolveOperation<ConstructSymbol<Entity>>(String(args["operationKey"]));
                const created = await Operations.construct(symbol);
                if (created == undefined)
                    throw new Error(`Operation '${symbol.key}' constructed nothing`);
                return await getEntityPack(created);
            },
        });

        this.registerTool({
            name: "Operation_ConstructFrom",
            destructive: true,
            description: "Construct an entity from another entity using an operation",
            returnType: "EntityPack",
            parameters: S.args({ entityJson: entityJsonSchema(), operationKey: S.string() }),
            invoke: async args => {
                const entity = deserializeEntity(String(args["entityJson"]));
                const symbol = resolveOperation<ConstructSymbol<Entity, From<Entity>>>(String(args["operationKey"]));
                return await getEntityPack(await Operations.constructFrom(entity, symbol));
            },
        });

        this.registerTool({
            name: "Operation_ConstructFromMany",
            destructive: true,
            description: "Construct an entity from many entities using an operation",
            returnType: "EntityPack",
            parameters: S.args({
                entities: S.array(S.string(), 'Lite keys, e.g. "Order;42"'),
                operationKey: S.string(),
            }),
            invoke: async args => {
                const lites = (args["entities"] as string[]).map(k => Lite.parse(k));
                if (new Set(lites.map(l => l.entityType)).size !== 1)
                    throw new Error("All lites must be of the same type when no common base type can be inferred");
                const symbol = resolveOperation<ConstructSymbol<Entity, FromMany<Entity>>>(String(args["operationKey"]));
                return await getEntityPack(await Operations.constructFromMany(lites, symbol));
            },
        });

        this.registerTool({
            name: "Operation_Execute",
            destructive: true,
            description: "Executes an operation on an entity",
            returnType: "EntityPack",
            parameters: S.args({ entityJson: entityJsonSchema(), operationKey: S.string() }),
            invoke: async args => {
                const entity = deserializeEntity(String(args["entityJson"]));
                const symbol = resolveOperation<ExecuteSymbol<Entity>>(String(args["operationKey"]));
                return await getEntityPack(await Operations.execute(entity, symbol));
            },
        });

        this.registerTool({
            name: "Operation_Delete",
            destructive: true,
            description: "Deletes an entity through a delete operation",
            returnType: "void",
            parameters: S.args({ entityJson: entityJsonSchema(), operationKey: S.string() }),
            invoke: async args => {
                const entity = deserializeEntity(String(args["entityJson"]));
                const symbol = resolveOperation<DeleteSymbol<Entity>>(String(args["operationKey"]));
                await Operations.delete(entity, symbol);
                return null;
            },
        });
    }
}

function entityJsonSchema(): ReturnType<typeof S.string> {
    return S.string("The entity as altea JSON (the shape RetrieveEntity returned, including $type and id)");
}

/** Signum's `GetTypeWithHint` — resolve, or fail naming the near misses. */
function typeWithHint(name: string): Function {
    const ctor = resolveCleanType(name);
    if (ctor != undefined)
        return ctor;

    const similar = getRegisteredTypes()
        .map(cleanTypeName)
        .filter(k => k.toLowerCase().includes(name.toLowerCase()))
        .slice(0, 5);

    throw new Error(`Type '${name}' not found.`
        + (similar.length > 0 ? ` Similar type names are ${similar.join(", ")}` : ""));
}

/** Signum's `DeserializeEntity(entityJson)`, with the property-route hint on failure. */
function deserializeEntity(json: string): Entity {
    try {
        const parsed = Serializer.parse(json);
        if (!(parsed instanceof Entity))
            throw new Error("the payload did not deserialize to an entity");
        return parsed;
    } catch (e) {
        throw new Error(`Error deserializing the entity: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function resolveOperation<S2>(key: string): S2 {
    const symbol = OperationLogic.registeredOperations().find(s => s.key === key);
    if (symbol == undefined) {
        const similar = OperationLogic.registeredOperations()
            .map(s => s.key)
            .filter(k => k.toLowerCase().includes(key.toLowerCase()))
            .slice(0, 5);
        throw new Error(`Operation '${key}' is not registered.`
            + (similar.length > 0 ? ` Similar operation keys: ${similar.join(", ")}` : ""));
    }
    return symbol as S2;
}
