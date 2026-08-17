// The dashboard cross-filter type the chart renderers read. Signum.Dashboard IS now ported
// (@altea/altea-dashboard), so this module is a thin RE-EXPORT of the real thing — kept as a single import
// point (five chart modules referenced it while the dashboard was still missing).
//
// NOTE the altea shape difference vs. the placeholder that used to live here: `filter.rows[].filters[].token`
// is a real QueryToken (a CLASS), so its full key is `token.fullKey()` — a METHOD, not a property.
export type { DashboardFilter, DashboardFilterRow } from "@altea/altea-dashboard/client/View/DashboardFilterController";
