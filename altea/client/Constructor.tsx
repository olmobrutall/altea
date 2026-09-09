// Ported from Signum.React/Constructor.tsx — copy-paste + fix. altea fixes:
//   - ModifiableEntity → BaseEntity (altea's base of Entity/EmbeddedEntity).
//   - Signum's free `New(typeName, props, pr)` is gone → construct via `resolveType(typeName)` + the
//     class ctor (entities default to isNew/modified in their constructor).
//   - the constructor-operation branch reads the VISIBLE operations (`getOperationInfos`)
//     rather than Signum's `ti.hasConstructorOperation` flag: altea keeps that flag on the metadata
//     blob and computes it BEFORE the per-role filter deliberately (Navigator.hasAllowedConstructor is
//     what it is for), so asking for the operations the role can actually see is both the same question
//     and one lookup less.
import { Dic } from '../data/globals';
import { BaseEntity, type Type } from '../data/entity';
import { isEntityPack, type EntityPack } from '../data/entityPack';
import { resolveType } from '../data/registration';
import { PropertyRoute, isPartType } from '../data/propertyRoute';
import { tryGetTypeInfo, getOperationInfos } from './Reflection';
import { SelectorMessage } from '../data/uiMessages';
import type { ConstructorOperationSettings } from './Operations';
import type { Entity } from '../data/entity';
import type { OperationMetadata } from '../data/metadata';
import type { TypeInfo } from '../data/reflection';
import * as AppContext from './AppContext';

declare module "./AppContext" {
  interface IClientState {
    customConstructors?: { [typeName: string]: (props?: any, pr?: PropertyRoute) => BaseEntity | Promise<BaseEntity | EntityPack<BaseEntity> | undefined> };
  }
}
import { Navigator } from './Navigator';

export namespace Constructor {

  // In `AppContext.clientState` rather than a module-level dictionary — see the note on Navigator's
  // entitySettings. `registerConstructor` REFUSES a duplicate unless `override` is passed, so a host that
  // re-runs its registration bundle on a credential change would otherwise throw on the second run.
  export function customConstructors(): { [typeName: string]: (props?: any, pr?: PropertyRoute) => BaseEntity | Promise<BaseEntity | EntityPack<BaseEntity> | undefined> } {
    return AppContext.clientState.customConstructors ??= {};
  }

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
    // A `@part` may not root a route (PropertyRoute.isPartType) — the caller's own `pr`, which is the
    // owner's field route when a Line is constructing a row, is the right one and is already in hand.
    if (ti && !isPartType(ti.ctor))
      pr = PropertyRoute.root(ti.ctor!);

    const c = customConstructors()[typeName];
    if (c)
      return asPromise(c(props, pr)).then<EntityPack<BaseEntity> | undefined>(e => {
        if (e == undefined)
          return undefined;

        assertCorrect(isEntityPack(e) ? e.entity : e);
        return Navigator.toEntityPack(e);
      });

    // A type whose creation is an OPERATION is created by RUNNING it, not by `new`. That is what fills in
    // everything the server owns — for an order, the state (`New`), the employee taken from the current
    // user's claim, the customer's address copied onto the shipping one. Falling through to a plain `new`
    // instead left every one of those unset, and the entity then came back from `toEntityPack` with its
    // Save DISABLED, because the operation's `fromStates` cannot match a state nobody assigned.
    const constructors = getOperationInfos(ti?.ctor).filter(oi => oi.operationType == "Constructor");
    if (constructors.length > 0)
      return constructWithOperation(ti!, constructors, props);

    return plainNew(typeName, props, pr);
  }

  // Signum's inline `hasConstructorOperation` block. Split out, and reaching Operations / SelectorModal
  // through a DEFERRED import, because a static one is a module-eval cycle: the Lines import Constructor
  // (EntityBase, EntityListBase), Operations imports Finder, and Finder imports FinderRules — whose
  // editors are the Lines. Statically it made EntityCombo extend an EntityBaseController that had not
  // finished evaluating. Deciding WHETHER to take this path stays static (the reflection helpers above),
  // so the ordinary `new` path costs no extra module load; only running an operation pays for one.
  async function constructWithOperation(ti: TypeInfo, constructors: OperationMetadata[], props?: any): Promise<EntityPack<BaseEntity> | undefined> {
    const { Operations, ConstructorOperationContext } = await import('./Operations');
    const { default: SelectorModal } = await import('./SelectorModal');

    const oi = await SelectorModal.chooseElement(constructors, {
      buttonDisplay: c => c.niceName,
      buttonName: c => c.key,
      message: SelectorMessage.PleaseSelectAConstructor.niceToString(),
    });

    if (oi == undefined)
      return undefined;

    const settings = Operations.getSettings(oi.key) as ConstructorOperationSettings<Entity> | undefined;
    const coc = new ConstructorOperationContext<Entity>(oi, settings!, ti);

    const pack = settings?.onConstruct ? await settings.onConstruct(coc, props) :
      coc.assignProps(await coc.defaultConstruct(), props);

    if (pack == undefined)
      return undefined;

    assertCorrect(pack.entity);
    return pack;
  }

  function plainNew(typeName: string, props?: any, pr?: PropertyRoute): Promise<EntityPack<BaseEntity>> {
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
    const cs = customConstructors();
    if (cs[typeName] && !(options?.override))
      throw new Error(`Constructor for ${typeName} already registered`);

    cs[typeName] = constructor as any;
  }

  export function clearCustomConstructors(): void {
    AppContext.clientState.customConstructors = undefined;
  }

}
