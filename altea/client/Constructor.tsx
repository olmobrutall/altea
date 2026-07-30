// Ported from Signum.React/Constructor.tsx — copy-paste + fix. altea fixes:
//   - ModifiableEntity → BaseEntity (altea's base of Entity/EmbeddedEntity).
//   - Signum's free `New(typeName, props, pr)` is gone → construct via `resolveType(typeName)` + the
//     class ctor (entities default to isNew/modified in their constructor).
//   - the `hasConstructorOperation` branch (construct-FROM operations) is STUBBED: the client
//     Operations layer isn't ported yet, so we fall through to a plain New with a TODO. Restore the
//     operation-based construction (SelectorModal.chooseElement + ConstructorOperationContext) once
//     react Operations lands.
import { Dic } from '../entities/globals';
import { BaseEntity, type Type } from '../entities/entity';
import { isEntityPack, type EntityPack } from '../entities/entityPack';
import { resolveType } from '../entities/registration';
import { PropertyRoute } from '../entities/propertyRoute';
import { tryGetTypeInfo } from './Reflection';
import { Navigator } from './Navigator';

export namespace Constructor {

  export const customConstructors: { [typeName: string]: (props?: any, pr?: PropertyRoute) => BaseEntity | Promise<BaseEntity | EntityPack<BaseEntity> | undefined> } = {}

  export function construct<T extends BaseEntity>(type: Type<T>, props?: Partial<T>, pr?: PropertyRoute): Promise<T | undefined>;
  export function construct(type: string, props?: any, pr?: PropertyRoute): Promise<BaseEntity | undefined>;
  export function construct(type: string | Type<any>, props?: any, pr?: PropertyRoute): Promise<BaseEntity | undefined> {
    return constructPack(type as string, props, pr)
      .then(pack => pack?.entity);
  }

  export function constructPack<T extends BaseEntity>(type: Type<T>, props?: Partial<T>, pr?: PropertyRoute): Promise<EntityPack<T> | undefined>;
  export function constructPack(type: string, props?: any, pr?: PropertyRoute): Promise<EntityPack<BaseEntity> | undefined>;
  export function constructPack(type: string | Type<any>, props?: any, pr?: PropertyRoute): Promise<EntityPack<BaseEntity> | undefined> {

    const typeName = (type as any).typeName ?? type as string;

    const ti = tryGetTypeInfo(typeName);
    if (ti)
      pr = PropertyRoute.root(ti.ctor!);

    const c = customConstructors[typeName];
    if (c)
      return asPromise(c(props, pr)).then<EntityPack<BaseEntity> | undefined>(e => {
        if (e == undefined)
          return undefined;

        assertCorrect(isEntityPack(e) ? e.entity : e);
        return Navigator.toEntityPack(e);
      });

    // TODO(port): if ti?.hasConstructorOperation, Signum shows a constructor selector and runs the
    // construct operation (needs the react Operations layer). Falling through to a plain New for now.

    const result = newEntity(typeName, props, pr);

    assertCorrect(result);

    return Navigator.toEntityPack(result);
  }

  function newEntity(typeName: string, props?: any, pr?: PropertyRoute): BaseEntity {
    const ctor = resolveType(typeName);
    if (ctor == null)
      throw new Error(`Cannot construct '${typeName}': type not registered`);
    const e = new (ctor as new () => BaseEntity)();
    if (props)
      Object.assign(e, props);
    return e;
  }

  function asPromise<T>(valueOrPromise: T | Promise<T>) {
    if (valueOrPromise && (valueOrPromise as Promise<T>).then)
      return valueOrPromise as Promise<T>;

    return Promise.resolve(valueOrPromise as T);
  }

  // ALTEA: Signum asserted isNew/modified were set; altea models those differently (isNew on Entity,
  // modification tracked internally), so this just sanity-checks we got a real modifiable entity.
  function assertCorrect(m: BaseEntity) {
    if (!(m instanceof BaseEntity))
      throw new Error("A BaseEntity is expected after constructor");
  }

  export function registerConstructor<T extends BaseEntity>(type: Type<T>, constructor: (props?: Partial<T>, pr?: PropertyRoute) => T | Promise<T | EntityPack<T> | undefined>, options?: { override?: boolean }): void {
    const typeName = (type as any).typeName as string;
    if (customConstructors[typeName] && !(options?.override))
      throw new Error(`Constructor for ${typeName} already registered`);

    customConstructors[typeName] = constructor as any;
  }

  export function clearCustomConstructors(): void {
    Dic.clear(customConstructors);
  }

}
