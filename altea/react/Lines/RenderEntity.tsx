// Ported from Signum.React/Lines/RenderEntity.tsx — copy-paste + fix. altea fixes:
//   - ModifiableEntity → BaseEntity; ViewPromise from ../EntitySettings.
//   - idioms: isLite(e)→e instanceof Lite; e.entity→e.entityOrNull (altea's Lite.entity throws when
//     unloaded); entity.Type→getTypeName(entity); PropertyRoute.root(ti)→PropertyRoute.root(ti.ctor!).
//   - Signum's `ctx.propertyRoute.typeReference().isLite` (TypeReference gone) → isRuntimeLite of the
//     property route's RuntimeType.
//   - builds a minimal inline EntityFrame + renders the sub-entity's view component directly (no
//     FrameModal needed); the frame's onClose/onReload/setError/execute throw (not used in a line).
import * as React from 'react'
import { Navigator } from '../Navigator'
import { ViewPromise } from '../EntitySettings'
import { TypeContext, type EntityFrame } from '../TypeContext'
import { PropertyRoute, tryGetTypeInfo, getTypeName, isRuntimeLite } from '../Reflection'
import { ReadonlyBinding } from '../binding'
import { BaseEntity, Entity } from '../../entities/entity'
import { Lite } from '../../entities/lite'
import { ErrorBoundary } from '../Components'
import { useAPI, useForceUpdate } from '../Hooks'
import { FunctionalAdapter } from '../Modals'
import { type AsEntity } from './EntityBase'

export interface RenderEntityProps<V extends BaseEntity | Lite<Entity> | null> {
  ctx: TypeContext<V>;
  getComponent?: (ctx: TypeContext<AsEntity<V>>) => React.ReactElement;
  getViewPromise?: (e: AsEntity<V>) => undefined | string | ViewPromise<AsEntity<V>>;
  onRefresh?: () => void;
  onEntityLoaded?: () => void;
  extraProps?: any;
  currentDate?: string;
  previousDate?: string;
}

interface FuncBox<V extends BaseEntity> {
  func: ((ctx: TypeContext<V>) => React.ReactElement);
  lastEntity: V;
}

export function RenderEntity<V extends BaseEntity | Lite<Entity> | null>(p: RenderEntityProps<V>): React.ReactElement | null {

  var e = p.ctx.value

  Navigator.useFetchAndRemember(e instanceof Lite && p.ctx.propertyRoute != null ? e : null, p.onEntityLoaded);
  var entity = (e instanceof Lite ? e.entityOrNull : e) as AsEntity<V>;
  var entityComponent = React.useRef<React.Component | null>(null);
  var forceUpdate = useForceUpdate();

  var componentBox = useAPI<FuncBox<AsEntity<V>> | "useGetComponent" | null>(() => {
    if (p.ctx.propertyRoute == null)
      return Promise.resolve(null);

    if (p.getComponent)
      return Promise.resolve("useGetComponent");

    if (entity == null)
      return Promise.resolve(null);

    var vp = p.getViewPromise && p.getViewPromise(entity);
    var viewPromise = vp == undefined || typeof vp == "string" ? Navigator.getViewPromise(entity, vp) : vp;
    return viewPromise.promise.then(p => ({ func: p, lastEntity: entity! }) as FuncBox<AsEntity<V>>);
  }, [entity, p.getComponent == null, p.getViewPromise && entity && toViewName(p.getViewPromise(entity))], { avoidReset: true });

  if (p.ctx.propertyRoute == null)
    return null;

  if (entity == undefined)
    return null;

  if (componentBox == null)
    return null;

  if (componentBox == "useGetComponent" && p.getComponent == null)
    return null;

  const lastEntity = typeof componentBox == "object" ? componentBox.lastEntity : entity;

  const ti = tryGetTypeInfo(getTypeName(entity));

  const ctx = p.ctx;

  const pr = !ti ? ctx.propertyRoute : PropertyRoute.root(ti.ctor!);

  const prefix = isRuntimeLite(ctx.propertyRoute!.type) ? ctx.prefix + ".entity" : ctx.prefix;
  const frame: EntityFrame<BaseEntity> = {
    tabs: undefined,
    frameComponent: { forceUpdate: () => { forceUpdate(); p.onRefresh?.(); }, type: RenderEntity },
    entityComponent: entityComponent.current,
    pack: { entity: lastEntity, canExecute: {} },
    revalidate: () => p.ctx.frame && p.ctx.frame.revalidate(),
    onClose: () => { throw new Error("Not implemented Exception"); },
    onReload: pack => { throw new Error("Not implemented Exception"); },
    setError: (modelState, initialPrefix) => { throw new Error("Not implemented Exception"); },
    refreshCount: (ctx.frame ? ctx.frame.refreshCount : 0),
    allowExchangeEntity: false,
    prefix: prefix,
    isExecuting: () => false,
    execute: () => { throw new Error("Not implemented Exception"); },
    currentDate: p.currentDate,
    previousDate: p.previousDate,
  };

  function setComponent(c: React.Component<any, any> | null) {
    if (c && entityComponent.current != c) {
      entityComponent.current = c;
      forceUpdate();
    }
  }


  const newCtx = new TypeContext<AsEntity<V>>(ctx, { frame }, pr, new ReadonlyBinding(lastEntity, ""), prefix);
  if (ctx.previousVersion && ctx.previousVersion.value)
    newCtx.previousVersion = { value: ctx.previousVersion.value as any };
  var element = componentBox == "useGetComponent" ? p.getComponent!(newCtx) : componentBox.func(newCtx);

  if (p.extraProps)
    element = React.cloneElement(element, p.extraProps);

  return (
    <div data-property-path={ctx.propertyPath}>
      <ErrorBoundary>
        {FunctionalAdapter.withRef(element, c => setComponent(c))}
      </ErrorBoundary>
    </div>
  );
}

const Anonymous = "__Anonymous__";
function toViewName(result: undefined | string | ViewPromise<any>): string | undefined {
  return (result instanceof ViewPromise ? Anonymous : result);
}
