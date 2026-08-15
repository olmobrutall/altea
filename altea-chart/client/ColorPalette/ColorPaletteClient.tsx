import * as React from 'react'
import * as ColorUtils from './ColorUtils'
import { getColorInterpolation } from './ColorUtils'
import '@altea/altea/data/globals/arrayExtensions'

// Partial port of Signum.Chart/ColorPalette/ColorPaletteClient.tsx — only the two swatch components the
// chart builder's color-parameter dropdowns render. The persisted ColorPalette subsystem (per-type custom
// palettes, its entities/server/API) is deferred.

export function ColorScheme(p: { colorScheme: string }): React.JSX.Element {
  return (<div style={{ height: "20px", width: "150px", display: "inline-flex", verticalAlign: "text-bottom" }} className="me-2">
    {ColorUtils.colorSchemes[p.colorScheme]?.map(c => <div key={c} style={{ flex: "1", backgroundColor: c }} />)}
  </div>);
}

export function ColorInterpolate(p: { colorInterpolator: string }): React.JSX.Element {

  const inter = getColorInterpolation(p.colorInterpolator);

  return (<div style={{ height: "20px", width: "150px", display: "inline-flex", verticalAlign: "text-bottom" }} className="me-2">
    {inter && Array.range(0, 10).map(i => <div key={i} style={{ flex: "1", background: `linear-gradient(90deg, ${inter(i / 10)} 0%, ${inter((i + 1) / 10)} 100%)` }} />)}
  </div>);
}
