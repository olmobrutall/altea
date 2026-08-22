import "../../data/globals/stringExtensions";
import "../../data/globals/arrayExtensions";

// Port of Signum/React/Basics/Color.ts. altea divergence: the named-color table (`nameToHex`) is dropped —
// every caller so far parses hex or rgb(a) (chart palette colors, the case-flow gradient stops).
//
// It started in @altea/altea-chart (parse a palette color → its opposite-pole black/white for readable
// slice labels) and moved HERE, beside Signum's own location, once @altea/altea-workflow's case-flow
// renderer needed the same class plus `Gradient` to shade an activity by how long it took.

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export class Color {
  constructor(
    public r: number,
    public g: number,
    public b: number,
    public a?: number) {
  }

  toString(): string {
    if (this.a != undefined)
      return `rgba(${clamp(this.r)},${clamp(this.g)},${clamp(this.b)},${this.a.toString()})`;
    else
      return `rgb(${clamp(this.r)},${clamp(this.g)},${clamp(this.b)})`;
  }

  static White: Color = new Color(255, 255, 255);
  static Black: Color = new Color(0, 0, 0);

  opositePole(): Color {
    return (this.r + this.g + this.b) / 3 > (256 / 2) ? Color.Black : Color.White;
  }

  // Ported from Signum's Color.lerp — linear blend towards `target` by `ratio` (0..1). Used by the
  // PivotTable renderer to pick a readable text color against a gradient cell background.
  lerp(ratio: number, target: Color): Color {
    return new Color(
      this.r * (1 - ratio) + target.r * ratio,
      this.g * (1 - ratio) + target.g * ratio,
      this.b * (1 - ratio) + target.b * ratio,
      this.a == null ? target.a :
        target.a == null ? this.a :
          this.a * (1 - ratio) + target.a * ratio);
  }

  static parse(color: string): Color {
    var result = Color.tryParse(color);
    if (!result)
      throw new Error("Impossible to parse color " + color);

    return result;
  }

  static tryParse(color: string | undefined): Color | undefined {

    if (!color)
      return undefined;

    let c = color;

    if (c.startsWith("rgba")) {
      c = c.after("rgba(").before(")");
      var parts = c.split(",");
      return new Color(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]), parseInt(parts[3]));
    }
    else if (c.startsWith("rgb")) {
      c = c.after("rgb(").before(")");
      var parts = c.split(",");
      return new Color(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]));
    }
    else if (c.startsWith('#')) {
      c = c.substring(1);

      switch (c.length) {
        case 3: return new Color(
          parseInt(c.slice(0, 1), 16) * 16,
          parseInt(c.slice(1, 2), 16) * 16,
          parseInt(c.slice(2, 3), 16) * 16
        );

        case 6: return new Color(
          parseInt(c.slice(0, 2), 16),
          parseInt(c.slice(2, 4), 16),
          parseInt(c.slice(4, 6), 16)
        );

        case 8: return new Color(
          parseInt(c.slice(0, 2), 16),
          parseInt(c.slice(2, 4), 16),
          parseInt(c.slice(4, 6), 16),
          parseInt(c.slice(6, 8), 16)
        );

        default:
          return undefined;
      }
    }
    else
      return undefined;
  }
}

/**
 * Port of Signum's `Gradient` — a piecewise-linear color scale over stops. `getColor(value)` interpolates
 * between the surrounding stops and clamps outside the range.
 */
export class Gradient {
    constructor(public list: { value: number; color: Color }[]) {
    }

    getColor(value: number): Color {
        const prev = this.list.filter(a => a.value <= value).maxBy(a => a.value);
        const next = this.list.filter(a => a.value > value).minBy(a => a.value);

        if (prev == undefined)
            return next!.color;

        if (next == undefined)
            return prev.color;

        return prev.color.lerp((value - prev.value) / (next.value - prev.value), next.color);
    }

    cache: { [num: number]: Color } = {};
    getCachedColor(value: number): Color {
        return this.cache[value] || (this.cache[value] = this.getColor(value));
    }
}
