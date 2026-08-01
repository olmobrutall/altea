// Ported from Signum.React/ImportComponent.tsx — copy-paste + fix. Lazily imports a module (its
// `default` export must be a React component) and renders it once resolved. Used by Navigator's
// `/view` `/create` routes and Finder's `/find` route to code-split the FramePage/SearchPage.
//
// MUST be a function component driven by useAPI keyed on `onImport.toString()` (Signum's design):
// react-router renders <ImportComponent> at the SAME tree position for every code-split route, so
// React reconciles by type+position and REUSES this instance across a route change (e.g. /find →
// /view). A class that loads once in componentDidMount would keep rendering the STALE page under the
// new route's params (SearchPage seeing an undefined queryName → "Unexpected pseudoType undefined").
// useAPI returns undefined the moment the dep changes, so we render nothing until the new module
// resolves instead of the previous route's component.
import * as React from 'react'
import { useAPI } from './Hooks'

interface ImportComponentProps {
  onImport: () => Promise<{ default: React.ComponentType<any> }>;
  componentProps?: {};
}

export function ImportComponent({ onImport, componentProps }: ImportComponentProps): React.ReactElement | null {
  const module = useAPI(() => onImport(), [onImport.toString()]);

  if (!module)
    return null;

  return React.createElement(module.default, componentProps);
}

export default ImportComponent;
