# Bootstrap 5 → Tailwind v4 / altea class map

The one dictionary for translating Bootstrap markup — in altea, in eastwind, and in any application
ported from Signum (whose views are written against the same Bootstrap 5 classes). Apply it the same way
everywhere and the result is consistent: the same Bootstrap idiom always becomes the same thing.

Plan and reasoning: [`Tailwind-Plan.md`](Tailwind-Plan.md).

## How to read it

Every row has a **Kind**:

| Kind | Meaning | Codemod |
| --- | --- | --- |
| **U** | Tailwind utility, same effect | rewrites |
| **S** | altea **semantic** class (`sf-*`), defined by altea in `@layer components`; an application restyles it with plain CSS | rewrites |
| **C** | use an altea `ui` component (`@altea/altea/client/ui`) instead of the class | reports |
| **M** | depends on context — decide by hand | reports |
| **X** | delete, nothing replaces it | rewrites |

The tables are the codemod's input (`altea-upgrade/tailwind/ClassMap.ts`), so their shape is a format:

- Four columns, `Bootstrap | Replacement | Kind | Notes`. Only tables with that header are read.
- A cell holds one or more backticked items separated by ` / `; the replacement and kind cells pair with
  them by position (or hold one item for all). A replacement is space-separated classes, `<Component>`, or
  `—` for nothing.
- `{a,b,c}` and `{1..12}` expand; the n-th group of the replacement pairs with the n-th group of the
  Bootstrap item, alternative by alternative. `{colour}` expands over the colour table, and the
  replacement names its column with `{token}` or `{text-token}`. A `{bp}` item is skipped — the
  breakpoint rule below covers it.
- An item without braces wins over one a pattern expanded to the same class.
- Where two Bootstrap classes on one element set the same property, Bootstrap's CSS order decided; the
  codemod keeps that answer. Today one case: `display-*` or `lead` beside `h1`…`h6` (Signum's
  `display-6 h2`) is a display size, so the heading class is dropped.

**Why S and not U for some rows.** A Bootstrap COMPONENT class (`form-control`, `input-group`, `table`,
`btn-toolbar`, `form-group`) names a thing an application may want to restyle across every screen. Exploded
into utilities, that restyling would mean editing every view; as an `sf-*` class it is one CSS rule in the
app. A Bootstrap UTILITY (`d-flex`, `me-2`) only ever means itself, so it becomes a Tailwind utility.

## General rules

### Breakpoint infixes

Bootstrap puts the breakpoint INSIDE the class, Tailwind puts it IN FRONT as a variant:
`{prefix}-{bp}-{rest}` → `{bp}:{translation of prefix-rest}`.

| Bootstrap `{bp}` | Tailwind variant | Width |
| --- | --- | --- |
| `sm` | `sm:` | 576px |
| `md` | `md:` | 768px |
| `lg` | `lg:` | 992px |
| `xl` | `xl:` | 1200px |
| `xxl` | `2xl:` | 1400px |

altea's theme sets Tailwind's breakpoints to Bootstrap's widths, so a translated layout breaks where it
did before. Examples: `d-md-none` → `md:hidden`, `text-lg-end` → `lg:text-end`, `mb-sm-0` → `sm:mb-0`,
`col-md-6` → `md:col-span-6`.

## Spacing

Bootstrap's spacer steps are NOT Tailwind's numbers — `me-3` is `me-4`, not `me-3`:

| Bootstrap step | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| size | 0 | .25rem | .5rem | 1rem | 1.5rem | 3rem |
| Tailwind step | `0` | `1` | `2` | `4` | `6` | `12` |

Sides stay logical (`ms` / `me` / `ps` / `pe`), so RTL keeps working.

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `m{,t,b,s,e,x,y}-{0,1,2,3,4,5,auto}` | `m{,t,b,s,e,x,y}-{0,1,2,4,6,12,auto}` | U | |
| `m{,t,b,s,e,x,y}-n{1,2,3,4,5}` | `-m{,t,b,s,e,x,y}-{1,2,4,6,12}` | U | negative margins (`$enable-negative-margins`) |
| `p{,t,b,s,e,x,y}-{0,1,2,3,4,5}` | `p{,t,b,s,e,x,y}-{0,1,2,4,6,12}` | U | `pe-none` / `pe-auto` are NOT padding: see *Interaction* |
| `gap-{0,1,2,3,4,5}` | `gap-{0,1,2,4,6,12}` | U | |
| `row-gap-{0,1,2,3,4,5}` / `column-gap-{0,1,2,3,4,5}` | `gap-y-{0,1,2,4,6,12}` / `gap-x-{0,1,2,4,6,12}` | U | |

## Layout and grid

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `container` | `sf-container` | S | centred, max-width per breakpoint, side padding (Tailwind's own `container` has no padding / centring) |
| `container-fluid` | `w-full px-3` | U | Bootstrap pads it with half the 1.5rem gutter |
| `container-{bp}` | `sf-container-{bp}` | S | |
| `row` | `sf-row` | S | 12-column grid with the `--sf-gutter` column gap; a child with no `col-span-*` spans 12 |
| `row` whose children are all col / col-auto | `flex flex-wrap gap-x-(--sf-gutter)` | M | equal-width columns are a flex row, not a grid |
| `col-{1..12}` | `col-span-{1..12}` | U | inside `sf-row` |
| `col-{bp}-{1..12}` | `{bp}:col-span-{1..12}` | U | below `{bp}` it spans 12, as in Bootstrap |
| `col` | `flex-1 min-w-0` | M | only valid in a flex row (see above) |
| `col-{bp}` | `{bp}:flex-1 min-w-0` | M | |
| `col-auto` | `flex-none` | M | in a flex row; in `sf-row` use `col-span-*` or move to flex |
| `offset-{1..11}` | `col-start-{2..12}` | U | with a breakpoint: `offset-md-2` → `md:col-start-3` |
| `g-{0,1,2,3,4,5}` / `gx-{0,1,2,3,4,5}` / `gy-{0,1,2,3,4,5}` | `gap-{0,1,2,4,6,12}` / `gap-x-{0,1,2,4,6,12}` / `gap-y-{0,1,2,4,6,12}` | U | on the `sf-row`; drops the negative-margin gutter model |
| `row-cols-{1..6}` | `grid-cols-{1..6}` | U | the row becomes a grid |
| `hstack` | `flex flex-row items-center` | U | |
| `vstack` | `flex flex-col` | U | |
| `vr` | `self-stretch w-px bg-border` | U | |
| `clearfix` | `flow-root` | U | |

## Display, flex, alignment

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `d-none` | `hidden` | U | |
| `d-block` / `d-inline` / `d-inline-block` | `block` / `inline` / `inline-block` | U | |
| `d-flex` / `d-inline-flex` | `flex` / `inline-flex` | U | |
| `d-grid` | `grid` | U | |
| `d-table` / `d-table-cell` / `d-table-row` | `table` / `table-cell` / `table-row` | U | |
| `d-print-none` | `print:hidden` | U | |
| `flex-row` / `flex-column` | `flex-row` / `flex-col` | U | |
| `flex-row-reverse` / `flex-column-reverse` | `flex-row-reverse` / `flex-col-reverse` | U | |
| `flex-wrap` / `flex-nowrap` | `flex-wrap` / `flex-nowrap` | U | |
| `flex-fill` | `flex-auto` | U | `1 1 auto` |
| `flex-grow-1` / `flex-grow-0` | `grow` / `grow-0` | U | |
| `flex-shrink-1` / `flex-shrink-0` | `shrink` / `shrink-0` | U | |
| `justify-content-{start,end,center,between,around,evenly}` | `justify-{start,end,center,between,around,evenly}` | U | |
| `align-items-{start,end,center,baseline,stretch}` | `items-{start,end,center,baseline,stretch}` | U | |
| `align-self-{start,end,center,baseline,stretch,auto}` | `self-{start,end,center,baseline,stretch,auto}` | U | |
| `align-content-{start,end,center,between,around,stretch}` | `content-{start,end,center,between,around,stretch}` | U | |
| `align-{baseline,top,middle,bottom,text-top,text-bottom}` | `align-{baseline,top,middle,bottom,text-top,text-bottom}` | U | vertical-align |
| `order-{0..5}` / `order-first` / `order-last` | `order-{0..5}` / `order-first` / `order-last` | U | |
| `float-start` / `float-end` / `float-none` | `float-start` / `float-end` / `float-none` | U | logical |

## Sizing, position, overflow

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `w-25` / `w-50` / `w-75` / `w-100` | `w-1/4` / `w-1/2` / `w-3/4` / `w-full` | U | |
| `w-auto` | `w-auto` | U | |
| `h-25` / `h-50` / `h-75` / `h-100` | `h-1/4` / `h-1/2` / `h-3/4` / `h-full` | U | |
| `mw-100` / `mh-100` | `max-w-full` / `max-h-full` | U | |
| `vw-100` / `vh-100` | `w-screen` / `h-screen` | U | |
| `min-vw-100` / `min-vh-100` | `min-w-screen` / `min-h-screen` | U | |
| `position-{static,relative,absolute,fixed,sticky}` | `{static,relative,absolute,fixed,sticky}` | U | |
| `top-{0,50,100}` / `bottom-{0,50,100}` | `top-{0,1/2,full}` / `bottom-{0,1/2,full}` | U | |
| `start-{0,50,100}` / `end-{0,50,100}` | `start-{0,1/2,full}` / `end-{0,1/2,full}` | U | logical |
| `translate-middle` | `-translate-1/2` | U | |
| `translate-middle-x` / `-y` | `-translate-x-1/2` / `-translate-y-1/2` | U | |
| `fixed-top` | `fixed inset-x-0 top-0 z-30` | U | |
| `fixed-bottom` | `fixed inset-x-0 bottom-0 z-30` | U | |
| `sticky-top` | `sticky top-0 z-20` | U | `sticky-md-top` → `md:sticky md:top-0 md:z-20` |
| `overflow-{auto,hidden,visible,scroll}` | `overflow-{auto,hidden,visible,scroll}` | U | |
| `overflow-x-auto` / `overflow-y-auto` | `overflow-x-auto` / `overflow-y-auto` | U | |
| `object-fit-{contain,cover,fill,none,scale}` | `object-{contain,cover,fill,none,scale-down}` | U | |
| `ratio ratio-16x9` / `ratio-4x3` / `ratio-1x1` | `aspect-video` / `aspect-4/3` / `aspect-square` | U | |
| `z-{0,1,2,3}` | `z-{0,10,20,30}` | U | |

## Typography

altea's theme defines `--text-h1 … --text-h6` and `--text-display-1 … --text-display-7` with Bootstrap's
sizes, so these are exact rather than nearest-Tailwind-step.

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `h{1,2,3,4,5,6}` (as a class) | `text-h{1,2,3,4,5,6} font-medium` | U | the ELEMENTS keep their look via altea's `@layer base` |
| `fs-{1,2,3,4,5,6}` | `text-(length:--text-h{1,2,3,4,5,6})` | U | size only, like Bootstrap's `fs-*` |
| `display-{1,2,3,4,5,6}` | `text-display-{1,2,3,4,5,6} font-light` | U | |
| `display-7` | `text-display-7 font-light` | U | altea's own step |
| `lead` | `text-[1.25rem] font-light` | U | size only: Bootstrap's `.lead` keeps the inherited line-height |
| `small` | `text-[.875em]` | U | relative, as in Bootstrap |
| `fw-bold` / `fw-bolder` | `font-bold` / `font-extrabold` | U | |
| `fw-semibold` / `fw-medium` | `font-semibold` / `font-medium` | U | |
| `fw-normal` / `fw-light` / `fw-lighter` | `font-normal` / `font-light` / `font-extralight` | U | |
| `fst-italic` / `fst-normal` | `italic` / `not-italic` | U | |
| `lh-1` / `lh-sm` / `lh-base` / `lh-lg` | `leading-none` / `leading-tight` / `leading-normal` / `leading-loose` | U | |
| `font-monospace` | `font-mono` | U | |
| `text-start` / `text-center` / `text-end` | `text-start` / `text-center` / `text-end` | U | logical |
| `text-wrap` / `text-nowrap` | `text-wrap` / `text-nowrap` | U | |
| `text-truncate` | `truncate` | U | |
| `text-break` | `break-words` | U | |
| `text-lowercase` / `text-uppercase` / `text-capitalize` | `lowercase` / `uppercase` / `capitalize` | U | |
| `text-decoration-{none,underline,line-through}` | `{no-underline,underline,line-through}` | U | |
| `user-select-none` / `user-select-all` | `select-none` / `select-all` | U | |
| `list-unstyled` | `list-none ps-0` | U | |
| `list-inline` / `list-inline-item` | `flex flex-wrap gap-2 list-none ps-0` / — | U / X | |
| `initialism` | `text-[90%] uppercase` | U | |
| `blockquote` | `sf-blockquote` | S | |
| `mark` | `bg-warning/30` | U | |

## Colour

Bootstrap theme colour → altea token. Tokens come from the active palette and mode; never hard-code a
Tailwind palette colour (`blue-500`) where a token exists.

| Bootstrap colour | `{token}` (background, border) | `{text-token}` (text) |
| --- | --- | --- |
| `primary` | `primary` | `primary` |
| `secondary` | `secondary` | `muted-foreground` |
| `tertiary` | `tertiary` | `tertiary-foreground` |
| `success` | `success` | `success` |
| `danger` | `destructive` | `destructive` |
| `warning` | `warning` | `warning` |
| `info` | `info` | `info` |
| `light` | `light` | `light` |
| `dark` | `dark` | `dark` |
| `body` | `background` | `foreground` |
| `body-secondary` | `muted` | `muted-foreground` |
| `body-tertiary` | `tertiary` | `muted-foreground` |
| `body-emphasis` | `background` | `foreground` |
| `white` | `white` | `white` |
| `black` | `black` | `black` |
| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `text-{colour}` | `text-{text-token}` | U | `text-danger` → `text-destructive` |
| `text-muted` | `text-muted-foreground` | U | |
| `text-reset` | `text-inherit` | U | |
| `text-{colour}-emphasis` | `text-{text-token}` | U | |
| `text-opacity-{25,50,75}` | `text-{token}/{25,50,75}` | M | needs the colour of the sibling `text-*` |
| `bg-{colour}` | `bg-{token}` | U | |
| `bg-{colour}-subtle` | `bg-{token}/10` | U | |
| `bg-body` | `bg-background` | U | |
| `bg-body-secondary` / `bg-body-tertiary` | `bg-muted` | U | |
| `bg-transparent` | `bg-transparent` | U | |
| `bg-opacity-{10,25,50,75}` | `bg-{token}/{10,25,50,75}` | M | |
| `bg-gradient` | — | X | |
| `text-bg-{colour}` | `bg-{token} text-{token}-foreground` | U | |
| `link-{colour}` | `text-{text-token} hover:underline` | U | |
| `link-body-emphasis` | `text-foreground hover:underline` | U | |

## Borders, radius, shadow

Tailwind v4's `border` defaults to `currentColor`; altea's base layer sets every border to
`var(--border)`, as Bootstrap does with `--bs-border-color`.

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `border` | `border` | U | |
| `border-0` | `border-0` | U | |
| `border-top` / `border-bottom` | `border-t` / `border-b` | U | |
| `border-start` / `border-end` | `border-s` / `border-e` | U | logical |
| `border-{top,bottom,start,end}-0` | `border-{t,b,s,e}-0` | U | |
| `border-{1,2,3,4,5}` | `border{,-2,-[3px],-4,-[5px]}` | U | width |
| `border-{colour}` | `border-{token}` | U | |
| `border-{colour}-subtle` | `border-{token}/30` | U | |
| `rounded` | `rounded-md` | U | .375rem |
| `rounded-0` | `rounded-none` | U | |
| `rounded-{1,2,3,4,5}` | `rounded-{sm,md,lg,2xl,4xl}` | U | |
| `rounded-circle` / `rounded-pill` | `rounded-full` | U | |
| `rounded-{top,bottom,start,end}` | `rounded-{t,b,s,e}-md` | U | logical |
| `shadow-sm` / `shadow` / `shadow-lg` | `shadow-xs` / `shadow-md` / `shadow-xl` | U | nearest |
| `shadow-none` | `shadow-none` | U | |
| `opacity-{0,25,50,75,100}` | `opacity-{0,25,50,75,100}` | U | |

## Interaction and accessibility

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `visually-hidden` | `sr-only` | U | |
| `visually-hidden-focusable` | `sr-only focus:not-sr-only` | U | |
| `pe-none` | `pointer-events-none` | U | NOT padding-end |
| `pe-auto` | `pointer-events-auto` | U | NOT padding-end |
| `stretched-link` | `after:absolute after:inset-0 after:content-['']` | U | the parent needs `relative` |
| `text-hide` | — | X | |
| `active` | `data-[state=active]` / `aria-current` | M | the `ui` components set the state attribute themselves |
| `disabled` (class) | `disabled` attribute / `aria-disabled` | M | |
| `show` / `fade` / `collapse` / `collapsing` | — | C | owned by `<Collapsible>` / `<Modal>` / `<Dropdown>` |

## Buttons

Buttons are SEMANTIC classes (Phase 5): Bootstrap's own button CSS, renamed and on the tokens (`ui/components.css`),
so markup that hand-writes `btn btn-primary` and the kit's `<Button variant="primary">` render the same rules,
and an application restyles every button through `.sf-btn*` or the `--sf-btn-*` knobs.

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `btn` | `sf-btn` | S | |
| `btn-{primary,secondary,success,danger,warning,info,light,dark,link}` | `sf-btn-{primary,secondary,success,danger,warning,info,light,dark,link}` | S | the kit's `variant="destructive"` renders `sf-btn-danger` |
| `btn-tertiary` | `sf-btn-tertiary` | S | altea's |
| `btn-default` | — | X | Bootstrap 3, still found in ported Signum views; Bootstrap 5 has no rule for it, so it renders as a plain `btn` |
| `btn-outline-{primary,secondary,success,danger,warning,info,light,dark}` | `sf-btn-outline-{primary,secondary,success,danger,warning,info,light,dark}` | S | |
| `btn-xs` / `btn-sm` / `btn-lg` | `sf-btn-xs` / `sf-btn-sm` / `sf-btn-lg` | S | `btn-xs` is altea's (Lines.css) |
| `btn-close` | `sf-btn-close` | S | the kit's `<CloseButton>` is `sf-close-button` |
| `btn-group` / `btn-group-sm` / `btn-group-lg` | `sf-btn-group` / `sf-btn-group-sm` / `sf-btn-group-lg` | S | |
| `btn-group-vertical` | `sf-btn-group-vertical` | S | |
| `btn-toolbar` | `sf-btn-toolbar` | S | operation bars — an app retunes spacing in one place |
| `btn-toolbar-small` | `sf-btn-toolbar sf-btn-toolbar-sm` | S | |
| `btn-check` | `<Toggle>` / `<ToggleGroup>` | C | |

## Forms

Lines get these classes from `StyleContext` (`formControlClass`, …), so a Line rarely spells them out;
hand-written forms in views do. Every size modifier exists as `-xs`, `-sm`, `-lg` (altea adds `xs`).

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `form-group` | `sf-form-group` | S | Bootstrap 4, kept by Signum/altea |
| `form-group-{xs,sm,lg}` | `sf-form-group-{xs,sm,lg}` | S | |
| `form-label` | `sf-form-label` | S | |
| `col-form-label` | `sf-col-form-label` | S | label of a LabelColumns form group |
| `col-form-label-{xs,sm,lg}` | `sf-col-form-label-{xs,sm,lg}` | S | |
| `label-{xs,sm}` | `sf-form-label-{xs,sm}` | S | altea's |
| `form-control` | `sf-form-control` | S | `<Input>` / `<Textarea>` render it |
| `form-control-{xs,sm,md,lg}` | `sf-form-control-{xs,sm,md,lg}` | S | |
| `form-control-plaintext` / `form-control-static` | `sf-form-control-plaintext` | S | read-only value; `-static` is Bootstrap 3 |
| `form-control-color` | `sf-form-control-color` | S | |
| `form-select` | `sf-form-select` | S | native `<select>`; a filtering one is `<Combobox>` |
| `form-select-{xs,sm,lg}` | `sf-form-select-{xs,sm,lg}` | S | |
| `form-check` | `sf-form-check` | S | |
| `form-check-input` / `form-switch` | `sf-form-check-input` / `sf-form-switch` | S | the kit's `<Checkbox>` / `<Switch>` for new code |
| `form-check-label` | `sf-form-check-label` | S | |
| `form-check-inline` | `sf-form-check sf-form-check-inline` | S | |
| `form-switch` | `<Switch>` | C | |
| `form-range` | `sf-form-range` | S | |
| `form-text` | `sf-form-text` | S | help text |
| `form-floating` | `sf-form-floating` | S | |
| `form-inline` | `flex flex-wrap items-center gap-2` | U | Bootstrap 4 |
| `form-sm` / `form-compact` | `sf-form-sm` / `sf-form-compact` | S | altea's |
| `input-group` | `sf-input-group` | S | `<InputGroup>` renders it |
| `input-group-{xs,sm,lg}` | `sf-input-group-{xs,sm,lg}` | S | |
| `input-group-text` | `sf-input-group-text` | S | |
| `input-group-vertical` | `sf-input-group-vertical` | S | altea's |
| `is-invalid` | `aria-invalid="true"` + `sf-invalid` | M | attribute for accessibility, class as the styling hook |
| `is-valid` | — | X | |
| `invalid-feedback` / `invalid-tooltip` | `sf-invalid-feedback` | S | |
| `was-validated` / `needs-validation` | — | X | altea validates on the entity, not with `:invalid` |

## Content components

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `table` | `sf-table` | S | search results, repeaters and views share one restylable table look |
| `table-sm` | `sf-table-sm` | S | |
| `table-hover` / `table-striped` / `table-bordered` / `table-borderless` | `sf-table-hover` / `sf-table-striped` / `sf-table-bordered` / `sf-table-borderless` | S | |
| `table-active` | `sf-table-active` | S | |
| `table-{colour}` (row) | `bg-{token}/10` | U | |
| `table-responsive` | `overflow-x-auto` | U | |
| `table-container` / `table-valued` / `sticky-header` | `sf-table-container` / `sf-table-valued` / `sf-sticky-header` | S | altea's |
| `card` | `sf-card` | S | the kit's `<Card>` renders the same class |
| `card-{header,body,footer,title,subtitle,text,link}` | `sf-card-{header,body,footer,title,subtitle,text,link}` | S | |
| `card-img-top` | `rounded-t-md w-full` | U | |
| `alert` | `sf-alert` | S | |
| `alert-{primary,secondary,success,danger,warning,info,light,dark}` | `sf-alert-{primary,secondary,success,danger,warning,info,light,dark}` | S | |
| `alert-dismissible` | `sf-alert-dismissible` | S | |
| `alert-heading` / `alert-link` | `sf-alert-heading` / `sf-alert-link` | S | |
| `badge` | `sf-badge` | S | |
| `badge-pill` | — | X | Bootstrap 4; Bootstrap 5 has no rule for it |
| `list-group` | `sf-list-group` | S | |
| `list-group-item` / `-action` / `-flush` | `sf-list-group-item` / `sf-list-group-item-action` / `sf-list-group-flush` | S | |
| `progress` / `progress-bar` / `progress-bar-striped` / `progress-bar-animated` | `sf-progress` / `sf-progress-bar` / `sf-progress-bar-striped` / `sf-progress-bar-animated` | S | the kit's `<Progress>` for new code |
| `spinner-border` / `spinner-border-sm` | `sf-spinner-border` / `sf-spinner-border-sm` | S | the kit's `<Spinner>` for new code |
| `placeholder` / `placeholder-glow` | `<Skeleton>` | C | |
| `figure` / `figure-img` / `figure-caption` | `sf-figure` / `rounded-md` / `text-sm text-muted-foreground` | S / U / U | |
| `img-fluid` | `max-w-full h-auto` | U | |
| `img-thumbnail` | `max-w-full h-auto rounded-md border p-1 bg-background` | U | |
| `breadcrumb` / `breadcrumb-item` | `<Breadcrumb>` | C | |
| `pagination` / `pagination-sm` / `page-item` / `page-link` | `sf-pagination` / `sf-pagination-sm` / `sf-page-item` / `sf-page-link` | S | |
| `accordion*` | `<Accordion>` | C | |

## Navigation and overlays

These are all COMPONENTS — the class strings only appear in markup that hand-rolls what react-bootstrap
rendered.

| Bootstrap | Replacement | Kind | Notes |
| --- | --- | --- | --- |
| `nav nav-tabs` / `nav-pills` | `<Tabs>` / `<Tabs variant="pills">` | C | |
| `nav-item` / `nav-link` | `sf-nav-item` / `sf-nav-link` | S | a sidebar or navbar link; inside `<Tabs>` the kit owns them |
| `tab-content` / `tab-pane` | — | C | owned by `<Tabs>` |
| `nav` | `sf-nav` | S | Bootstrap's plain link list |
| `navbar` / `navbar-expand-*` | `sf-navbar` | S | the app shell; an app restyles it |
| `navbar-brand` / `navbar-nav` / `navbar-text` / `navbar-toggler` / `navbar-collapse` | `sf-navbar-brand` / `sf-navbar-nav` / `sf-navbar-text` / `sf-navbar-toggler` / `sf-navbar-collapse` | S | |
| `dropdown` / `dropdown-toggle` / `dropdown-toggle-split` | `sf-dropdown` / `sf-dropdown-toggle` / `sf-dropdown-toggle-split` | S | the caret on a menu's trigger |
| `dropdown-menu` / `dropdown-item` / `dropdown-divider` / `dropdown-header` | `<DropdownContent>` / `<DropdownItem>` / `<DropdownSeparator>` / `<DropdownLabel>` | C | |
| `modal` / `modal-dialog` / `modal-content` | `<Modal>` | C | |
| `modal-header` / `modal-title` / `modal-body` / `modal-footer` | `<Modal.Header>` / `<Modal.Title>` / `<Modal.Body>` / `<Modal.Footer>` | C | each also carries `sf-modal-*` for restyling |
| `modal-{sm,lg,xl,fullscreen}` | `size="{sm,lg,xl,fullscreen}"` | C | |
| `modal-heading` | `sf-modal-heading` | S | altea's |
| `offcanvas*` | `<Sheet>` | C | |
| `tooltip` / `popover` | `<Tooltip>` / `<Popover>` | C | |
| `toast` | `<Card>` or `Notify` | M | altea has no toast; `Notify` is the status banner |
| `collapse` / `collapsing` | `<Collapsible>` | C | |

## react-bootstrap / react-widgets components

| From | altea `ui` | Notes |
| --- | --- | --- |
| `Modal` (+ `.Header` `.Title` `.Body` `.Footer`) | `Modal` | same props: `show`, `onHide`, `onExited`, `size`, `dialogClassName` |
| `Tabs` / `Tab` | `Tabs` / `Tab` | same props: `activeKey`, `onSelect`, `eventKey`, `title`, `mountOnEnter`, `unmountOnExit` |
| `Dropdown` / `DropdownButton` / `NavDropdown` | `Dropdown` / `DropdownButton` | |
| `Button` / `ButtonGroup` | `Button` / `ButtonGroup` | |
| `OverlayTrigger` + `Tooltip` | `WithTooltip` | |
| `OverlayTrigger` + `Popover` / `Overlay` | `Popover` | |
| `Collapse` | `Collapsible` | |
| `ProgressBar` / `Spinner` | `Progress` / `Spinner` | |
| `Toast` | `Card` | only used as list cards |
| `Nav` | `Tabs` or plain links | |
| `FormCheck` | `Checkbox` / `Switch` | |
| `DropdownList` | `Select` (short, no filter) / `Combobox` (filterable) | |
| `Combobox` | `Combobox` | |
| `Multiselect` | `MultiCombobox` | |
| `DatePicker` | `DateTimePicker` | Temporal in, Temporal out |
| `Calendar` | `Calendar` | `renderDay` replaces `RenderDayProp` |
| `Localization` / `IntlLocalizer` | — | culture comes from altea's own culture info |

## Selectors in tests

Playwright proxies and application tests select by ROLE or by `sf-*` / `data-*` hooks, never by a
library's internal class:

| Was | Now |
| --- | --- |
| `.modal`, `.modal-header` | `[role=dialog]`, `.sf-modal-header` |
| `.nav-tabs .nav-link` | `[role=tablist] [role=tab]` |
| `.dropdown-menu` | `[role=menu]` |
| `.rw-popup-container`, `.rw-dropdown-list-value` | `[role=listbox]`, `[role=combobox]` |
| `.form-control` | `.sf-form-control` |

## Not in the map

Anything that is neither a Bootstrap class nor an `sf-*` class (an app's own class) is left alone. Any
Bootstrap class not listed here is reported by the codemod — add a row rather than translating it ad hoc,
so the next application gets the same answer.
