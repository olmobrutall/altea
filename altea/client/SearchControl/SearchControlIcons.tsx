import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

// The column / filter icons the SearchControl's context menu and its VISUAL TIPS both draw — moved out of
// SearchControlLoaded, which re-exports them (see the note there on the module cycle that forced it).
//
// Signum keeps them at the bottom of SearchControlLoaded.tsx; nothing here depends on the control, so a
// module of their own costs nothing and is what lets the help content name them.

export function getResotreDefaultColumnsIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="table-columns" transform="left-2" color="var(--bs-secondary-color)" />
    <FontAwesomeIcon aria-hidden={true} icon="rotate-left" transform="shrink-4 up-8 right-8" color="var(--bs-body-color)" />
  </span>
}

export function getGroupByThisColumnIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="table-columns" transform="left-2" color="var(--bs-secondary-color)" />
    <FontAwesomeIcon aria-hidden={true} icon={["fas", "layer-group"]} transform="shrink-3 up-8 right-8" color="var(--bs-cyan)" />
  </span>
}

export function getRemoveOtherColumns(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="table-columns" transform="left-2" color="var(--bs-secondary-color)" />
    <FontAwesomeIcon aria-hidden={true} icon="remove" transform="shrink-4 up-8 right-8" color="var(--bs-body-color)" />
  </span>
}

export function getRemoveColumnIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="table-columns" transform="left-2" color="var(--bs-secondary-color)" />
    <FontAwesomeIcon aria-hidden={true} icon={["fas", "square-xmark"]} transform="shrink-3 up-8 right-8" color="var(--bs-danger)" />
  </span>
}

export function getEditAllColumnsIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="table-columns" transform="left-2" color="var(--bs-secondary-color)" />
  </span>
}

export function getTimeMachineIcon(): React.ReactElement {
  return <FontAwesomeIcon aria-hidden={true} icon="clock-rotate-left" transform="left-2" color="blue" />
}

// A bare FontAwesomeIcon is not the fixed width the rest of the column menu uses, so these two arrows
// sat off the shared icon column. Same `fa-layers fa-fw icon` wrapper as the others, so everything
// lines up.
export function getMoveColumnLeftIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="arrow-left" color="var(--bs-body-color)" />
  </span>
}

export function getMoveColumnRightIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="arrow-right" color="var(--bs-body-color)" />
  </span>
}

export function getEditColumnIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="table-columns" transform="left-2" color="var(--bs-secondary-color)" />
    <FontAwesomeIcon aria-hidden={true} icon={["fas", "square-pen"]} transform="shrink-3 up-8 right-8" color="var(--bs-orange)" />
  </span>
}

export function getInsertColumnIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="table-columns" transform="left-2" color="var(--bs-secondary-color)" />
    <FontAwesomeIcon aria-hidden={true} icon={["fas", "square-plus"]} transform="shrink-3 up-8 right-8" color="var(--bs-success)" />
  </span>
}

export function getAddFilterIcon(): React.ReactElement {
  return <span className="fa-layers fa-fw icon">
    <FontAwesomeIcon aria-hidden={true} icon="filter" transform="left-2" color="var(--bs-secondary-color)" />
    <FontAwesomeIcon aria-hidden={true} icon={["fas", "square-plus"]} transform="shrink-3 up-8 right-8" color="var(--bs-blue)" />
  </span>
}
