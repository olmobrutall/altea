# Bootstrap → Tailwind + shadcn/ui

Replace **bootstrap**, **react-bootstrap** and **react-widgets-up** with **Tailwind CSS v4** and
**shadcn/ui** (Base UI primitives) across altea and eastwind. Branch `tailwind` in both repos.

The class-by-class translation every package (and every application ported from Signum) follows is
**[`Tailwind-ClassMap.md`](Tailwind-ClassMap.md)**. It is also the input of the Phase 5 codemod.

## Where we start (measured 2026-10-14)

| | |
| --- | --- |
| react-bootstrap | **110 files** in 28 packages (32 in core `altea/`, 12 `altea-dynamic`, 9 `altea-workflow`, 7 `altea-auth`, …, 2 eastwind) |
| components used | `Modal` 27, `Tabs`/`Tab` 27, `Dropdown` 27, `Button` 16, `OverlayTrigger`+`Tooltip`/`Popover` 14, `DropdownButton` 10, `NavDropdown` 5, `ProgressBar` 4, `Overlay` 3, `Collapse` 3, `Toast` 2, `Nav` 2, `ButtonGroup` 2, `Spinner`, `FormCheck` |
| react-widgets-up | **15 files**: `DropdownList`, `Combobox`, `Multiselect`, `DatePicker`, `Calendar`, `Localization` + `IntlLocalizer` (core Lines, `QueryTokenBuilder`, `MultiPropertySetter`, `ChartTimeSeries`, 3 Playwright proxies) |
| Bootstrap classes in JSX | 432 files with `className`; most common `btn*`, `row`/`col-sm-*`, `d-flex`, spacing, `text-muted`/`text-danger`, `alert-*`, `form-control`/`form-select`/`form-check`, `card*`, `input-group*`, `modal-*`, `table-sm` |
| Class chokepoint | `StyleContext` (`TypeContext.ts`) hands out `formGroupClass`, `formControlClass`, `formSelectClass`, `inputGroupClass`, `colFormLabelClass`, `buttonClass`, `rwWidgetClass` per `formSize` — most Line markup gets its classes from there, not from literals |
| CSS | ~5 100 lines in ~45 `.css` files; **40** reference `var(--bs-*)`. Biggest: `Lines.css` 852, `Sidebar.css` 538, `Search.css` 474 |
| Bootstrap-shaped PUBLIC API | `BsColumns` / `labelColumns` / `valueColumns` on `StyleOptions` (48 files outside core), `BsSize` on modals/Finder/Navigator, `variant="…"` on buttons |
| Theming | `data-bs-theme` on `<html>` (`ThemeModeSelector`), Monaco observes it; eastwind's Bootswatch picker loads full Bootstrap builds from a CDN |
| Tests | Playwright proxies select `.modal` (31), `.dropdown-menu`, `.nav-tabs`/`.nav-link`, `.form-control`, `.rw-popup-container`, `.rw-dropdown-list-value` |

## Decisions

| | Decision |
| --- | --- |
| Palette picker | Bundled **token palettes** (no CDN). A palette is ~40 CSS variables per mode; a handful of them is a few KB. |
| Calendar | **Our own, on Temporal** — no `react-day-picker`, no `date-fns`. |
| Notify / Toast | `Notify` is altea's own status banner (Loading… / saved / error, ~27 callers through `Notify.singleton`) — **kept**, restyled as `sf-notify`. react-bootstrap `Toast` is used only in `AlertDropdown`, as list cards, not toasts → `Card`. No toast library. |
| Spacing direction | **Logical** (`ms-*` / `me-*` / `ps-*` / `pe-*`, `text-start`/`end`, `float-start`/`end`) — Tailwind v4 has them, RTL keeps working. |
| Breakpoints | Tailwind's are **overridden to Bootstrap's** (`sm` 576, `md` 768, `lg` 992, `xl` 1200, `2xl` 1400), so no layout shifts while classes are translated. |
| Framework restyling | **Semantic `sf-*` classes** for everything an application may want to restyle (see below). |

## Target stack

| Piece | Choice | Licence |
| --- | --- | --- |
| CSS | `tailwindcss` v4 + `@tailwindcss/vite` (CSS-first config, no `tailwind.config.js`) | MIT |
| Components | shadcn/ui, **copied in** (not a dependency) to `altea/altea/client/ui/` | MIT |
| Primitives | `@base-ui/react` (Dialog, Menu, Tabs, Tooltip, Popover, Select, Collapsible, Checkbox, Switch, Radio, Progress) — shadcn's default since July 2026; Radix until 2026-10-15 | MIT |
| Helpers | `class-variance-authority`, `clsx`, `tailwind-merge` → one `cn()` | MIT |
| Combobox / multiselect | `cmdk` (shadcn `Command`) inside `Popover` | MIT |
| Calendar / date-time | altea's own, Temporal + `Intl` | — |
| Icons | **keep Font Awesome** | — |

All MIT; nothing GPL/AGPL. shadcn code becomes ours once copied, so it gets the same security and licence
review as any generated code.

## Principles

1. **altea owns the wrappers; packages never import Base UI or shadcn files directly.** Every module
   imports from `@altea/altea/client/ui/<Component>`. One place for a primitive to change; the 28 packages take no
   new dependency.
2. **Keep the react-bootstrap SHAPE where it is cheap.** altea's `Modal` (`show` / `onHide` /
   `onExited` / `size` / `Modal.Header` / `Body` / `Footer`) and `Tabs` + `Tab eventKey title` keep the
   props 27 files each already use — most of those become an import swap.
3. **Replace Bootstrap-named API with neutral names.** `BsSize` → `ModalSize`, `BsColumns` →
   `LabelLayout` (`{ sm?: 1..12, md?: …, lg?: … }`, same shape, neutral name). Deprecated aliases for one
   cycle + an `altea-upgrade` step to rewrite them.
4. **The framework is restyled through semantic classes and tokens, not by forking components.**
   - Every framework region an application may want to restyle carries an `sf-*` class: the frame
     (`sf-frame`, `sf-entity-title`, `sf-button-bar`), Lines (`sf-form-group`, `sf-form-control`,
     `sf-line-button`, `sf-entity-line`, `sf-repeater-element`, …), the search control (`sf-search-control`,
     `sf-table`, `sf-filter-builder`), the shell (`sf-navbar`, `sf-sidebar`, `sf-toolbar-*`), notify,
     modals. Many exist already (they are also the Playwright hooks); the class map adds the ones that
     replace Bootstrap's component classes (`form-group`, `form-control`, `input-group`, `table`, `btn-toolbar`, …).
   - They are defined in CSS with `@apply` (or plain declarations where `@apply` would be longer),
     **inside `@layer components`**. An application's own stylesheet is UNLAYERED, so any app rule beats
     any framework rule regardless of specificity — no `!important`, no selector wars.
   - Region-level knobs are CSS variables (`--sf-sidebar-bg`, `--sf-sidebar-width`, `--sf-frame-bg`,
     `--sf-navbar-bg`, `--sf-gutter`, …) on top of the shadcn token set, so a palette or an app can retune a
     region without touching selectors.
   - Ad-hoc layout in a view (`d-flex me-2`) becomes inline utilities (`flex me-2`); it is not a theming
     surface.
   - Package CSS files that use `@apply` start with `@reference "@altea/altea/client/ui/theme.css";`.
5. **One theming switch.** `data-theme="light|dark"` and `data-palette="<name>"` on `<html>`, a Tailwind
   `@custom-variant dark`. Colours are the shadcn token set (`--background`, `--foreground`, `--primary`,
   `--secondary`, `--muted`, `--accent`, `--border`, `--input`, `--ring`, `--destructive`) plus altea's
   `--success`, `--warning`, `--info`, `--tertiary`, each with its `-foreground`.

## Coexistence while migrating

Bootstrap and Tailwind live side by side until Phase 5 — a big bang over 450 files is not reviewable.

- Every stylesheet not written for Tailwind — Bootstrap, react-widgets, Font Awesome, altea's own CSS
  until it is migrated — is wrapped by the build (`alteaLegacyCssLayer` in `@altea/altea/vite.mjs`) into a
  `legacy` cascade layer declared first: `@layer legacy, theme, base, components, utilities;`. A Tailwind
  utility or an `sf-*` component rule then wins whatever the specificity, while the legacy sheets keep
  their old order and specificity among themselves.
- **Bootstrap's utilities lose `!important`** inside that layer. An important declaration in an EARLIER
  layer beats every later one, so `.mb-4 { margin-bottom: 1.5rem !important }` would override Tailwind's
  `mb-4` (1rem).
- **A class name can only mean one thing**, and `mb-3`, `p-4`, `gap-3`, `shadow`, `rounded` … mean
  different sizes in the two systems. So the utility half of the class map is applied in Phase 0, not
  Phase 5: once every `mb-3` in the source has become `mb-4`, Tailwind owns the utility names and the
  `ui` kit can use them freely.
- Font Awesome injects its stylesheet at runtime, outside every layer, where it beat altea's icon rules;
  `@altea/altea/client/ui/fontAwesome` turns that off and imports the stylesheet through the build.
- A UTF-8 BOM at the start of a stylesheet becomes part of the first selector once wrapped; the plugin
  strips it.
- Tailwind **preflight is off** until Bootstrap is removed (reboot already normalises; two resets fight).
  When preflight comes on, altea's `@layer base` restores what it strips that views rely on: `h1`–`h6`
  sizes, `small`, `hr`, list bullets inside `sf-markdown`/HTML content, link colour.
- **Component-class collisions** — Tailwind generates a class for every candidate string in the source,
  so the Bootstrap COMPONENT classes that are also Tailwind utilities (`collapse` → `visibility: collapse`,
  `container`, `table`) are excluded with `@source not inline(...)` until the files using them are migrated.
- `--bs-*` variables are re-pointed at the shadcn tokens in the bridge stylesheet, so migrated and
  unmigrated parts share one palette and one dark mode from Phase 0 on.
- Dynamically built class names (`StyleContext` label/value columns) are made visible to the scanner with
  `@source inline("{,sm:,md:,lg:,xl:}col-span-{1..12}")`.

No `tw:` prefix: the end state has no Bootstrap, and a prefix would mean a second rewrite of every class.

## Phases

Each phase builds (`tspc -b`), runs the Playwright suite against `stack local`, and gets a browser pass in
light and dark before the next starts. Each is its own commit(s) in `altea`, with a bump in eastwind.

### Phase 0 — Plumbing and the utility sweep ✅
- Add `tailwindcss`, `@tailwindcss/vite`, `radix-ui`, `class-variance-authority`, `clsx`,
  `tailwind-merge`, `cmdk` to `@altea/altea`; `@tailwindcss/vite` in `eastwind/vite.client.config.ts`.
- `altea/altea/client/ui/theme.css`: layer order, token set (light + dark), `@custom-variant dark`,
  breakpoints, the `--bs-*` bridge, the Bootstrap layer, collision blocklist, `@source` globs over every
  `altea-*/client` and the app. `client/ui/semantic.css`: the `sf-*` component layer (filled per phase).
- `components.json` so `shadcn add` writes into `altea/altea/client/ui/`; `cn()` in `client/ui/utils.ts`.
- `data-bs-theme` → `data-theme` (ThemeModeSelector, Layout, Monaco observer), still stamping
  `data-bs-theme` until Phase 5.
- The utility sweep: `altea-upgrade/tailwind` (`ClassMap` reads Tailwind-ClassMap.md, `ClassSweep`
  rewrites class contexts with the TypeScript parser) applied the U / X rows outside *Layout and grid* to
  every altea package and eastwind: 1 436 classes in 180 files. Applications get the same through
  `Upgrade_20261014_TailwindUtilities`.
- Exit (met): eight pages × light/dark screenshot-diffed against the Bootstrap baseline — pixel-identical
  except the animated help-tip pulse.

### Phase 1 — altea `ui` kit ✅
Generate and adapt, in `client/ui/`: `Button` (+ `buttonVariants` for `<a>`/`<Link>` that look like
buttons; variants primary, secondary, tertiary, outline, link, destructive, success, warning, info, light;
sizes xs/sm/md/lg/icon — `xs` is altea's), `Modal` (Dialog), `Dropdown`/`DropdownButton`
(DropdownMenu), `Tabs`/`Tab`, `Tooltip` (+ an `OverlayTrigger`-shaped `WithTooltip`), `Popover`,
`Collapsible`, `Progress`, `Spinner`, `Badge`, `Alert`, `Card`, `Input`, `Textarea`, `Select`, `Checkbox`,
`Switch`, `InputGroup`, `Table`, `Command`, `Combobox`, `MultiCombobox`, `Skeleton`.

The ones that need real design:
- **`Modal`** keeps altea's promise-based `openModal` contract: `onExited` fires AFTER the close
  animation (Radix has none → `onAnimationEnd` on the content once `data-state=closed`). Stacked modals
  (FrameModal over SearchModal over FrameModal) need correct focus trapping and z-order — verified against
  the real Frame stack before anything else moves.
- **`Tabs`** keeps the mount-on-enter / unmount-on-exit semantics entity views rely on.
- **`Calendar`** (Temporal, ours):
  - month grid from `Temporal.PlainDate` (`with({ day: 1 })`, `dayOfWeek`, `daysInMonth`); first day of
    week from `Intl.Locale#getWeekInfo()` with a per-culture fallback; day / month names from
    `Intl.DateTimeFormat` in the current culture.
  - views month → year → decade (react-widgets' century view is dropped unless a caller needs it).
  - `min` / `max`, `value`, `onChange`, and a `renderDay(date) → { className?, title?, content? }` hook,
    which is what `DateTimeRange` and `ChartTimeSeries` use today (today / weekend / holiday / range
    start / between / end).
  - WAI-ARIA grid: roving tabindex, arrows, PageUp/PageDown (month), Shift+PageUp/Down (year),
    Home/End, Enter/Space; labelled by the visible month heading.
  - semantic classes `sf-calendar`, `sf-calendar-day`, `sf-today`, `sf-weekend`, `sf-holiday`,
    `sf-range-*` (the last four exist already in `Lines.css`).
- **`DateTimePicker`** = `Input` (culture-aware parse/format of what is typed) + `Popover` with the
  `Calendar` + an optional time field (`PlainTime`, step from the property's format). The parsing and
  formatting that lived in `ReactWidgetsLocalizer.tsx` moved to `client/ui/dateFormat.ts`; no `Date` in
  its API.

Exit (met): `/ui-kit` (dev only, `UiKitClient`) shows every component in both modes; verified in the browser —
Combobox local + server search with keyboard pick, typed dates in the culture's order (and an impossible one
flagged), calendar arrow / PageDown navigation, nested modals with Escape, static backdrop, `onExited`
once per close and focus back on the opener, Tabs mount-on-enter. Palettes arrive in Phase 4.

What it turned up, for the phases after it:
- **No preflight means the browser's own `<button>` / `<input>` borders stay.** A kit control that should
  have none says `border-0`; once preflight is on (Phase 5) those become redundant, not wrong.
- **`Lines.css` gives every `.border` a 10px padding** (Signum's), so Tailwind's `border` inherits it. The kit
  writes `border-1` (same 1px) until Phase 2 moves that padding to the views that want it.
- Legacy stylesheets that restate a Bootstrap utility with `!important` (`Tertiary.css`'s `.bg-tertiary`)
  override the Tailwind utility of the same name — layers reverse for important declarations. Delete them
  as the token utilities take over.
- Radix restores focus only to its own `Trigger`; altea opens modals from code, so `Modal` remembers the
  focused element itself (read during render — by the first effect Radix has already moved the focus).
- Intl formats only `Date`s under the Temporal polyfill, so `dateFormat.ts` converts at that one call; the
  components take and give Temporal values only.

### Phase 2 — core `altea/altea/client` ✅
The core client imports neither react-bootstrap nor react-widgets any more. In five commits:

- **2a — semantic form classes.** `client/ui/semantic.css` holds Bootstrap 5.3's form and input-group rules
  renamed to `sf-*` and pointed at the tokens; the *Forms* section of the class map is applied in every
  package (TSX and CSS selectors; `Upgrade_20261015_TailwindFormClasses` for applications). `StyleContext`
  hands out the semantic classes; `BsColumns` → `LabelLayout` (alias kept), LabelColumns on a 12-column grid
  (`sf-form-group-columns` + `col-span-*`, safelisted in theme.css).
- **2b — modal stack** on `ui/Modal`; the parts are `sf-modal-*` (Bootstrap's metrics) in every package, so
  they also style the react-bootstrap modals other packages still render.
- **2c — react-widgets out**: EntityCombo / EnumLine / EntityMultiSelect / QueryTokenBuilder /
  MultiPropertySetter on the ui Combobox (free-text EnumLine: `<input list>`), DateTimeLine / DateTimeRange on
  DateTimePicker with a Temporal calendar API. The kit's form controls wear the semantic classes too.
  `ReactWidgetsLocalizer` stays, re-exporting `ui/dateFormat`, until altea-chart migrates.
- **2d — the rest**: Tabs (`sf-tab-*`), menus (`sf-dropdown-*`), overlays, buttons. react-bootstrap's
  `<Button variant>` became `BootstrapButton` — the same `btn btn-*` markup — so the buttons' look moves in one
  later step instead of piecemeal.
- **2e — Playwright proxies** on semantic and ARIA selectors (`openModal()`, `[role=tablist] [role=tab]` +
  `aria-selected`, `[role=combobox]`, `[cmdk-item]`), each also matching what a not-yet-migrated package renders.

Verified: pages within 1–2px of the Bootstrap baseline (grid rounding, the date button); Playwright scenarios
for the modal stack, date entry, filter tokens, context menus, operation and toolbar menus, theme picker.
**Not run: the e2e suite** — it rewinds the local database to the test snapshot.

What it turned up:
- **Items cross menu boundaries.** Packages hand react-bootstrap `Dropdown.Item`s to core menus (contextual
  items), and core items (quick links) appear in both a button menu and the context menu. So menus that
  render other code's items are plain semantic panels (`MenuPanel`, arrow keys included), and a kit
  `DropdownItem` renders as a plain item when it is not inside a Radix menu.
- **The semantic form rules live in `legacy` for now**, imported right after Bootstrap: altea's own
  `Lines.css` still adjusts those classes and must keep winning. They move to `components` with Bootstrap's
  removal.
- `ReactVisitor` and `ui/Tabs` recognise tabs by shape and name, since views still contain react-bootstrap
  `<Tab>`s.
- A stylesheet whose COMMENT mentions `@layer` was mistaken for a Tailwind file and left unlayered; the
  plugin now ignores comments.
- Left for later phases: the `rw-*` rules in `Lines.css` (altea-chart), `.btn` styling, the `Notify` restyle,
  `--bs-*` in the core stylesheets, `Lines.css`'s `.border { padding }`, the hidden "selected rows" menu
  (not exercised: the option is off in eastwind).

### Phase 2b — primitives on Base UI instead of Radix ✅
shadcn moved its default primitives to Base UI (`@base-ui/react`, MIT) in July 2026, so the kit followed
before any module depends on it. The wrappers kept their props, so no caller changed except the ones below.
- `asChild` stays the kit's spelling; `renderChild()` (`ui/utils.ts`) turns it into Base UI's `render`. A
  trigger rendered as something other than a `<button>` needs `nativeButton={false}` (the quick-link badge
  is an `<a>`).
- State attributes: `data-state="open|active|checked"` → `data-open` / `data-active` / `data-checked`;
  an inactive tab panel has `hidden`. CSS, `Modals.tsx` and the Playwright proxies follow.
- Modal: Base UI reports WHY a dialog wants to close (`escape-key`, `outside-press`, …), so the
  top-of-stack rule for sibling modals is one check in `onOpenChange`; `onExited` is
  `onOpenChangeComplete(false)`, no animation timer. Focus handling (`initialFocus` / `finalFocus`) as before.
- Popover width var `--radix-popover-trigger-width` → `--anchor-width`; `onOpenAutoFocus` →
  `autoFocus={false}` on `PopoverContent`.
- Vite discovered Base UI's entry points only when a LAZY chunk imported one, answered "504 Outdated
  Optimize Dep", and altea reported that as a new deployment. `alteaUiDeps()` (`vite.mjs`) pre-bundles them.
- Verified: the modal/menu/Lines scenarios, the selected-rows menu (shown only on touch devices since the
  master merge), the UI kit's form controls, page screenshots (chrome unchanged). The browser e2e was not
  re-run: it restores the database under the running API.

### Phase 3 — modules (78 files, mechanical)
Dependency order, one commit per package: auth → user-assets / user-queries → chart → dashboard →
toolbar → templating / email / office-template → workflow → dynamic → the rest (1–3 files each).
`altea-alert` `Toast` → `Card`. `altea-chart`'s `ChartTimeSeries` → the shared `Calendar`. Package CSS
into `@layer components`, off `--bs-*`. `Sidebar.css` / toolbar get their `--sf-sidebar-*` knobs.

### Phase 4 — eastwind
- `Layout.tsx` navbar (`NavDropdown`, navbar classes) → `sf-navbar` + `Dropdown`.
- `ThemeSelector` → **palette picker** over bundled palettes, e.g. `default` (neutral/blue), `ocean`,
  `forest`, `rose`, `amber`, `violet` — each a light + dark token block under
  `[data-palette=<name>]`, in one `palettes.css`. The MECHANISM (`data-palette`, the token contract,
  persistence) is altea's; the palettes are the app's. Works offline, applies in build and dev alike.
- Public catalog, `site.css`, `main.client.ts` imports.

### Phase 5 — component-class sweep and removal
- The Phase 0 codemod, now with the `S` rows and *Layout and grid*: the semantic classes and the grid
  (once `sf-row` and the rest are defined), as a second `altea-upgrade` step. It REPORTS every `C` / `M`
  hit, every built class name (`"text-" + color`) and every class it could not map.
- Remove `bootstrap`, `react-bootstrap`, `react-widgets-up` from both `package.json`s; drop the Bootstrap
  layer, the `--bs-*` bridge, the collision blocklist; turn preflight on (+ altea's base restorations);
  remove `data-bs-theme`.
- Gate: no `react-bootstrap`, `react-widgets`, `--bs-`, `data-bs-` left in source.
- Delete the deprecated `BsSize` / `BsColumns` aliases after the `altea-upgrade` step ships.

### Phase 6 — docs
`altea/AGENTS.md` (UI line + a "Styling" section: `ui` kit, tokens, semantic classes vs utilities, how
an app restyles a region), `port/` ledger entry, `eastwind/AGENTS.md` palette notes.

## Risks

| Risk | Mitigation |
| --- | --- |
| Modal stack behaviour (focus, z-order, `onExited` ordering) differs under Radix | built and tested against the real Frame stack in Phase 1, before anything else moves |
| Own calendar: accessibility and culture edge cases | ARIA grid spec above; e2e through `DateTimeLineProxy`; test cultures with Sunday/Monday/Saturday week starts and non-Gregorian-looking formats |
| Bundle on the anonymous boot graph | Radix is per-primitive; compare the `MainPublic` chunk before/after Phase 4 |
| Monaco, Lexical HTML editor, d3 charts read Bootstrap colours | moved to the token set in Phase 3; Monaco keeps observing the theme attribute |
| Downstream apps on `BsSize` / `BsColumns` / `variant` / Bootstrap classes | deprecated aliases for one cycle + the `altea-upgrade` codemod step |
| Visual regressions nobody notices | per-phase browser pass in both modes; Playwright screenshot baseline taken at Phase 0 |

## Size

Phases 0–1 are the design work; 2 is the hardest (Lines + modal stack + react-widgets + calendar); 3 and
5 are large but mechanical. ~450 files in total, almost all in the `altea` submodule.
