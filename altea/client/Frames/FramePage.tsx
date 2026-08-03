// Ported from Signum.React/Frames/FramePage.tsx — copy-and-fix (faithful, replaces the reconstruction).
// altea fixes: 'react-router-dom'→'react-router'; ViewPromise←EntitySettings; ReadonlyBinding←../binding;
// entityInfo/parseId/GraphExplorer←Reflection; ModifiableEntity→BaseEntity; getToString(x)→x.toString();
// is(a,b)→a.is(b); ti.name→getTypeName(ti.ctor); entity.Type→getTypeName(entity); PropertyRoute.root(ti)
// →root(ti.ctor); Lite literal→newLite; entity.modified→isGraphModified; dropped unused SelectorMessage/
// OperationType; window data-transfer globals declared.
import * as React from 'react'
import * as AppContext from '../AppContext'
import { Navigator } from '../Navigator'
import { ViewPromise } from '../EntitySettings'
import { Constructor } from '../Constructor'
import { useBlocker, useLocation, useParams } from "react-router"
import { Finder } from '../Finder'
import { ButtonBar } from './ButtonBar'
import type { ButtonBarHandle } from './ButtonBar'
import { Entity, BaseEntity } from '../../data/entity'
import type { Lite } from '../../data/lite'
import type { EntityPack } from '../../data/entityPack'
import { JavascriptMessage } from '../../data/uiMessages'
import { TypeContext } from '../TypeContext'
import type { StyleOptions, EntityFrame } from '../TypeContext'
import { getTypeInfo, GraphExplorer, parseId, entityInfo, getTypeName, newLite } from '../Reflection'
import { PropertyRoute } from '../../data/propertyRoute'
import { ReadonlyBinding } from '../binding'
import { isGraphModified } from '../../data/changes'
import { renderWidgets } from './Widgets'
import type { WidgetContext } from './Widgets'
import { ValidationErrors } from './ValidationErrors'
import type { ValidationErrorsHandle } from './ValidationErrors'
import { ErrorBoundary } from '../Components';
import "./Frames.css"
import { AutoFocus } from '../Components/AutoFocus';
import { useStateWithPromise, useForceUpdate, useMounted, useWindowEvent, useUpdatedRef } from '../Hooks'
import { Operations } from '../Operations'
import WidgetEmbedded from './WidgetEmbedded'
import { useTitle } from '../AppContext'
import { FunctionalAdapter, usePageUIState } from '../Modals'
import { QueryString } from '../QueryString'
import { classes } from '../../data/globals'

declare global {
  interface Window {
    dataForChildWindow?: any;
    dataForCurrentWindow?: any;
  }
}

interface FramePageState {
  pack: EntityPack<Entity>;
  lastEntity: string;
  viewName?: string;
  getComponent: (ctx: TypeContext<Entity>) => React.ReactElement;
  refreshCount: number;
  createNew?: () => Promise<EntityPack<Entity> | undefined>;
  executing?: boolean;
}

export default function FramePage(): React.ReactElement {

  let [state, setState] = useStateWithPromise<FramePageState | undefined>(undefined);
  const stateRef = useUpdatedRef(state);
  const buttonBar = React.useRef<ButtonBarHandle>(null);
  const entityComponent = React.useRef<React.Component | null>(null);
  const validationErrors = React.useRef<ValidationErrorsHandle>(null);
  const mounted = useMounted();
  const forceUpdate = useForceUpdate();
  const params = useParams<{ type: string; id?: string }>();
  const location = useLocation();

  const ti = getTypeInfo(params.type!);
  const type = getTypeName(ti.ctor! as any);
  const id = params.id;

  if (state && getTypeName(state.pack.entity) != type)
    state = undefined;

  if (state && id != null && String((state.pack.entity as Entity).id) != id)
    state = undefined;

  useTitle(state?.pack.entity.toString() ?? "", [state?.pack.entity]);

  usePageUIState(() => ({ name: "FramePage", context: state?.pack ?? null }));

  useLooseChanges(state && !state.executing ? ({ entity: state.pack.entity, lastEntity: state.lastEntity }) : undefined);

  function setPack(pack: EntityPack<Entity>, view: { viewName?: string, getComponent: (ctx: TypeContext<Entity>) => React.ReactElement }, createNew?: () => Promise<EntityPack<Entity> | undefined>) {
    return setState({
      pack,
      lastEntity: pack == state?.pack ? state?.lastEntity : JSON.stringify(pack.entity),
      getComponent: view.getComponent,
      viewName: view.viewName,
      createNew: createNew,
      refreshCount: state ? state.refreshCount + 1 : 0
    });
  }

  React.useEffect(() => {

    var currentEntity = stateRef.current?.pack.entity;

    if (currentEntity && getTypeName(currentEntity) == type && String((currentEntity as Entity).id) == id) {
      if (stateRef.current?.viewName != QueryString.parse(location.search).viewName) {
        loadComponent(stateRef.current!.pack).then(view => {
          if (!mounted.current)
            return undefined;

          setPack(stateRef.current!.pack, view);
        });
      } else {
        return;
      }
    }

    loadEntity()
      .then(a => {
        if (a == undefined) {
          Navigator.onFramePageCreationCancelled();
        }
        else {

          loadComponent(a.pack!).then(view => {
            if (!mounted.current)
              return undefined;

            return setPack(a.pack!, view, a.createNew).then(() => {
              if (id == null && (a.pack!.entity as Entity).id != null) { //Constructor returns saved entity
                AppContext.navigate(Navigator.navigateRoute(a.pack!.entity as Entity));
              }
            })
          }).catch(err => { console.error("FramePage: loadComponent failed", err); });
        }
      })
      .catch(err => { console.error("FramePage: failed to load/render entity", err); }); // surface load/view errors
  }, [type, id, location.search]);


  useWindowEvent("beforeunload", e => {
    if (stateRef.current && hasChanges(stateRef.current)) {
      e.preventDefault(); // If you prevent default behavior in Mozilla Firefox prompt will always be shown
      e.returnValue = '';   // Chrome requires returnValue to be set
    }
  }, []);

  useWindowEvent("keydown", handleKeyDown, []);

  function handleKeyDown(e: KeyboardEvent) {
    if (!e.openedModals && buttonBar.current)
      buttonBar.current.handleKeyDown(e);
  }

  async function loadComponent(pack: EntityPack<Entity>, forceViewName?: string | ViewPromise<BaseEntity>): Promise<{
    viewName?: string;
    getComponent: (ctx: TypeContext<Entity>) => React.ReactElement;
  }> {
    if (forceViewName instanceof ViewPromise) {
      var getComponent = await forceViewName.promise;
      return { viewName: undefined, getComponent: getComponent as (ctx: TypeContext<Entity>) => React.ReactElement };
    } else {

      const viewName = forceViewName ?? QueryString.parse(location.search).viewName ?? undefined;
      const getComponent = await Navigator.getViewPromise(pack.entity, viewName).promise;

      return { viewName, getComponent };
    }
  }


  async function loadEntity(): Promise<undefined | { pack: EntityPack<Entity>, createNew?: () => Promise<EntityPack<Entity> | undefined> }> {

    const queryString = QueryString.parse(location.search);

    if (queryString.waitOpenerData) {
      if (window.opener!.dataForChildWindow == undefined) {
        console.error("No dataForChildWindow in parent found!");
      } else {
        var pack = window.opener!.dataForChildWindow as EntityPack<Entity>;
        window.opener!.dataForChildWindow = undefined;
        var txt = JSON.stringify(pack);
        return {
          pack,
          createNew: () => Promise.resolve(JSON.parse(txt))
        };
      }
    }

    if (queryString.waitCurrentData) {
      if (window.dataForCurrentWindow == undefined) {
        console.error("No dataForCurrentWindow in parent found!");
      } else {
        var pack = window.dataForCurrentWindow as EntityPack<Entity>;
        window.dataForCurrentWindow = undefined;
        var txt = JSON.stringify(pack);
        return {
          pack,
          createNew: () => Promise.resolve(JSON.parse(txt))
        };
      }
    }

    if (id) {

      const lite: Lite<Entity> = newLite(ti.ctor! as any, parseId(ti, id!));

      const pack = await Navigator.API.fetchEntityPack(lite);

      return {
        pack,
        createNew: undefined
      };

    } else {
      const cn = queryString["constructor"];
      if (cn != null && typeof cn == "string") {
        const oi = Operations.operationInfos(ti).single(a => a.operationType == "Constructor" && a.key.toLowerCase().endsWith(cn.toLowerCase()));
        const pack = await Operations.API.construct(type, oi.key);
        if (pack == undefined)
          return undefined;

        return {
          pack: pack as EntityPack<Entity>,
          createNew: () => Operations.API.construct(type, oi.key) as Promise<EntityPack<Entity>>
        };
      }
      else {

        const pack = await Constructor.constructPack(type);
        if (pack == undefined)
          return undefined;

        return ({
          pack: pack! as EntityPack<Entity>,
          createNew: () => Constructor.constructPack(type) as Promise<EntityPack<Entity>>
        });
      }
    }
  }

  function onClose() {
    const settings = Navigator.getSettings(params.type!);

    // If entity has custom navigation route and we have a current entity with an ID, navigate to it
    if (settings?.onNavigateRoute && stateRef.current?.pack.entity && !(stateRef.current.pack.entity as Entity).isNew) {
      const entity = stateRef.current.pack.entity;
      AppContext.navigate(Navigator.navigateRoute(entity as Entity));
    }
    else if (Finder.isFindable(params.type!, true))
      AppContext.navigate(Finder.findOptionsPath({ queryName: params.type! }));
    else
      AppContext.navigate("/");
  }

  function setComponent(c: React.Component | null) {
    if (c && entityComponent.current != c) {
      entityComponent.current = c;
      forceUpdate();
    }
  }

  if (!state) {
    return (
      <div className="normal-control">
        {renderTitle()}
      </div>
    );
  }

  const entity = state.pack.entity;

  const s = state;

  const frame: EntityFrame = {
    tabs: undefined,
    frameComponent: { forceUpdate, type: FramePage },
    entityComponent: entityComponent.current,
    pack: state.pack,
    isExecuting: () => s.executing == true,
    execute: async action => {
      if (s.executing)
        return;

      s.executing = true;
      forceUpdate();
      try {
        await action();
      } finally {
        s.executing = undefined;
        forceUpdate();
      }
    },
    onReload: (pack, reloadComponent, callback) => {

      var packEntity = (pack ?? s.pack) as EntityPack<Entity>;

      const replaceRoute = !(packEntity.entity as Entity).isNew && (entity as Entity).isNew;

      var forcedViewName = typeof reloadComponent == "string" ? reloadComponent : undefined;

      var currentViewName = QueryString.parse(location.search).viewName;

      var newRoute = packEntity.entity.is(entity) && (forcedViewName ?? currentViewName) == currentViewName ? null :
        (packEntity.entity as Entity).isNew ? Navigator.createRoute(getTypeName(packEntity.entity), forcedViewName ?? currentViewName) :
          Navigator.navigateRoute(packEntity.entity as Entity, forcedViewName ?? currentViewName);

      if (reloadComponent) {
        setState(undefined)
          .then(() => loadComponent(packEntity, reloadComponent == true ? undefined : reloadComponent))
          .then(gc => {
            if (mounted.current) {
              setPack(packEntity, gc).then(() => {
                if (newRoute) {
                  if (replaceRoute)
                    AppContext.navigate(newRoute);
                  else
                    AppContext.navigate(newRoute);
                }

                callback && callback();
              });
            }
          });
      }
      else {
        setPack(packEntity, { viewName: s.viewName, getComponent: s.getComponent }).then(() => {
          if (newRoute) {
            AppContext.navigate(newRoute);
          }

          callback && callback();
        });
      }
    },
    onClose: () => onClose(),
    revalidate: () => validationErrors.current && validationErrors.current.forceUpdate(),
    setError: (ms, initialPrefix) => {
      GraphExplorer.setModelState(entity, ms, initialPrefix || "");
      forceUpdate()
    },
    refreshCount: state.refreshCount,
    createNew: state.createNew,
    allowExchangeEntity: true,
    prefix: "framePage"
  };


  const styleOptions: StyleOptions = {
    readOnly: Navigator.isReadOnly(state.pack),
    frame: frame
  };

  const ctx = new TypeContext<Entity>(undefined, styleOptions, PropertyRoute.root(ti.ctor!), new ReadonlyBinding(entity, "framePage"));
  const settings = Navigator.getSettings(getTypeName(ti.ctor! as any));

  const wc: WidgetContext<Entity> = { ctx: ctx, frame: frame };

  var outdated = !(state.pack.entity as Entity).isNew && (getTypeName(state.pack.entity) != type || String((state.pack.entity as Entity).id) != id);

  return (
    <div className="normal-control" style={{ opacity: outdated ? .5 : undefined }}>
      {renderTitle()}
      <div style={state.executing == true ? { opacity: ".7" } : undefined}>
        <div className="sf-button-widget-container">
          {entityComponent.current && <ButtonBar ref={buttonBar} frame={frame} pack={state.pack} />}
        </div>
        <ValidationErrors ref={validationErrors} entity={state.pack.entity} prefix="framePage" />
        <WidgetEmbedded widgetContext={wc} >
          <div className="sf-main-control" data-refresh-count={state.refreshCount} data-main-entity={entityInfo(ctx.value)}>
            <ErrorBoundary>
              {state.getComponent && <AutoFocus>{FunctionalAdapter.withRef(state.getComponent(ctx), c => setComponent(c))}</AutoFocus>}
            </ErrorBoundary>
          </div>
        </WidgetEmbedded>
      </div>
    </div>
  );

  function renderTitle() {

    if (!state)
      return <h1 className="display-6 sf-entity-title h3">{JavascriptMessage.loading.niceToString()}</h1>;

    const entity = state.pack.entity;
    const title = Navigator.renderEntity(entity);
    const subTitle = Navigator.getTypeSubTitle(entity, undefined);
    const widgets = renderWidgets(wc, settings?.stickyHeader);

    return (
      <h1 className={classes("border-bottom pb-3 mb-2 h4", settings?.stickyHeader && "sf-sticky-header")} >
        {title && <>
          <span className="sf-entity-title">{title}</span>&nbsp;
        </>
        }
        {(subTitle || widgets) &&
          <div className="sf-entity-sub-title mt-2">
            {subTitle && <small className="sf-type-nice-name text-muted"> {subTitle}</small>}
            {widgets}
            <br />
          </div>
        }
      </h1>
    );
  }
}

function hasChanges(state: FramePageState) {

  if (state.executing)
    return false;

  const entity = state.pack.entity;
  if (isGraphModified(entity) && JSON.stringify(entity) != state.lastEntity) {
    return true
  }

  return false;
}



export function useLooseChanges(pair?: { entity: BaseEntity, lastEntity: string }): void {

  let blocker = useBlocker(() => pair != null && JSON.stringify(pair.entity) != pair.lastEntity);

  React.useEffect(() => {
    if (blocker.state === "blocked") {
      let proceed = window.confirm(JavascriptMessage.loseCurrentChanges.niceToString());
      if (proceed) {
        window.setTimeout(blocker.proceed, 0);
      } else {
        blocker.reset();
      }
    }
  }, [blocker]);
}
