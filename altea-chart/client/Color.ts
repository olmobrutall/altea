import "@altea/altea/data/globals/stringExtensions";

// Minimal port of Signum/React/Basics/Color.ts — only what the Pie renderer needs (parse a palette color →
// its opposite-pole black/white for readable slice-label text). altea divergence: the named-color table
// (nameToHex) and Gradient/lerp are dropped — chart palette colors are always hex or rgb(a).

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
