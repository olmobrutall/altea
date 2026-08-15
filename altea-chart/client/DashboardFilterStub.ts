// Placeholder for Signum.Dashboard's DashboardFilter (Signum.Dashboard is not ported yet). Charts render
// without dashboard cross-filtering for now; this minimal shape is exactly what getActiveDetector + the
// renderers read (filter.rows[].filters[].token.fullKey / .value), so the full Dashboard port can replace
// it without touching chart code.
export interface DashboardFilterRowFilter {
    token: { fullKey: string };
    value: unknown;
}

export interface DashboardFilterRow {
    filters: DashboardFilterRowFilter[];
}

export interface DashboardFilter {
    rows: DashboardFilterRow[];
}
