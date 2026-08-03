// Ported from Signum.React/SearchControl/EntityLink.tsx — copy-and-fix. A <Link> to an entity's view
// route that: degrades to a plain span (or hides) when the entity isn't viewable, renders the lite's
// display via Navigator.renderLite, and on click opens the view modal — honouring ctrl/middle-click and
// EntitySettings.avoidPopup (new tab) and inPlaceNavigation, exactly like Signum.
//
// altea idioms vs Signum: lite.EntityType → lite.entityType (a ctor), getToString(x) → x.toString(),
// liteKey(x) → x.key(). DEFERRED: Signum's deleted-entity rendering ([Type id not found] → a non-link
// span) needs EngineMessage._01NotFound, which isn't ported yet.
import * as React from "react";
import { Link } from "react-router";
import type { Lite } from "../../data/lite";
import type { Entity, BaseEntity } from "../../data/entity";
import { Navigator } from "../Navigator";
import * as AppContext from "../AppContext";
import { StyleContext } from "../TypeContext";
import { classes } from "../../data/globals";
import type { ViewPromise } from "../EntitySettings";

export interface EntityLinkProps extends React.HTMLAttributes<HTMLAnchorElement> {
  lite: Lite<Entity>;
  inSearch?: "main" | "related";
  inPlaceNavigation?: boolean;
  hideIfNotViewable?: boolean;
  onNavigated?: (lite: Lite<Entity>) => void;
  getViewPromise?: (e: BaseEntity | null) => undefined | string | ViewPromise<BaseEntity>;
  innerRef?: React.Ref<HTMLAnchorElement>;
  stopPropagation?: boolean;
  extraProps?: any;
  extraQuery?: string;
  shy?: boolean;
}

export default function EntityLink(p: EntityLinkProps): React.ReactElement | null {

  const { lite, inSearch, children, onNavigated, getViewPromise, inPlaceNavigation, shy, hideIfNotViewable, innerRef, stopPropagation, extraProps, extraQuery, ...htmlAtts } = p;

  const settings = Navigator.getSettings(lite.entityType);

  if (!Navigator.isViewable(lite, { isSearch: inSearch })) {
    if (hideIfNotViewable)
      return null;

    return <span data-entity={lite.key()} className={settings?.allowWrapEntityLink ? undefined : "try-no-wrap"}>{children ?? Navigator.renderLite(lite)}</span>;
  }

  return (
    <Link
      ref={innerRef as any}
      to={Navigator.navigateRoute(lite)}
      title={StyleContext.default.titleLabels ? (p.title ?? lite.toString()) : undefined}
      data-entity={lite.key()}
      className={classes(settings?.allowWrapEntityLink ? undefined : "try-no-wrap", shy ? "sf-shy-link" : null)}
      {...(htmlAtts as React.HTMLAttributes<HTMLAnchorElement>)}
      onClick={handleClick}
    >
      {children ?? Navigator.renderLite(lite)}
    </Link>
  );

  function handleClick(event: React.MouseEvent<any>): void {
    if (stopPropagation)
      event.stopPropagation();
    event.preventDefault();
    p.onClick?.call(event.currentTarget, event);

    const s = Navigator.getSettings(lite.entityType);
    const avoidPopup = s != undefined && s.avoidPopup;

    if (event.ctrlKey || event.button == 1 || avoidPopup && !inPlaceNavigation) {
      const vp = getViewPromise && getViewPromise(null);
      window.open(AppContext.toAbsoluteUrl(Navigator.navigateRoute(lite, vp && typeof vp == "string" ? vp : undefined) + (extraQuery ?? "")));
      return;
    }

    if (inPlaceNavigation) {
      const vp = getViewPromise && getViewPromise(null);
      AppContext.navigate(Navigator.navigateRoute(lite, vp && typeof vp == "string" ? vp : undefined) + (extraQuery ?? ""));
    } else {
      Navigator.view(lite, { getViewPromise, buttons: "close", extraProps }).then(() => {
        onNavigated && onNavigated(lite);
      });
    }
  }
}
