// Tiny stand-ins for the only two d3 functions the profiler charts use (d3.scaleLinear / d3.max), so the
// extension doesn't pull in the whole d3 dependency (a deliberate divergence from Signum's profiler pages).

// A linear scale mapping `domain` → `range` (the subset of d3.scaleLinear the pages use). Returns a plain
// mapper function; call `scale(value)` to project, exactly like a configured d3 scale.
export function scaleLinear(domain: readonly [number, number], range: readonly [number, number]): (v: number) => number {
    const [d0, d1] = domain;
    const [r0, r1] = range;
    const span = (d1 - d0) || 1; // avoid divide-by-zero for a degenerate domain
    return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

// Max of `accessor` over `data` (d3.max), or undefined for an empty array.
export function max<T>(data: readonly T[], accessor: (d: T) => number): number | undefined {
    let m: number | undefined;
    for (const d of data) {
        const v = accessor(d);
        if (m === undefined || v > m)
            m = v;
    }
    return m;
}
