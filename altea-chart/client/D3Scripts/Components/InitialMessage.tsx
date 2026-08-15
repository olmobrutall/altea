import * as React from 'react'
import type { ChartTable } from '../../ChartClient';
import { JavascriptMessage, SearchMessage } from '@altea/altea/data/uiMessages';
import { useInterval } from '@altea/altea/client/Hooks';

// Copy-and-fix of Signum.Chart/D3Scripts/Components/InitialMessage.tsx. Fixes: @framework/* → altea
// (JavascriptMessage/SearchMessage from uiMessages, useInterval from Hooks); unused d3/Rule/SearchControl dropped.
interface InitialMessageProps {
  x?: number;
  y?: number;
  loading: boolean;
  data?: ChartTable;
}

export default function InitialMessage(p: InitialMessageProps): React.JSX.Element | null {

  var dots = useInterval(p.loading ? 1000 : null, 0, d => (d + 1) % 4);

  if (p.loading)
    return (
      <text x={p.x} y={p.y} className="sf-initial-message loading">
        {JavascriptMessage.loading.niceToString() + ".".repeat(dots) + " ".repeat(3 - dots)}
      </text >
    );

  if (p.data == null)
    return (
      <text x={p.x} y={p.y} className="sf-initial-message search">
        {JavascriptMessage.searchForResults.niceToString()}
      </text >
    );

  if (p.data.rows.length == 0)
    return (
      <text x={p.x} y={p.y} className="sf-initial-message no-results">
        {SearchMessage.NoResultsFound.niceToString()}
      </text >
    );

  return null;
}
