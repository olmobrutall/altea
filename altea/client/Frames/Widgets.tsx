// Ported from Signum.React/Frames/Widgets.tsx — copy-and-fix. altea fixes: import paths
// (Signum.Entities→entities/*, Globals→entities/globals); ModifiableEntity→BaseEntity; dropped the
// unused EntityPack import; type-only TypeContext/EntityFrame.
import * as React from 'react'
import type { BaseEntity } from '../../data/entity'
import type { TypeContext, EntityFrame } from '../TypeContext'
import "./Widgets.css"
import { ErrorBoundary } from '../Components';
import { classes } from "../../data/globals";

export interface WidgetContext<T extends BaseEntity> {
  ctx: TypeContext<T>;
  frame: EntityFrame;
}

export const onWidgets: Array<(ctx: WidgetContext<BaseEntity>) => React.ReactElement | undefined> = [];
export const onEmbeddedWidgets: Array<(ctx: WidgetContext<BaseEntity>) => EmbeddedWidget[] | undefined> = [];


export function clearWidgets(): void {
  onWidgets.clear();
  onEmbeddedWidgets.clear();
}

export function renderWidgets(wc: WidgetContext<BaseEntity>, stickyHeader?: boolean): React.ReactNode | undefined {
  const widgets = onWidgets.map(a => a(wc)).filter(a => a != undefined);

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
