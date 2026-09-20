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
// marks a shape with `data-chart-title` (see ChartTitle's shapeTitle), so nothing has to be wired up per
// chart and a shape added later is picked up for free. The card is `pointer-events: none`, so it can never
// steal the hover from the shape underneath it, nor the shape's own click-to-drill-down.
//
// Keyboard and screen readers ride on the same attributes: every script makes its shapes focusable,
// `aria-label` (written beside `data-chart-title`) is what a reader announces on focus, and the handlers
// below open the card on focus as well as on hover, so a keyboard user sees what a mouse user sees.
//
// The canvas renderer (Scatterplot's non-SVG drawing mode) has no per-shape element to delegate to, so it
// writes the same facts onto the canvas itself as `data-chart-tooltip` / `-x` / `-y` / `-color`, which the
// pointer handler reads in preference to a shape.

/** How long the card takes to glide, and to fade out. Keep both in step with ChartTooltip.css. */
const glideMs = 260;
const fadeMs = 200;

/** Clearance from the chart's edge, and from the SHAPE the card describes. */
const margin = 4;
const gap = 12;

interface HoverState {
  parts: ChartTitleParts;
  /** The shape's own colour, for the swatch. */
  color: string | undefined;
  /** Where the card goes, in the container's coordinates: centred on `x`, clear of `top`…`bottom`. */
  x: number;
  top: number;
  bottom: number;
}

export function ChartTooltip(p: { containerRef: React.RefObject<HTMLElement | null> }): React.ReactElement | null {

  const [hover, setHover] = React.useState<HoverState | null>(null);
  // Fading out rather than vanishing: the card stays mounted at opacity 0 for one fade, so moving back
  // onto a shape catches it on the way out instead of starting it over.
  const [leaving, setLeaving] = React.useState(false);
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  // Whether the card is ALREADY on screen decides whether it glides or simply appears: gliding in from
  // wherever it was last time — possibly the other side of the chart, possibly 0,0 — is not an animation
  // anybody asked for. A ref, not state, because it must not itself cause a render.
  const wasVisible = React.useRef(false);
  const leaveHandle = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    const container = p.containerRef.current;
    if (container == null)
      return;

    function show(next: HoverState): void {
      window.clearTimeout(leaveHandle.current);
      setLeaving(false);
      setHover(prev => same(prev, next) ? prev : next);
    }

    function hide(): void {
      window.clearTimeout(leaveHandle.current);
      setLeaving(true);
      leaveHandle.current = window.setTimeout(() => { setHover(null); setLeaving(false); }, fadeMs);
    }

    /** What the card should show for this shape, in the container's coordinates. */
    function stateFor(shape: Element, container: HTMLElement): HoverState {
      const box = container.getBoundingClientRect();
      const sb = shape.getBoundingClientRect();
      return {
        parts: parseChartTitle(shape.getAttribute("data-chart-title") ?? ""),
        color: shapeColor(shape),
        x: sb.left - box.left + sb.width / 2,
        top: sb.top - box.top,
        bottom: sb.bottom - box.top,
      };
    }

    function handleMove(e: PointerEvent): void {
      const container = p.containerRef.current;
      if (container == null)
        return;

      // The canvas renderer's own channel (see the header) — it knows which point is under the cursor and
      // the DOM cannot be asked. Its point has no box, so the point itself stands in for one.
      const canvas = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-chart-tooltip]") : null;
      if (canvas != null) {
        const box = container.getBoundingClientRect();
        const cb = canvas.getBoundingClientRect();
        const x = cb.left - box.left + Number(canvas.dataset.chartTooltipX ?? 0);
        const y = cb.top - box.top + Number(canvas.dataset.chartTooltipY ?? 0);
        show({
          parts: parseChartTitle(canvas.dataset.chartTooltip!),
          color: canvas.dataset.chartTooltipColor,
          x, top: y, bottom: y,
        });
        return;
      }

      const shape = e.target instanceof Element ? e.target.closest("[data-chart-title]") : null;
      if (shape == null)
        hide();
      else
        show(stateFor(shape, container));
    }

    function handleFocus(e: FocusEvent): void {
      const container = p.containerRef.current;
      const shape = e.target instanceof Element ? e.target.closest("[data-chart-title]") : null;
      if (container == null || shape == null)
        return;
      show(stateFor(shape, container));
    }

    function handleKey(e: KeyboardEvent): void {
      if (e.key == "Escape")
        hide();
    }

    container.addEventListener("pointermove", handleMove);
    container.addEventListener("pointerleave", hide);
    container.addEventListener("focusin", handleFocus);
    container.addEventListener("focusout", hide);
    container.addEventListener("keydown", handleKey);
    return () => {
      window.clearTimeout(leaveHandle.current);
      container.removeEventListener("pointermove", handleMove);
      container.removeEventListener("pointerleave", hide);
      container.removeEventListener("focusin", handleFocus);
      container.removeEventListener("focusout", hide);
      container.removeEventListener("keydown", handleKey);
    };
  }, [p.containerRef]);

  // Where the card lands. It clears the shape's own BOX, not its centre: on a bar or a treemap tile the
  // centre is a long way inside the shape, which is what used to park the card under the cursor. Near an
  // edge it slides sideways, near the top it flips below. Measured after layout (the size depends on the
  // text), which is what useLayoutEffect is for — a frame of the card hanging outside the chart would show.
  const [place, setPlace] = React.useState({ dx: 0, y: 0, below: false });
  React.useLayoutEffect(() => {
    const container = p.containerRef.current;
    const card = cardRef.current;
    if (hover == null || container == null || card == null) {
      wasVisible.current = false;
      return;
    }

    const cw = container.clientWidth;
    const half = card.offsetWidth / 2;
    const dx = hover.x - half < margin ? margin - (hover.x - half) :
      hover.x + half > cw - margin ? cw - margin - (hover.x + half) : 0;

    const below = hover.top - gap - card.offsetHeight < margin;
    const y = below ? hover.bottom + gap : hover.top - gap;

    setPlace(prev => prev.dx == dx && prev.y == y && prev.below == below ? prev : { dx, y, below });

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
          transform: `translate3d(${hover.x + place.dx}px, ${place.y}px, 0)`,
          transition: wasVisible.current ? `transform ${glideMs}ms cubic-bezier(.2, .8, .2, 1)` : "none",
        }}>
        <div ref={cardRef} role="tooltip"
          className={"sf-chart-tooltip" + (place.below ? " below" : "") + (leaving ? " leaving" : "")}>
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
 *    the tooltip is often a bare `<g>` (BubblePack, Bubbleplot), which would make every swatch flat black;
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
  return a != null && a.x == b.x && a.top == b.top && a.bottom == b.bottom && a.color == b.color
    && a.parts.head == b.parts.head
    && a.parts.rows.length == b.parts.rows.length
    && a.parts.rows.every((r, i) => r.label == b.parts.rows[i].label && r.value == b.parts.rows[i].value);
}
