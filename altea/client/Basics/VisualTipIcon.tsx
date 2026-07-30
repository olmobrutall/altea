import * as React from 'react';

// STUB (SearchControl port). The visual-tip help-overlay subsystem (Signum's VisualTipIcon +
// the SearchVisualTip symbol container in Signum.Basics + the per-tip content in
// SearchControlVisualTips) is DEFERRED — it's a peripheral onboarding-help feature. The icon
// renders nothing and never invokes `content`, so the query UI works without it. TODO(port).
export interface VisualTipIconProps {
  visualTip: unknown;
  content: (injected: unknown) => React.ReactElement | null;
  className?: string;
}

export function VisualTipIcon(_p: VisualTipIconProps): React.ReactElement | null {
  return null;
}

// STUB for Signum.Basics' SearchVisualTip symbol container — only the ids the ported UI references.
export const SearchVisualTip = {
  FilterHelp: "SearchVisualTip.FilterHelp",
  ColumnHelp: "SearchVisualTip.ColumnHelp",
  GroupHelp: "SearchVisualTip.GroupHelp",
  SearchHelp: "SearchVisualTip.SearchHelp",
};
