import type { Quoted, ExArray } from 'quote-transformer/quoted';
import { BaseEntity, EmbeddedEntity, MixinEntity } from './entity';
import type { Type, View, ViewType, Entity } from './entity';
import type { FieldInfo } from './reflection';
import { tryGetTypeInfo } from './reflection';
import { cleanTypeName } from './registration';
import { getLambdaMembers, quotedMembers, type LambdaMember } from './lambdaMembers';
import { MixinDeclarations } from './mixinDeclarations';

// A FIELD OF ONE TABLE'S ROW — the schema's route, which PropertyRoute can no longer be.
//
// Signum's PropertyRoute meant both "the route to a database column" and "the property a PropertyAuth rule
// names". altea's PropertyRoute took the second meaning: every collection is a `@part` table, and a part's
// members are routes OF the entity that owns it (`(Dashboard).parts/content.(TextPart).textContent`), so a
// route no longer says which table — let alone which column — it reaches. The schema needs that, for an
// index key, an ignored column, a BigString's storage: a FieldRoute is rooted at the TABLE's type (a part
// row included, `(TextPart).textContent`), and its steps stay in that row:
//   - a FIELD step, which may continue only through an EMBEDDED (flattened into the same row);
//   - a MIXIN step, explicit — on the root entity (the table's own mixin fields) or on an embedded (a
//     mixin declared on the embedded type, like BigStringMixin on BigStringEmbedded).
// It ends at any field — a value, a reference (its FK column), a whole embedded.
//
// The steps are checked against reflection as they are added, so a typo or a step that leaves the row fails
// where the route is written. A route has one spelling, `toString()` — `(CleanName).address.city`,
// `(OperationLog).[DiffLogMixin].initialState` — which is what a map keyed by routes stores; the maps' own
// setters and getters take the FieldRoute.

export type FieldRouteStep =
    | { readonly type: "Field"; readonly name: string; readonly fieldInfo: FieldInfo }
    | { readonly type: "Mixin"; readonly name: string; readonly mixinType: Type<MixinEntity> };

export class FieldRoute {
    private constructor(
        readonly rootType: Type<Entity> | ViewType<View>,
        readonly parent: FieldRoute | undefined,
        readonly step: FieldRouteStep | undefined,
    ) { }

    static root(type: Type<Entity> | ViewType<View>): FieldRoute {
        return new FieldRoute(type, undefined, undefined);
    }

    /** `FieldRoute.from(AlbumEntity, a => a.address.city)`, `(e => e.mixin(DiffLogMixin).initialState)`. */
    static from<T extends Entity>(type: Type<T>, lambda: Quoted<(entity: T) => unknown>): FieldRoute;
    static from(type: Type<Entity> | ViewType<View>, lambda: Quoted<(entity: any) => unknown>): FieldRoute;
    static from(type: Type<Entity> | ViewType<View>, lambda: Quoted<(entity: any) => unknown>): FieldRoute {
        return FieldRoute.root(type).addLambda(lambda);
    }

    /** The route of a member path already read off a quoted lambda (see getLambdaMembers / quotedMembers). */
    static fromMembers(type: Type<Entity> | ViewType<View>, members: readonly LambdaMember[]): FieldRoute {
        return FieldRoute.root(type).addMembers(members);
    }

    get isRoot(): boolean {
        return this.step == undefined;
    }

    /** The field the route ends at; undefined for a root or a route ending at a mixin step. */
    get fieldInfo(): FieldInfo | undefined {
        return this.step?.type == "Field" ? this.step.fieldInfo : undefined;
    }

    /** The steps, root-first. */
    get steps(): FieldRouteStep[] {
        const result: FieldRouteStep[] = [];
        for (let r: FieldRoute | undefined = this; r?.step != undefined; r = r.parent)
            result.unshift(r.step);
        return result;
    }

    /** The field names along the route, mixins left out — how the value is read off an instance, since altea
     *  inlines mixin fields onto their owner (`mixin()` returns `this`). */
    get fieldPath(): string[] {
        return this.steps.filter(s => s.type == "Field").map(s => s.name);
    }

    // The class whose fields the NEXT step names: the root type, an embedded's type, or a mixin.
    private ownerForNextStep(): Type<BaseEntity> | ViewType<View> {
        const step = this.step;
        if (step == undefined)
            return this.rootType;
        if (step.type == "Mixin")
            return step.mixinType;
        const embedded = step.fieldInfo.getFunction();
        if (step.fieldInfo.array === true || step.fieldInfo.lite === true || embedded == null || !isEmbeddedType(embedded))
            throw new Error(`FieldRoute ${this}: '${step.name}' is not an embedded field, so the route cannot continue — only embedded steps stay in the row.`);
        return embedded;
    }

    add(fieldName: string): FieldRoute {
        const owner = this.ownerForNextStep();
        const fi = tryGetTypeInfo(owner)?.fields[fieldName];
        if (fi == undefined)
            throw new Error(`FieldRoute ${this}: '${fieldName}' is not a field of ${cleanTypeName(owner)}.`);
        return new FieldRoute(this.rootType, this, { type: "Field", name: fieldName, fieldInfo: fi });
    }

    addMixin(mixin: Type<MixinEntity> | string): FieldRoute {
        if (this.step?.type == "Mixin")
            throw new Error(`FieldRoute ${this}: a mixin step cannot follow another.`);
        const owner = this.ownerForNextStep();
        const declared = MixinDeclarations.getMixins(owner as Type<BaseEntity>);
        const mixinType = typeof mixin == "string" ? declared.find(m => m.name === mixin) : declared.find(m => m === mixin);
        if (mixinType == undefined)
            throw new Error(`FieldRoute ${this}: ${typeof mixin == "string" ? mixin : mixin.name} is not a mixin declared on ${cleanTypeName(owner as Type<BaseEntity>)}.`);
        return new FieldRoute(this.rootType, this, { type: "Mixin", name: mixinType.name, mixinType });
    }

    /** Continue with an inline lambda over the value the route ends at: `route.addLambda((b: BigStringEmbedded) => b.text)`. */
    addLambda(lambda: Quoted<(value: any) => unknown>): FieldRoute {
        return this.addMembers(getLambdaMembers(lambda));
    }

    addMembers(members: readonly LambdaMember[]): FieldRoute {
        let route: FieldRoute = this;
        for (const m of members) {
            if (m.type == "Indexer")
                throw new Error(`FieldRoute ${route}: an indexer leaves the row — a collection is a table of its own.`);
            route = m.type == "Mixin" ? route.addMixin(m.name) : route.add(m.name);
        }
        return route;
    }

    equals(other: FieldRoute | undefined): boolean {
        return other != undefined && other.toString() === this.toString();
    }

    toString(): string {
        let result = `(${cleanTypeName(this.rootType as Type<BaseEntity>)})`;
        for (const s of this.steps)
            result += s.type == "Mixin" ? `.[${s.name}]` : `.${s.name}`;
        return result;
    }
}

/**
 * The routes an index selector reads, one per selected field (Signum's `Reflector.GetMemberListBase` per
 * key): `e => [e.code, e.address.city, e.mixin(M).flag]`, rooted at `type` — what the schema resolves to
 * columns (Table.field).
 */
export function accessedRoutes(type: Type<Entity> | ViewType<View>, selector: Quoted<(element: any) => unknown>): FieldRoute[] {
    const quoted = selector.__quoted;
    if (quoted == null)
        throw new Error("An index selector must be @quoted (e => e.code or e => [e.a, e.b]). Is ts-patch + quote-transformer configured?");

    const body = quoted()[2]; // ExLambda = ["=>", params, body]
    const elements = body[0] === "[]" ? (body as ExArray)[1] : [body];
    const routes = elements.map(e => FieldRoute.fromMembers(type, quotedMembers(e)));
    if (routes.length === 0 || routes.some(r => r.isRoot))
        throw new Error("An index selector must read at least one field, e.g. e => [e.name] or e => e.code");
    return routes;
}

function isEmbeddedType(ctor: Function): ctor is Type<EmbeddedEntity> {
    return ctor === EmbeddedEntity || ctor.prototype instanceof EmbeddedEntity;
}

export function isMixinType(ctor: Function | undefined): ctor is Type<MixinEntity> {
    return ctor != undefined && ctor.prototype instanceof MixinEntity;
}

// `AlbumEntity.fieldRoute(a => a.address.city)` — installed here rather than in ./entity, which this module
// imports (the same arrangement as `propertyRoute`, see ./propertyRoute).
declare module "./entity" {
    namespace BaseEntity {
        export function fieldRoute<T extends BaseEntity>(this: Type<T>, lambda: Quoted<(entity: T) => unknown>): FieldRoute;
    }
}

Object.assign(BaseEntity, {
    fieldRoute(this: Type<Entity>, lambda: Quoted<(entity: any) => unknown>): FieldRoute {
        return FieldRoute.from(this, lambda);
    },
});
