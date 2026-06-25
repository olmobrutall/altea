
import { getOrCreateTypeInfo, getOrCreateFieldInfo, registerType } from './reflection';

export {
    stringLengthValidator, urlValidator, telephoneValidator,
    emailValidator, noRepeatValidator,
    customValidators as fieldValidation,
} from './validators';

export enum EntityKind {
    SystemString = 'SystemString',
    System = 'System',
    Relational = 'Relational',
    String = 'String',
    Shared = 'Shared',
    Main = 'Main',
    Part = 'Part',
    SharedPart = 'SharedPart',
}

export enum EntityData {
    Transactional = 'Transactional',
    Master = 'Master',
}

export interface EntityInfo {
    kind?: EntityKind;
    data?: EntityData;
}

const symbolWithMetadata = Symbol as any;
if (symbolWithMetadata.metadata == null) {
    symbolWithMetadata.metadata = Symbol.for('Symbol.metadata');
}
const metadataSymbol: symbol = symbolWithMetadata.metadata;

const entityInfoKey = Symbol.for('altea:entityInfo');
const allowUnauthenticatedKey = Symbol.for('altea:allowUnauthenticated');

export function entity(options: EntityInfo = {}) {
    return function (target: Function): void {
        const metadata = (target as any)[metadataSymbol];
        if (metadata != null)
            metadata[entityInfoKey] = options;
        registerType(target);
    };
}

export function allowUnauthenticated(target: Function): void {
    const metadata = (target as any)[metadataSymbol];
    if (metadata != null)
        metadata[allowUnauthenticatedKey] = true;
}

export function ignore(_value: undefined, _context: ClassFieldDecoratorContext): void {
    const key = String(_context.name);
    const typeInfo = getOrCreateTypeInfo(_context.metadata!);
    getOrCreateFieldInfo(typeInfo, key).ignore = true;
}

export function fkProperty(propertyName: string) {
    return function (_value: undefined, context: ClassFieldDecoratorContext): void {
        const key = String(context.name);
        const typeInfo = getOrCreateTypeInfo(context.metadata!);
        getOrCreateFieldInfo(typeInfo, key).fkPropertyName = propertyName;
    };
}

export function implementedBy(types: () => (new () => unknown)[]) {
    return function (_value: undefined, context: ClassFieldDecoratorContext): void {
        const key = String(context.name);
        const typeInfo = getOrCreateTypeInfo(context.metadata!);
        getOrCreateFieldInfo(typeInfo, key).implementations = { kind: 'implementedBy', types: types() };
    };
}

export function implementedByAll(_value: undefined, context: ClassFieldDecoratorContext): void {
    const key = String(context.name);
    const typeInfo = getOrCreateTypeInfo(context.metadata!);
    getOrCreateFieldInfo(typeInfo, key).implementations = { kind: 'implementedByAll' };
}

// Invokes the selector against a recording Proxy to capture the accessed
// property name, e.g. `(c) => c.order` yields "order". Lets @backReference take
// a type-checked lambda instead of a magic string.
function capturePropertyName<C>(selector: (c: C) => unknown): string {
    let captured: string | undefined;
    const proxy = new Proxy({}, {
        get(_target, prop): unknown {
            captured = String(prop);
            return undefined;
        },
    });
    selector(proxy as C);
    if (captured == null)
        throw new Error('@backReference selector must access a property, e.g. (c) => c.parent');
    return captured;
}

// Marks a `ChildEntity[]` field as a back-reference array (Altea's MList
// replacement). The selector names the FK property on the child that points
// back to this parent. By default the array is an owned aggregate
// (`cascade: true`): saved and deleted together with the parent.
export function backReference<C>(fkSelector: (child: C) => unknown, options: { cascade?: boolean } = {}) {
    return function (_value: undefined, context: ClassFieldDecoratorContext): void {
        const key = String(context.name);
        const typeInfo = getOrCreateTypeInfo(context.metadata!);
        getOrCreateFieldInfo(typeInfo, key).backReference = {
            childFkProperty: capturePropertyName(fkSelector),
            cascade: options.cascade ?? true,
        };
    };
}
