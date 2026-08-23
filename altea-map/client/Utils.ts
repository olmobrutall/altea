import * as d3 from "d3";
import type { Point, Rectangle } from "./Schema/ClientColorProvider";

// Port of Signum.Map's Utils.ts — the geometry and scale helpers both maps share. Unchanged apart from
// the two Signum array extensions altea does not ship (`.max()`), which become plain `Math.max`.

/**
 * The measured height both map pages give their graph container.
 *
 * ALTEA DIVERGENCE: Signum's pages call `useExpand()`, whose Expander takes the page out of the normal
 * `.container-fluid` wrapper so a `flexGrow: 1` chain reaches the viewport. altea has no Expander, and the
 * app shell's wrapper is `display: block` — so `flexGrow` resolves to a 0-height box, `useSize` reports no
 * height, and the renderer never mounts (which is exactly what happened the first time this ran). An
 * explicit viewport-relative floor is the honest fix: the map IS the page, so it should fill the window.
 * The same `minHeight`-on-the-measured-container shape altea-chart's ReactChart uses.
 */
export const MAP_MIN_HEIGHT = "75vh";

// The scale both maps use for "more is worse": cyan → green → yellow → red.
const colors = [
    "#00C7EE",
    "#007B1E",
    "#EDF700",
    "#C82305",
];

export function colorScale(max: number): d3.ScaleLinear<string, string> {
    return d3.scaleLinear<string>()
        .domain(colors.map((c, i, a) => (i / a.length) * max))
        .range(colors);
}

/**
 * The same palette on a LOG domain, which is what makes a schema map readable: table sizes span orders of
 * magnitude, so a linear scale paints everything but the largest table the same colour. Signum inverts a
 * log scale to find the domain stops; kept verbatim.
 */
export function colorScaleLog(max: number): d3.ScaleLogarithmic<string, string> {
    const limit = 500;
    const sqrScale = d3.scaleLog().domain([0.25, Math.max(max, 1)]).range([0, limit]).base(2);

    const forInversion = colors.map((c, i, a) => (i / (a.length - 1)) * limit);
    const logColourValues = forInversion.map(sqrScale.invert);

    return d3.scaleLog<string>()
        .domain(logColourValues)
        .range(colors).base(2);
}

export function center(rec: Rectangle): Point {
    return {
        x: rec.x! + rec.width / 2,
        y: rec.y! + rec.height / 2,
    };
}

/** Where the line from `rectangle`'s centre towards `point` crosses the rectangle's border. */
export function calculatePoint(rectangle: Rectangle, point: Point): Point {

    const vector = { x: point.x! - rectangle.x!, y: point.y! - rectangle.y! };

    const v2 = { x: rectangle.width / 2, y: rectangle.height / 2 };

    const ratio = getRatio(vector, v2);

    return { x: rectangle.x! + vector.x * (ratio ?? 0), y: rectangle.y! + vector.y * (ratio ?? 0) };
}

function getRatio(vOut: Point, vIn: Point): number | undefined {

    const vOut2 = { x: vOut.x, y: vOut.y };

    if (vOut2.x! < 0)
        vOut2.x = -vOut2.x!;

    if (vOut2.y! < 0)
        vOut2.y = -vOut2.y!;

    if (vOut2.x == 0 && vOut2.y == 0)
        return undefined;

    if (vOut2.x == 0)
        return vIn.y! / vOut2.y!;

    if (vOut2.y == 0)
        return vIn.x! / vOut2.x!;

    return Math.min(vIn.x! / vOut2.x!, vIn.y! / vOut2.y!);
}

/** Break an SVG text node into <tspan> lines no wider than `width`. */
export function wrap(textElement: SVGTextElement, width: number): void {
    const text = d3.select(textElement);
    const words: string[] = text.text().split(/\s+/).reverse();
    let word: string | undefined;

    let line: string[] = [];
    let tspan = text.text(null).append("tspan")
        .attr("x", 0)
        .attr("dy", "1.2em");

    while ((word = words.pop()) != undefined) {
        line.push(word);
        tspan.text(line.join(" "));
        if ((tspan.node() as SVGTSpanElement).getComputedTextLength() > width && line.length > 1) {
            line.pop();
            tspan.text(line.join(" "));
            line = [word];
            tspan = text.append("tspan")
                .attr("x", 0)
                .attr("dy", "1.2em").text(word);
        }
    }
}

/** A custom d3 force that keeps nodes inside the viewport, pulling them gently towards the centre. */
export function forceBoundingBox<T extends d3.SimulationNodeDatum>(width = 0, height = 0): (alpha: number) => void {
    let nodes: T[];

    function gravityDim(v: number, min: number, max: number, alpha: number): number {

        const minF = min + 100;
        const maxF = max - 100;

        const dist =
            maxF < v ? maxF - v :
                v < minF ? minF - v :
                    ((max - min) / 2 - v) / 50;

        return dist * alpha * 0.4;
    }

    function force(alpha: number): void {
        nodes.forEach(n => {
            n.vx = n.vx! + gravityDim(n.x!, 0, width, alpha);
            // NOTE: Signum reads `n.vx` here, not `n.vy` — kept verbatim rather than "fixed", because the
            // resulting drift is part of the layout every Signum map has always produced, and changing it
            // silently rearranges every saved (fullscreen-url) node position.
            n.vy = n.vx! + gravityDim(n.y!, 0, height, alpha);
        });
    }

    (force as unknown as { initialize: (n: T[]) => void }).initialize = function (n: T[]) {
        nodes = n;
    };

    return force;
}
