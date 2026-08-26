// Ported from Signum.React/Frames/Widgets.tsx — copy-and-fix. altea fixes: import paths
// (Signum.Entities→entities/*, Globals→entities/globals); ModifiableEntity→BaseEntity; dropped the
// unused EntityPack import; type-only TypeContext/EntityFrame.
import * as React from 'react'
import type { BaseEntity } from '../../data/entity'
import type { TypeContext, EntityFrame } from '../TypeContext'
import "./Widgets.css"
import { ErrorBoundary } from '../Components';
import { classes } from "../../data/globals";
import * as AppContext from '../AppContext';

export interface WidgetContext<T extends BaseEntity> {
  ctx: TypeContext<T>;
  frame: EntityFrame;
}

// altea: the widget registries live in `AppContext.clientState`, not in module-level arrays — see the note
// on Navigator's entitySettings. They are filled by module `start()` calls, so a host that re-runs its
// registration bundle on a credential change (Signum's `clearAllSettings()` + `startFull(routes)`) would
// otherwise register every widget a second time and render it twice.
interface WidgetsClientState {
  onWidgets: Array<(ctx: WidgetContext<BaseEntity>) => React.ReactElement | undefined>;
  onEmbeddedWidgets: Array<(ctx: WidgetContext<BaseEntity>) => EmbeddedWidget[] | undefined>;
}
declare module "../AppContext" {
  interface IClientState {
    widgets?: WidgetsClientState;
  }
}

function state(): WidgetsClientState {
  return AppContext.clientState.widgets ??= { onWidgets: [], onEmbeddedWidgets: [] };
}

export function onWidgets(): Array<(ctx: WidgetContext<BaseEntity>) => React.ReactElement | undefined> {
  return state().onWidgets;
}

export function onEmbeddedWidgets(): Array<(ctx: WidgetContext<BaseEntity>) => EmbeddedWidget[] | undefined> {
  return state().onEmbeddedWidgets;
}

export function clearWidgets(): void {
  AppContext.clientState.widgets = undefined;
}

export function renderWidgets(wc: WidgetContext<BaseEntity>, stickyHeader?: boolean): React.ReactNode | undefined {
  const widgets = onWidgets().map(a => a(wc)).filter(a => a != undefined);

  if (widgets.length == 0)
    return undefined;

  return (
    <ErrorBoundary>
      <div className={classes("sf-widgets", stickyHeader && "sf-sticky-header")}>
        {widgets.slice().reverse().map((w, i) => React.cloneElement((w as React.ReactElement), { key: i }))}
      </div>
    </ErrorBoundary>
  );
}

export interface EmbeddedWidget {
  embeddedWidget: React.ReactElement;
  position: EmbeddedWidgetPosition;
  title: React.ReactNode;
  eventKey: string;
}

export type EmbeddedWidgetPosition = "Top" | "Bottom" | "Tab";
