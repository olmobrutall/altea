import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Temporal } from "../../data/basics";
import { ReactWidgetsMessage } from "../../data/uiMessages";
import { weekInfo } from "./dateFormat";
import { cn } from "./utils";

export interface DayRender {
    className?: string;
    title?: string;
    content?: React.ReactNode;
}

export interface CalendarProps {
    value?: Temporal.PlainDate | null;
    onChange?: (date: Temporal.PlainDate) => void;
    min?: Temporal.PlainDate;
    max?: Temporal.PlainDate;
    /** Extra look per day: today / weekend / holiday / range marks. */
    renderDay?: (date: Temporal.PlainDate) => DayRender | undefined;
    /** The month shown first when there is no value. */
    defaultMonth?: Temporal.PlainYearMonth;
    /** The coarsest view the user can zoom out to. */
    maxView?: View;
    /** Shows a Today button under the grid. */
    showToday?: boolean;
    today?: Temporal.PlainDate;
    locale?: string;
    className?: string;
    autoFocus?: boolean;
}

type View = "month" | "year" | "decade";

const cmp = Temporal.PlainDate.compare;

/** A month grid on Temporal — no `Date` in or out. Zooms out to a year of months and a decade of years. */
export function Calendar(p: CalendarProps): React.ReactElement {
    const today = p.today ?? Temporal.Now.plainDateISO();
    const week = React.useMemo(() => weekInfo(p.locale), [p.locale]);
    const [view, setView] = React.useState<View>("month");
    const [focused, setFocused] = React.useState<Temporal.PlainDate>(() =>
        clamp(p.value ?? p.defaultMonth?.toPlainDate({ day: 1 }) ?? today, p.min, p.max));
    const gridRef = React.useRef<HTMLTableElement>(null);
    const hasFocus = React.useRef(false);
    const headingId = React.useId();

    React.useEffect(() => {
        if (p.value && !(p.value.year === focused.year && p.value.month === focused.month))
            setFocused(p.value);
    }, [p.value?.toString()]);

    React.useEffect(() => {
        if (hasFocus.current || p.autoFocus)
            gridRef.current?.querySelector<HTMLButtonElement>("button[tabindex='0']")?.focus();
    }, [focused.toString(), view]);

    const fmt = (o: Intl.DateTimeFormatOptions, d: Temporal.PlainDate): string =>
        new Intl.DateTimeFormat(p.locale, o).format(new Date(d.year, d.month - 1, d.day));

    function move(d: Temporal.PlainDate): void {
        setFocused(clamp(d, p.min, p.max));
    }

    function select(d: Temporal.PlainDate): void {
        if (isDisabled(d, "month"))
            return;
        setFocused(d);
        p.onChange?.(d);
    }

    function isDisabled(d: Temporal.PlainDate, v: View): boolean {
        const first = v === "month" ? d : v === "year" ? d.with({ day: 1 }) : d.with({ month: 1, day: 1 });
        const last = v === "month" ? d : v === "year" ? first.add({ months: 1 }).subtract({ days: 1 }) : first.add({ years: 1 }).subtract({ days: 1 });
        return (p.min != null && cmp(last, p.min) < 0) || (p.max != null && cmp(first, p.max) > 0);
    }

    const step: Record<View, Temporal.DurationLike> = { month: { months: 1 }, year: { years: 1 }, decade: { years: 10 } };

    function onKeyDown(e: React.KeyboardEvent): void {
        const cols = view === "month" ? 7 : 4;
        const unit = view === "month" ? "days" : view === "year" ? "months" : "years";
        const by = (n: number): Temporal.PlainDate => focused.add({ [unit]: n });
        let next: Temporal.PlainDate | undefined;
        switch (e.key) {
            case "ArrowLeft": next = by(isRtl(gridRef.current) ? 1 : -1); break;
            case "ArrowRight": next = by(isRtl(gridRef.current) ? -1 : 1); break;
            case "ArrowUp": next = by(-cols); break;
            case "ArrowDown": next = by(cols); break;
            case "PageUp": next = focused.subtract(e.shiftKey && view === "month" ? { years: 1 } : step[view]); break;
            case "PageDown": next = focused.add(e.shiftKey && view === "month" ? { years: 1 } : step[view]); break;
            case "Home": next = view === "month" ? focused.subtract({ days: (focused.dayOfWeek - week.firstDay + 7) % 7 }) : undefined; break;
            case "End": next = view === "month" ? focused.add({ days: 6 - (focused.dayOfWeek - week.firstDay + 7) % 7 }) : undefined; break;
            case "Enter":
            case " ":
                e.preventDefault();
                if (view === "month") select(focused);
                else setView(view === "decade" ? "year" : "month");
                return;
            default: return;
        }
        if (next) {
            e.preventDefault();
            move(next);
        }
    }

    const maxView = p.maxView ?? "decade";
    const title = view === "month" ? fmt({ month: "long", year: "numeric" }, focused)
        : view === "year" ? String(focused.year)
            : `${decadeStart(focused)} – ${decadeStart(focused) + 9}`;

    return (
        <div className={cn("sf-calendar inline-block w-[17.5rem] select-none rounded-md border-1 bg-popover p-2 text-popover-foreground", p.className)}
            onFocus={() => { hasFocus.current = true; }}
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hasFocus.current = false; }}>
            <div className="mb-1 flex items-center gap-1">
                <NavButton icon="chevron-left" label={ReactWidgetsMessage.MoveBack.niceToString()}
                    onClick={() => move(focused.subtract(step[view]))} />
                <button type="button" id={headingId} aria-live="polite"
                    disabled={view === maxView}
                    onClick={() => setView(view === "month" ? "year" : "decade")}
                    className="sf-calendar-title flex-1 cursor-pointer border-0 bg-transparent text-inherit rounded-md px-2 py-1 font-medium hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent">
                    {title}
                </button>
                <NavButton icon="chevron-right" label={ReactWidgetsMessage.MoveForward.niceToString()}
                    onClick={() => move(focused.add(step[view]))} />
            </div>

            <table ref={gridRef} role="grid" aria-labelledby={headingId} onKeyDown={onKeyDown} className="w-full table-fixed border-collapse text-center text-sm">
                {view === "month" && monthGrid()}
                {view === "year" && <CellGrid cells={Array.from({ length: 12 }, (_, i) => focused.with({ month: i + 1, day: 1 }))}
                    label={d => fmt({ month: "short" }, d)} fullLabel={d => fmt({ month: "long", year: "numeric" }, d)}
                    isFocused={d => d.month === focused.month} isSelected={d => p.value?.year === d.year && p.value.month === d.month}
                    isCurrent={d => today.year === d.year && today.month === d.month} disabled={d => isDisabled(d, "year")}
                    onPick={d => { setFocused(clamp(focused.with({ month: d.month }), p.min, p.max)); setView("month"); }} />}
                {view === "decade" && <CellGrid cells={Array.from({ length: 12 }, (_, i) => focused.with({ year: decadeStart(focused) - 1 + i, month: 1, day: 1 }))}
                    label={d => String(d.year)} fullLabel={d => String(d.year)}
                    isFocused={d => d.year === focused.year} isSelected={d => p.value?.year === d.year}
                    isCurrent={d => today.year === d.year} disabled={d => isDisabled(d, "decade")}
                    outside={d => d.year < decadeStart(focused) || d.year > decadeStart(focused) + 9}
                    onPick={d => { setFocused(clamp(focused.with({ year: d.year }), p.min, p.max)); setView("year"); }} />}
            </table>

            {p.showToday !== false &&
                <button type="button" disabled={isDisabled(today, "month")} onClick={() => { setView("month"); select(today); }}
                    className="sf-calendar-today mt-1 w-full cursor-pointer border-0 bg-transparent rounded-md px-2 py-1 text-sm text-primary hover:bg-accent disabled:cursor-default disabled:opacity-50">
                    {ReactWidgetsMessage.MoveToday.niceToString()}
                </button>}
        </div>
    );

    function monthGrid(): React.ReactElement {
        const first = focused.with({ day: 1 });
        const start = first.subtract({ days: (first.dayOfWeek - week.firstDay + 7) % 7 });
        const days = Array.from({ length: 42 }, (_, i) => start.add({ days: i }));
        const weekdays = days.slice(0, 7);

        return (
            <>
                <thead>
                    <tr>
                        {weekdays.map(d =>
                            <th key={d.dayOfWeek} scope="col" abbr={fmt({ weekday: "long" }, d)} className="py-1 text-xs font-normal text-muted-foreground">
                                {fmt({ weekday: "short" }, d).slice(0, 2)}
                            </th>)}
                    </tr>
                </thead>
                <tbody>
                    {[0, 1, 2, 3, 4, 5].map(row =>
                        <tr key={row}>
                            {days.slice(row * 7, row * 7 + 7).map(d => {
                                const isFocused = cmp(d, focused) === 0;
                                const selected = p.value != null && cmp(d, p.value) === 0;
                                const disabled = isDisabled(d, "month");
                                const extra = p.renderDay?.(d);
                                return (
                                    <td key={d.toString()} role="gridcell" aria-selected={selected} className="p-0">
                                        <button type="button" tabIndex={isFocused ? 0 : -1} disabled={disabled}
                                            aria-label={fmt({ dateStyle: "full" }, d)} aria-current={cmp(d, today) === 0 ? "date" : undefined}
                                            title={extra?.title}
                                            onClick={() => select(d)}
                                            className={cn("sf-calendar-day mx-auto flex size-8 cursor-pointer items-center justify-center rounded-md border-1 border-transparent bg-transparent text-inherit",
                                                "hover:bg-accent focus-visible:outline-none focus-visible:ring-[.2rem] focus-visible:ring-ring",
                                                d.month !== focused.month && "text-muted-foreground",
                                                week.weekend.includes(d.dayOfWeek) && "sf-weekend",
                                                cmp(d, today) === 0 && "sf-today border-primary",
                                                selected && "bg-primary text-primary-foreground hover:bg-primary/90",
                                                disabled && "cursor-default opacity-40 hover:bg-transparent",
                                                extra?.className)}>
                                            {extra?.content ?? d.day}
                                        </button>
                                    </td>
                                );
                            })}
                        </tr>)}
                </tbody>
            </>
        );
    }
}

interface CellGridProps {
    cells: Temporal.PlainDate[];
    label: (d: Temporal.PlainDate) => string;
    fullLabel: (d: Temporal.PlainDate) => string;
    isFocused: (d: Temporal.PlainDate) => boolean;
    isSelected: (d: Temporal.PlainDate) => boolean;
    isCurrent: (d: Temporal.PlainDate) => boolean;
    disabled: (d: Temporal.PlainDate) => boolean;
    outside?: (d: Temporal.PlainDate) => boolean;
    onPick: (d: Temporal.PlainDate) => void;
}

function CellGrid(p: CellGridProps): React.ReactElement {
    return (
        <tbody>
            {[0, 1, 2].map(row =>
                <tr key={row}>
                    {p.cells.slice(row * 4, row * 4 + 4).map(d =>
                        <td key={d.toString()} role="gridcell" aria-selected={p.isSelected(d)} className="p-0.5">
                            <button type="button" tabIndex={p.isFocused(d) ? 0 : -1} disabled={p.disabled(d)} aria-label={p.fullLabel(d)}
                                onClick={() => p.onPick(d)}
                                className={cn("flex h-12 w-full cursor-pointer items-center justify-center rounded-md border-1 border-transparent bg-transparent text-inherit",
                                    "hover:bg-accent focus-visible:outline-none focus-visible:ring-[.2rem] focus-visible:ring-ring",
                                    p.outside?.(d) && "text-muted-foreground",
                                    p.isCurrent(d) && "border-primary",
                                    p.isSelected(d) && "bg-primary text-primary-foreground hover:bg-primary/90",
                                    p.disabled(d) && "cursor-default opacity-40 hover:bg-transparent")}>
                                {p.label(d)}
                            </button>
                        </td>)}
                </tr>)}
        </tbody>
    );
}

function NavButton(p: { icon: "chevron-left" | "chevron-right", label: string, onClick: () => void }): React.ReactElement {
    return (
        <button type="button" aria-label={p.label} title={p.label} onClick={p.onClick}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-inherit hover:bg-accent focus-visible:outline-none focus-visible:ring-[.2rem] focus-visible:ring-ring">
            <FontAwesomeIcon icon={p.icon} className="text-[.75em] rtl:rotate-180" aria-hidden={true} />
        </button>
    );
}

function decadeStart(d: Temporal.PlainDate): number {
    return Math.floor(d.year / 10) * 10;
}

function clamp(d: Temporal.PlainDate, min?: Temporal.PlainDate, max?: Temporal.PlainDate): Temporal.PlainDate {
    if (min && cmp(d, min) < 0) return min;
    if (max && cmp(d, max) > 0) return max;
    return d;
}

function isRtl(el: HTMLElement | null): boolean {
    return el != null && getComputedStyle(el).direction === "rtl";
}
