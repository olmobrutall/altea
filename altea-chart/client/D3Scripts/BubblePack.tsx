import * as React from 'react'
import * as d3 from 'd3'
import { ChartClient } from '../ChartClient';
import type { ChartColumn, ChartRow, ChartScriptProps } from '../ChartClient';
import * as ChartUtils from './Components/ChartUtils';
import { translate, scale, scaleFor, uniqueKeys } from './Components/ChartUtils';
import { isFolder, isRoot, stratifyTokens } from './Components/Stratify';
import type { Folder, Root } from './Components/Stratify';
import TextEllipsis from './Components/TextEllipsis';
import InitialMessage from './Components/InitialMessage';
import { ChartMessage } from '../../data/ChartMessage';
import { D3ChartScript } from '../../data/ChartScript';
import { getQueryNiceName } from '@altea/altea/client/Reflection';
import '@altea/altea/data/globals/arrayExtensions';
import { chartTitle, ShapeTitleText } from './Components/ChartTitle';

// Copy-and-fix of Signum.Chart/D3Scripts/BubblePack.tsx (d3.pack hierarchy of bubbles). Standard fixes.
export default function renderBubblePack({ data, width, height, parameters, loading, onDrillDown, initialLoad, memo, dashboardFilter, chartRequest }: ChartScriptProps): React.ReactElement<any> {

  if (data == null || data.rows.length == 0)
    return (
      <svg direction="ltr" width={width} height={height}>
        <InitialMessage data={data} x={width / 2} y={height / 2} loading={loading} />
      </svg>
    );

  var keyColumn = data.columns.c0!;
  var valueColumn = data.columns.c1! as ChartColumn<number>;
  var parentColumn = data.columns.c2;
  var colorScaleColumn = data.columns.c3 as ChartColumn<number> | undefined;
  var colorSchemeColumn = data.columns.c4;


  var color: (v: ChartRow) => string | undefined;
  if (colorScaleColumn) {
    var scaleFunc = scaleFor(colorScaleColumn, data.rows.map(r => colorScaleColumn!.getValue(r)), 0, 1, parameters["ColorScale"]);
    var colorInterpolator = ChartUtils.getColorInterpolation(parameters["ColorInterpolate"]);
    color = r => colorInterpolator && colorInterpolator(scaleFunc(colorScaleColumn!.getValue(r))!);
  }
  else if (colorSchemeColumn) {
    var categoryColor = ChartUtils.colorCategory(parameters, data.rows.map(r => colorSchemeColumn!.getValueKey(r)), memo, "colorSchemeColumn");
    color = r => colorSchemeColumn!.getColor(r) ?? categoryColor(colorSchemeColumn!.getValueKey(r));
  }
  else {
    var categoryColor = ChartUtils.colorCategory(parameters, data.rows.map(r => keyColumn.getValueKey(r)), memo, "colorCategory");
    color = r => keyColumn.getValueColor(r) ?? categoryColor(keyColumn.getValueKey(r));
  }

  var folderColor: null | ((folder: unknown) => string) = null;
  if (parentColumn) {
    var categoryColor = ChartUtils.colorCategory(parameters, data.rows.map(r => parentColumn!.getValueKey(r)), memo, "parentColorCategory");
    folderColor = folder => parentColumn!.getColor(folder) ?? categoryColor(parentColumn!.getKey(folder));
  }

  var format = d3.format(",d");

  var root = stratifyTokens(data, keyColumn, parentColumn);

  var size = scaleFor(valueColumn, data.rows.map(r => valueColumn.getValue(r)), 0, 1, parameters["Scale"]);

  root.sum(r => r == null ? 0 : size(valueColumn.getValue(r as ChartRow))!);

  var bubble = d3.pack<ChartRow | Folder | Root>()
    .size([width, height])
    .padding(2);

  const circularRoot = bubble(root);

  const nodes = circularRoot.descendants().filter(d => !isRoot(d.data)) as d3.HierarchyCircularNode<(ChartRow | Folder) & { active?: boolean }>[];

  const activeDetector = ChartClient.getActiveDetector(dashboardFilter, chartRequest);

  const getNodeKey = (n: d3.HierarchyCircularNode<ChartRow | Folder>): string => {
    var last = isFolder(n.data) ? parentColumn!.getKey(n.data.folder) :
      keyColumn!.getValueKey(n.data) + (colorSchemeColumn ? colorSchemeColumn.getValueKey(n.data) : "");

    if (n.parent && !isRoot(n.parent.data))
      return getNodeKey(n.parent) + " / " + last;

    return last;
  };

  var showNumber = parseFloat(parameters["NumberOpacity"]) > 0;
  var numberSizeLimit = parseInt(parameters["NumberSizeLimit"]);

  // Same as TreeMap: getNodeKey names the key and the colour CATEGORY, but not the colour scale, so a
  // plain (non-aggregate) number there makes two bubbles share a key. Ordered first, to match the render.
  const orderedNodes = nodes.orderByDescending(a => a.r);
  const nodeKeys = uniqueKeys(orderedNodes.map(getNodeKey));

  return (
    <svg direction="ltr" width={width} height={height} role="img"
      aria-label={ChartMessage._0Of1_2.niceToString(ChartClient.symbolNiceName(D3ChartScript.BubblePack), getQueryNiceName(chartRequest.queryKey), [valueColumn.title, keyColumn.title].join(", "))}>
      {
        orderedNodes.map((d, i) => {
          const active = activeDetector?.(isFolder(d.data) ? ({ c2: d.data.folder }) : d.data);
          return (
            <g key={nodeKeys[i]} className="node sf-transition hover-group" transform={translate(d.x, d.y) + (initialLoad ? scale(0, 0) : scale(1, 1))} cursor="pointer"
              onClick={e => isFolder(d.data) ? onDrillDown({ c2: d.data.folder }, e) : onDrillDown(d.data, e)} role="button" tabIndex={0} focusable={true}>
              <circle className="sf-transition hover-target" shapeRendering="initial" r={d.r}
                opacity={active == false ? .5 : undefined}
                fill={isFolder(d.data) ? folderColor!(d.data.folder) : color(d.data)!}
                fillOpacity={parameters["FillOpacity"] ?? undefined}
                stroke={active == true ? "var(--bs-body-color)" : parameters["StrokeColor"] ?? (isFolder(d.data) ? folderColor!(d.data.folder) : (color(d.data) ?? undefined))}
                strokeWidth={parameters["StrokeWidth"]} strokeOpacity={1} />
              {!isFolder(d.data) &&
                <TextEllipsis maxWidth={d.r * 2} padding={1} etcText=""
                  dominantBaseline="middle" textAnchor="middle" dy={showNumber && d.r > numberSizeLimit ? "-0.5em" : undefined}>
                  {keyColumn.getValueNiceName(d.data as ChartRow)}
                </TextEllipsis>
              }
              {showNumber && d.r > numberSizeLimit && !isFolder(d.data) &&
                <text fill={parameters["NumberColor"] ?? "#000"}
                  dominantBaseline="middle"
                  textAnchor="middle"
                  fontWeight="bold"
                  opacity={parseFloat(parameters["NumberOpacity"]) * d.r / 30}
                  dy=".5em">
                  {valueColumn.getValueNiceName(d.data as ChartRow)}
                </text>
              }
              {/* A folder is the roll-up of its leaves and not a row, so it carries its own values; a leaf
                  is c0 … c4. This one already named every column, in its own parenthesised format. */}
              <ShapeTitleText text={isFolder(d.data)
                ? chartTitle(null, [
                  { value: parentColumn!.getNiceName(d.data.folder) },
                  { column: valueColumn, value: format(size.invert(d.value!)) }])
                : chartTitle(d.data, [keyColumn, valueColumn, parentColumn,
                  colorScaleColumn, colorSchemeColumn])} />
            </g>);
        })
      }
      <InitialMessage data={data} x={width / 2} y={height / 2} loading={loading} />
    </svg>
  );
}
