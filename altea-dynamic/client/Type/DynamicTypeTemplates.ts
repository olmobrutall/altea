import { DynamicBaseType, typeNameWithSuffix, logicName } from "../../data/DynamicType";

// What a new type starts from, per base type — ordinary altea source, the same shape as a hand-written
// domain module. Imports are left out: they are written for the source (see data/DynamicType).

export function dataTemplate(typeName: string, baseType: DynamicBaseType): string {
    const name = typeNameWithSuffix(typeName, baseType);

    if (baseType !== DynamicBaseType.Entity) {
        const base = DynamicBaseType[baseType];
        return [
            `@reflect`,
            `export class ${name} extends ${base} {`,
            ``,
            `    name: string;`,
            `}`,
            ``,
        ].join("\n");
    }

    return [
        `@entity("Main", "Transactional")`,
        `export class ${name} extends Entity {`,
        ``,
        `    name: string;`,
        ``,
        `    @quoted`,
        `    override toString(): string {`,
        `        return this.name;`,
        `    }`,
        `}`,
        ``,
        `export namespace ${typeName}Operation {`,
        `    export const Save: ExecuteSymbol<${name}> = init();`,
        `    export const Delete: DeleteSymbol<${name}> = init();`,
        `}`,
        ``,
    ].join("\n");
}

/** Only an entity needs logic: it has to be included in the schema. */
export function serverTemplate(typeName: string, baseType: DynamicBaseType): string | null {
    if (baseType !== DynamicBaseType.Entity)
        return null;

    return [
        `export namespace ${logicName(typeName)} {`,
        ``,
        `    export function start(sb: SchemaBuilder): void {`,
        `        if (sb.alreadyDefined(start))`,
        `            return;`,
        ``,
        `        sb.include(${typeNameWithSuffix(typeName, baseType)})`,
        `            .withSave(${typeName}Operation.Save)`,
        `            .withDelete(${typeName}Operation.Delete)`,
        `            .withQuery();`,
        `    }`,
        `}`,
        ``,
    ].join("\n");
}

/** `PizzaEntity` / `PizzaOperation` / `PizzaLogic` → the new name, so the source follows a renamed type. */
export function renameType(code: string, oldName: string, newName: string): string {
    if (oldName === "" || oldName === newName)
        return code;
    return code.replace(new RegExp(`\\b${oldName}(Entity|Embedded|Mixin|Model|Operation|Logic)\\b`, "g"), newName + "$1");
}

/** The names a module exports at its top level — enough to resolve the server module's references. */
export function exportedNames(code: string): string[] {
    const result: string[] = [];
    for (const m of code.matchAll(/^export\s+(?:abstract\s+)?(?:class|enum|namespace|function|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/gm))
        result.push(m[1]);
    return result;
}
