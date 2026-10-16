# Styling — Bootstrap / react-bootstrap / react-widgets → Tailwind + the `ui` kit

Signum's React client is styled with **Bootstrap 5.3**, its widgets are **react-bootstrap** (Modal, Tabs,
Dropdown, OverlayTrigger, …) and **react-widgets** (DropdownList, Combobox, Multiselect, DatePicker), and
Southwind's theme picker swaps whole Bootswatch builds in from a CDN. altea has none of the three. The
migration plan, phase by phase with what each one found, is [`../Tailwind-Plan.md`](../Tailwind-Plan.md); the
class-by-class table is [`../Tailwind-ClassMap.md`](../Tailwind-ClassMap.md). This page is the mapping a reader
of Signum's source needs.

## What replaced what

| Signum | altea | Notes |
| --- | --- | --- |
| Bootstrap utilities (`d-flex`, `me-2`, `text-muted`, `fw-bold`) | Tailwind v4 utilities (`flex`, `me-2`, `text-muted-foreground`, `font-bold`) | Spacing scale differs: Bootstrap `mb-3` (1rem) is Tailwind `mb-4` |
| Bootstrap components (`btn btn-primary`, `card`, `alert-danger`, `table`, `nav-link`, `form-control`, `input-group`) | semantic classes (`sf-btn sf-btn-primary`, `sf-card`, `sf-alert-danger`, `sf-table`, `sf-nav-link`, `sf-form-control`, `sf-input-group`) | Bootstrap's own rules, renamed and on altea's tokens (`client/ui/components.css`, `semantic.css`) |
| Bootstrap's grid (`row`, `col-sm-6`, `offset-sm-2`) | `sf-row` (a 12-column CSS grid) + `sm:col-span-6`, `sm:col-start-3` | Lays out identically (see below); `col` / `col-auto` rows are flex rows |
| Bootstrap's reboot | `client/ui/reboot.css` | Bootstrap's own, on the tokens; Tailwind's preflight is off |
| `--bs-*` CSS variables | theme tokens (`--background`, `--primary`, `--primary-subtle`, …) and per-component `--sf-<component>-*` knobs | |
| `data-bs-theme` | `data-theme` | |
| react-bootstrap `Modal` / `Tabs` / `Dropdown` / `DropdownButton` / `OverlayTrigger` / `Collapse` / `ProgressBar` / `Toast` | `ui/Modal` / `ui/Tabs` / `ui/Dropdown` / `DropdownButton` / `WithTooltip`, `Popover` / `Collapsible` / `Progress` / `Card` | Same prop shapes where cheap (`show` / `onHide` / `onExited`, `eventKey` / `title`) |
| react-bootstrap `Button variant` | `BootstrapButton` (core) or `ui/Button variant` | Both render `sf-btn sf-btn-<variant>` |
| react-widgets `DropdownList`, `Combobox`, `Multiselect` | `ui/Combobox`, `ui/MultiCombobox` (cmdk inside a popover) | |
| react-widgets `DatePicker` / `Calendar` | `ui/DateTimePicker` / `ui/Calendar` | Temporal in and out; no `date-fns`, no `Date` round-trip |
| react-widgets `Localization` | — | The pickers read altea's culture; `ReactWidgetsMessage` keeps its name so translations port |
| Radix primitives (shadcn's default until July 2026) | Base UI (`@base-ui/react`) | Behind the `ui` kit: packages never import it |
| Southwind's Bootswatch picker (a CDN stylesheet per palette) | altea `PaletteSelector` + the app's bundled `palettes.css` | `data-palette` on the root; a palette is a block of tokens per mode |

## Why semantic classes and not kit components for the component classes

The class map first sent Bootstrap's component classes to kit components (`<Button>`, `<Card>`, `<Alert>`). The
~780 call sites made that a hand conversion, and an application asked for something else anyway: to restyle
"the danger button" by an abstract name, not by the utilities a component happens to emit. So
`components.css` is Bootstrap 5.3.8's component CSS, generated:

- every class renamed (`.btn` → `.sf-btn`), Bootstrap's colour names kept (`sf-btn-danger`, `sf-alert-warning`);
- every component variable renamed (`--bs-btn-padding-x` → `--sf-btn-padding-x`) — a knob per component;
- every palette variable pointed at a token, and every LITERAL variant colour rewritten as the `color-mix()` of
  its token that reproduces it exactly: `#0b5ed7` (Bootstrap's hover primary) is
  `color-mix(in srgb, var(--primary) 85%, #000)`. In the default palette the result is Bootstrap's own pixels;
  under any other palette every hover, active and focus shade follows.

The kit's `Button` renders the same classes, so markup that hand-writes `sf-btn sf-btn-primary` and a
`<Button variant="primary">` share one set of rules. New code may use either.

## The grid is exact

`sf-row` is a CSS grid of twelve `minmax(0, 1fr)` tracks with the gutter (1.5rem) as `column-gap`. Bootstrap's
row is a flex row with half-gutter negative margins and half-gutter column padding. For a row W wide and a
gutter g, n columns are `n(W+g)/12 − g` wide and start at `m(W+g)/12` in BOTH — the two models are the same
layout, which is why the switch is pixel-identical. Where they differ: a column element that draws its own
border or background (in Bootstrap its box included the padding), and Bootstrap 3's relative offsets — the
dashboard places parts by `col-start` from the start column it stores.

## The cascade

Bootstrap's specificity games become layers (`legacy` < `theme` < `base` < `semantic` < `components` < `app` <
`utilities`). Two placements are deliberate and easy to get wrong:

- **The reboot is in `legacy`**, beside the library CSS, as Bootstrap's was: in `base` its
  `svg { vertical-align: middle }` would outrank Font Awesome's `.svg-inline--fa` and move every icon.
- **`semantic` is its own layer below `components`**: a package stylesheet that adjusts an `sf-*` class
  (Sidebar.css on `.sf-nav-link`) must win whatever the specificity, as it did while Bootstrap sat in `legacy`.

## For an application ported from Southwind

`altea-upgrade` runs `Upgrade_20261014_TailwindUtilities`, `Upgrade_20261015_TailwindFormClasses` and
`Upgrade_20261016_TailwindComponents`, and lists the hand work: columns that only work in a flex row, class
names built at runtime (`"btn-" + variant` → `"sf-btn-" + variant`, `"text-" + color` → `colorClass`), and
`--bs-*` variables left in the app's stylesheets. **Never re-run the utility rows on code that has already been
migrated**: `mb-4` is a Bootstrap class and a Tailwind class, and a second pass would turn Tailwind's `mb-4`
into `mb-6`. The component step runs only the semantic rows and the grid's.

Signum names the variables of its own Bootstrap build that vanilla 5.3 never had (`--bs-danger-subtle`,
`--bs-secondary-text`, `--bs-body-bg-subtle`, …; some are 5.3-alpha names). In altea they rendered as nothing;
the migration gave each the token it meant, except where one decided a whole surface (`--bs-body-bg-subtle`
behind the sidebar), which stays `transparent` — what it has always looked like.
