import * as React from "react";
import type { EpochProgressRow } from "../../data/Predictor";

// Port of Signum.MachineLearning's Templates/LineChart.tsx — the training curve.
//
// It is the one view that earns its place rather than showing fields: the SHAPE of these two curves is
// how anyone judges a training run. A training loss still falling means "keep going"; a training loss
// falling while the VALIDATION loss rises is overfitting, and no summary metric on the predictor shows
// that — only the divergence does. Which is why both are drawn on one axis, in the light/dark pairs the
// grid formatters use.
//
// altea divergence: Signum draws it with d3 (which altea-chart also depends on). This is a hand-written
// inline SVG instead — a fixed two-series line chart over at most a few hundred points needs no scale
// abstraction, and it keeps this module off a charting dependency it would otherwise pull in for one view.

interface Series {
    label: string;
    color: string;
    /** null where the epoch recorded no value (validation is only recorded every N epochs). */
    values: (number | null)[];
}

export function LossChart(p: { rows: EpochProgressRow[]; height?: number }): React.JSX.Element {
    const height = p.height ?? 220;
    const width = 640;
    const pad = { top: 12, right: 12, bottom: 28, left: 48 };

    if (p.rows.length === 0)
        return <div className="text-muted small">No epochs recorded yet.</div>;

    const epochs = p.rows.map(r => r[2]);
    const series: Series[] = [
        { label: "Loss (training)", color: "#1A5276", values: p.rows.map(r => r[3]) },
        { label: "Loss (validation)", color: "#7B241C", values: p.rows.map(r => r[5]) },
        { label: "Accuracy (training)", color: "#5DADE2", values: p.rows.map(r => r[4]) },
        { label: "Accuracy (validation)", color: "#D98880", values: p.rows.map(r => r[6]) },
    ].filter(s => s.values.some(v => v != null));

    const all = series.flatMap(s => s.values).filter((v): v is number => v != null);
    const maxY = Math.max(...all, 0);
    const minY = Math.min(...all, 0);
    const maxX = Math.max(...epochs, 1);
    const minX = Math.min(...epochs, 0);

    const x = (epoch: number): number =>
        pad.left + (maxX === minX ? 0 : (epoch - minX) / (maxX - minX)) * (width - pad.left - pad.right);
    const y = (value: number): number =>
        height - pad.bottom - (maxY === minY ? 0 : (value - minY) / (maxY - minY)) * (height - pad.top - pad.bottom);

    // A gap where a series has no value: the validation figures are recorded every
    // `saveValidationProgressEvery` epochs, so joining across the gaps would draw a line through points
    // that were never measured.
    const paths = series.map(s => {
        const segments: string[] = [];
        let open = false;
        s.values.forEach((v, i) => {
            if (v == null) { open = false; return; }
            segments.push(`${open ? "L" : "M"}${x(epochs[i]!).toFixed(1)},${y(v).toFixed(1)}`);
            open = true;
        });
        return { ...s, d: segments.join(" ") };
    });

    return (
        <div>
            <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}
                role="img" aria-label="Training progress">
                {/* The axes, and a zero line when the range crosses it. */}
                <line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} stroke="#ccc" />
                <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="#ccc" />

                {[minY, (minY + maxY) / 2, maxY].map((v, i) => (
                    <g key={i}>
                        <line x1={pad.left - 4} y1={y(v)} x2={pad.left} y2={y(v)} stroke="#ccc" />
                        <text x={pad.left - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#666">
                            {v.toFixed(3)}
                        </text>
                    </g>
                ))}

                <text x={(width) / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="#666">Epoch</text>
                <text x={x(minX)} y={height - pad.bottom + 14} textAnchor="middle" fontSize="10" fill="#666">{minX}</text>
                <text x={x(maxX)} y={height - pad.bottom + 14} textAnchor="middle" fontSize="10" fill="#666">{maxX}</text>

                {paths.map(s => (
                    <path key={s.label} d={s.d} fill="none" stroke={s.color} strokeWidth={1.5} />
                ))}
            </svg>

            <div className="d-flex flex-wrap gap-3 small">
                {series.map(s => (
                    <span key={s.label}>
                        <span style={{
                            display: "inline-block", width: 10, height: 10,
                            backgroundColor: s.color, marginRight: 4,
                        }} />
                        {s.label}
                    </span>
                ))}
            </div>
        </div>
    );
}

export default LossChart;
