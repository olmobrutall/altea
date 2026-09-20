import * as React from "react";
import { parseChartTitle } from "./ChartTitle";
import type { ChartTitleParts } from "./ChartTitle";
import "./ChartTooltip.css";

// NOT in Signum, which leaves every chart on the browser's own `<title>` tooltip: plain, slow to appear,
// unstyleable, and clipped to the OS. This is a React card in the shadcn chart-tooltip idiom — an identity
// line, then a colour swatch + label + right-aligned value per measure — that GLIDES to the hovered point
// instead of blinking from one to the next.
//
// It is one component per chart, not one per shape, and it finds what is hovered by DELEGATION: a script
// marks a shape by putting a <desc> inside it (see ShapeTitle), so nothing has to be wired up per chart and
// a shape added later is picked up for free. The tooltip is `pointer-events: none`, so it can never steal
// the hover from the shape underneath it or from the shape's own click-to-drill-down.
//
// The canvas renderer (Scatterplot's non-SVG drawing mode) has no per-shape elements to delegate to, so it
// instead writes the same three facts onto the canvas itself as `data-chart-tooltip` / `-x` / `-y`, which
// the pointer handler below reads in preference to a <desc>.

/** How long the card glides for. Also the CSS transition duration — keep the two in step. */
const glideMs = 160;

/** Breathing room between the card and the chart's edge, and between the card and its point. */
const margin = 4;
const gap = 10;

interface HoverState {
  parts: ChartTitleParts;
  /** The shape's own colour, for the swatch. */
  color: string | undefined;
  /** The shape's centre, in the container's coordinates. */
  x: number;
  y: number;
}

export function ChartTooltip(p: { containerRef: React.RefObject<HTMLElement | null> }): React.ReactElement | null {

  const [hover, setHover] = React.useState<HoverState | null>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  // Whether the card is ALREADY on screen decides whether it glides or simply appears: gliding in from
  // wherever it was last time — possibly the other side of the chart, possibly 0,0 — is not an animation
  // anybody asked for. `wasVisible` is a ref, not state, because it must not itself cause a render.
  const wasVisible = React.useRef(false);
  const hideHandle = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    const container = p.containerRef.current;
    if (container == null)
      return;

    function shapeOf(target: EventTarget | null): Element | null {
      let el = target instanceof Element ? target : null;
      while (el != null && el != container) {
        // A <desc> put there by ShapeTitle is what makes an element a tooltip-bearing shape.
        if (el.querySelector(":scope > desc") != null)
          return el;
        el = el.parentElement;
      }
      return null;
    }

    function handleMove(e: PointerEvent): void {
      const container = p.containerRef.current;
      if (container == null)
        return;

      const box = container.getBoundingClientRect();

      // The canvas renderer's own channel (see the header) — it knows which point is under the cursor and
      // we cannot ask the DOM.
      const canvas = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-chart-tooltip]") : null;
      if (canvas != null) {
        const cb = canvas.getBoundingClientRect();
        show({
          parts: parseChartTitle(canvas.dataset.chartTooltip!),
          color: canvas.dataset.chartTooltipColor,
          x: cb.left - box.left + Number(canvas.dataset.chartTooltipX ?? 0),
          y: cb.top - box.top + Number(canvas.dataset.chartTooltipY ?? 0),
        });
        return;
      }

      const shape = shapeOf(e.target);
      if (shape == null) {
        hide();
        return;
      }

      const text = shape.querySelector(":scope > desc")!.textContent ?? "";
      const sb = shape.getBoundingClientRect();

      show({
        parts: parseChartTitle(text),
        color: shapeColor(shape),
        x: sb.left - box.left + sb.width / 2,
        y: sb.top - box.top + sb.height / 2,
      });
    }

    function show(next: HoverState): void {
      window.clearTimeout(hideHandle.current);
      setHover(prev => same(prev, next) ? prev : next);
    }

    function hide(): void {
      // A tick of grace, so crossing the gap BETWEEN two shapes does not blink the card out and back in —
      // which is the whole point of having it glide.
      window.clearTimeout(hideHandle.current);
      hideHandle.current = window.setTimeout(() => setHover(null), glideMs);
    }

    container.addEventListener("pointermove", handleMove);
    container.addEventListener("pointerleave", hide);
    return () => {
      window.clearTimeout(hideHandle.current);
      container.removeEventListener("pointermove", handleMove);
      container.removeEventListener("pointerleave", hide);
    };
  }, [p.containerRef]);

  // Keep the card inside the chart: it is anchored above the point and centred on it, so near an edge it
  // has to slide sideways, and near the top it has to flip below. Measured AFTER layout (the card's size
  // depends on its text), which is what useLayoutEffect is for — a frame of the card hanging outside the
  // chart would be visible.
  const [offset, setOffset] = React.useState({ dx: 0, flip: false });
  React.useLayoutEffect(() => {
    const container = p.containerRef.current;
    const card = cardRef.current;
    if (hover == null || container == null || card == null) {
      wasVisible.current = false;
      return;
    }

    const cw = container.clientWidth;
    const half = card.offsetWidth / 2;
    const left = hover.x - half;
    const right = hover.x + half;

    const dx = left < margin ? margin - left : right > cw - margin ? cw - margin - right : 0;
    const flip = hover.y - card.offsetHeight - gap < margin;

    setOffset(prev => prev.dx == dx && prev.flip == flip ? prev : { dx, flip });

    // From the SECOND frame on the card is on screen, so the next move glides instead of jumping.
    const h = window.requestAnimationFrame(() => { wasVisible.current = true; });
    return () => window.cancelAnimationFrame(h);
  }, [hover, p.containerRef]);

  if (hover == null)
    return null;

  return (
    // The clipping layer is not decoration: .sf-chart-container is `overflow: auto`, and a transformed
    // absolute child still counts towards its SCROLLABLE overflow — so without this the card gave every
    // small chart (a dashboard cell) a scrollbar it never used to have.
    <div className="sf-chart-tooltip-layer">
      <div className="sf-chart-tooltip-anchor"
        style={{
          transform: `translate3d(${hover.x + offset.dx}px, ${hover.y}px, 0)`,
          transition: wasVisible.current ? `transform ${glideMs}ms cubic-bezier(.16, 1, .3, 1)` : "none",
        }}>
        <div ref={cardRef} className={"sf-chart-tooltip" + (offset.flip ? " below" : "")} role="tooltip">
          {hover.parts.head && <div className="sf-chart-tooltip-head">{hover.parts.head}</div>}
          {hover.parts.rows.length > 0 &&
            <div className="sf-chart-tooltip-rows">
              {hover.parts.rows.map((r, i) =>
                <div className="sf-chart-tooltip-row" key={i}>
                  {hover.color && <span className="sf-chart-tooltip-swatch" style={{ background: hover.color }} />}
                  <span className="sf-chart-tooltip-label">{r.label}</span>
                  <span className="sf-chart-tooltip-value">{r.value}</span>
                </div>)}
            </div>}
        </div>
      </div>
    </div>
  );
}

/**
 * The colour of the swatch: the hovered shape's OWN colour, so the card reads as belonging to the thing it
 * describes. Undefined when the shape does not have one — the card then simply omits the swatch rather
 * than inventing a colour.
 *
 * Neither of the two checks below is optional:
 *  - the ATTRIBUTE, not the computed value, decides whether a colour was asked for at all. An SVG element
 *    with no `fill` COMPUTES to black, indistinguishable from a deliberate black — and the shape carrying
 *    the <desc> is often a bare `<g>` (BubblePack, Bubbleplot), which would make every swatch flat black;
 *  - a fully transparent paint says nothing. Line's hover target is a `fill="#fff" fill-opacity="0"`
 *    circle, invisible on purpose and much larger than the dot it stands for.
 *
 * `fill` before `stroke`, because a filled shape is the common case and a stroked one (a line's path) is
 * the exception. A script that knows better than any of this can say so with `data-chart-tooltip-color`.
 */
function shapeColor(shape: Element): string | undefined {

  const declared = shape.getAttribute("data-chart-tooltip-color");
  if (declared)
    return declared;

  for (const el of [shape, ...shape.querySelectorAll("*")]) {
    const s = getComputedStyle(el);
    if (s.opacity == "0")
      continue;
    if (el.getAttribute("fill") != null && s.fill != "none" && s.fillOpacity != "0")
      return s.fill;
    if (el.getAttribute("stroke") != null && s.stroke != "none" && s.strokeOpacity != "0")
      return s.stroke;
  }

  return undefined;
}

function same(a: HoverState | null, b: HoverState): boolean {
  return a != null && a.x == b.x && a.y == b.y && a.color == b.color
    && a.parts.head == b.parts.head
    && a.parts.rows.length == b.parts.rows.length
    && a.parts.rows.every((r, i) => r.label == b.parts.rows[i].label && r.value == b.parts.rows[i].value);
}
