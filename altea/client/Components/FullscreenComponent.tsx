import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { EntityControlMessage } from "../../data/uiMessages";
import { LinkButton } from "../Basics/LinkButton";
import "./FullscreenComponent.css";

// Port of Signum's React/Components/FullscreenComponent.tsx — the maximize / minimize (and optional
// reload) mini-buttons that sit in the top-right gutter of a chart, a chart table or a dashboard part.
// Maximized, the child fills a fixed overlay over the whole viewport.
//
// `children` is a FUNCTION of the current state rather than a node, because the consumer has to REACT to
// the toggle and not merely be re-parented by it: ReactChart measures its container once and caches the
// size, so it takes `fullScreen` through its `sizeDeps` to re-measure at the new size. A plain node would
// be resized by CSS and then paint a chart laid out for the old box.
//
// altea divergences: none in behaviour. The messages come from `data/uiMessages`' EntityControlMessage
// (Signum reads them off the C#-generated Signum.Entities), and the import path is the core
// `client/Components` barrel rather than Signum's direct-file convention.
interface FullscreenComponentProps {
  children: (fullScreen: boolean) => React.ReactNode;
  onReload?: (e: React.MouseEvent<any>) => void;
}

export function FullscreenComponent(p: FullscreenComponentProps): React.ReactElement {

  const [isFullScreen, setIsFullScreen] = React.useState(false);

  function handleExpandToggle(e: React.MouseEvent<any>): void {
    setIsFullScreen(!isFullScreen);
  }

  return (
    <div className="sf-fullscreen-component" style={!isFullScreen ? { display: "flex", flex: 1 } : ({
      display: "flex",
      position: "fixed",
      background: "var(--bs-body-bg)",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      height: "auto",
      zIndex: 9999,
    })}>

      {/* `width: 0px` with flexGrow 1: a flex item's automatic minimum size is its CONTENT, so an SVG
          chart that overflows would push the buttons off the edge instead of shrinking. */}
      <div style={{ flexGrow: 1, display: "flex", width: "0px" }}>
        {p.children(isFullScreen)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginLeft: "5px" }}>
        <LinkButton onClick={handleExpandToggle} tabIndex={0} className="sf-chart-mini-icon"
          title={isFullScreen ? EntityControlMessage.Minimize.niceToString() : EntityControlMessage.Maximize.niceToString()}>
          <FontAwesomeIcon aria-hidden={true} icon={isFullScreen ? "compress" : "expand"} />
        </LinkButton>
        {p.onReload &&
          <LinkButton onClick={e => { p.onReload!(e); }} className="sf-chart-mini-icon"
            title={EntityControlMessage.Reload.niceToString()}>
            <FontAwesomeIcon aria-hidden={true} icon={"arrow-rotate-right"} />
          </LinkButton>
        }
      </div>

    </div>
  );
}
