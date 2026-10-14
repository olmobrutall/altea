import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { EntityControlMessage, JavascriptMessage, ReactWidgetsMessage } from "../../data/uiMessages";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandLoading } from "./Command";
import { formControlBase, formControlSizes, type FormSize } from "./Input";
import { Popover, PopoverContent, PopoverTrigger } from "./Tooltip";
import { cn } from "./utils";

interface ComboboxSource<T> {
    /** The full list, filtered as the user types. */
    options?: T[];
    /** Or ask for the matches of what the user typed — a server autocomplete. */
    onSearch?: (query: string, signal: AbortSignal) => Promise<T[]>;
    /** Wait this long after the last keystroke before searching (default 200 ms). */
    searchDelay?: number;
    getKey: (item: T) => string;
    /** The text an item is shown and filtered by. */
    getLabel: (item: T) => string;
    /** A richer rendering in the list; defaults to the label. */
    renderItem?: (item: T) => React.ReactNode;
}

function useMatches<T>(src: ComboboxSource<T>, open: boolean): { query: string, setQuery: (q: string) => void, items: T[], loading: boolean } {
    const [query, setQuery] = React.useState("");
    const [found, setFound] = React.useState<T[]>([]);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        if (!open || src.onSearch == null)
            return;
        const abort = new AbortController();
        setLoading(true);
        const timer = window.setTimeout(() => {
            src.onSearch!(query, abort.signal)
                .then(r => { if (!abort.signal.aborted) setFound(r); })
                .finally(() => { if (!abort.signal.aborted) setLoading(false); });
        }, src.searchDelay ?? 200);
        return () => { abort.abort(); window.clearTimeout(timer); };
    }, [open, query]);

    React.useEffect(() => { if (!open) setQuery(""); }, [open]);

    return { query, setQuery, items: src.onSearch ? found : src.options ?? [], loading };
}

const triggerClass = "flex items-center justify-between gap-2 text-start cursor-pointer";

export interface ComboboxProps<T> extends ComboboxSource<T> {
    value: T | null | undefined;
    onChange: (item: T | null) => void;
    placeholder?: string;
    /** Offers a way back to no value. */
    allowClear?: boolean;
    size?: FormSize;
    disabled?: boolean;
    id?: string;
    className?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-invalid"?: boolean;
    "aria-required"?: boolean;
}

/** A searchable single choice: react-widgets' `DropdownList filter` and `Combobox`. */
export function Combobox<T>(p: ComboboxProps<T>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const m = useMatches(p, open);
    const size = p.size ?? "md";

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild disabled={p.disabled}>
                <button type="button" role="combobox" aria-expanded={open} id={p.id}
                    aria-label={p["aria-label"]} aria-labelledby={p["aria-labelledby"]} aria-invalid={p["aria-invalid"]} aria-required={p["aria-required"]}
                    className={cn("sf-combobox sf-form-select", formControlBase, formControlSizes[size], triggerClass, p.className)}>
                    <span className={cn("truncate", p.value == null && "text-muted-foreground")}>
                        {p.value != null ? (p.renderItem ?? p.getLabel)(p.value) : p.placeholder ?? " "}
                    </span>
                    <FontAwesomeIcon icon="chevron-down" className="text-[.75em] opacity-60" aria-hidden={true} />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-[12rem] max-w-none p-0">
                <ComboboxList {...p} m={m} selectedKeys={p.value != null ? [p.getKey(p.value)] : []}
                    extra={p.allowClear && p.value != null
                        ? <CommandItem value="__clear" onSelect={() => { p.onChange(null); setOpen(false); }} aria-label={EntityControlMessage.Remove.niceToString()} className="text-muted-foreground">
                            -
                        </CommandItem>
                        : undefined}
                    onPick={item => { p.onChange(item); setOpen(false); }} />
            </PopoverContent>
        </Popover>
    );
}

export interface MultiComboboxProps<T> extends ComboboxSource<T> {
    value: T[];
    onChange: (items: T[]) => void;
    placeholder?: string;
    size?: FormSize;
    disabled?: boolean;
    id?: string;
    className?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-invalid"?: boolean;
}

/** Several choices shown as removable tags: react-widgets' `Multiselect`. */
export function MultiCombobox<T>(p: MultiComboboxProps<T>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const m = useMatches(p, open);
    const size = p.size ?? "md";
    const keys = p.value.map(p.getKey);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <div className={cn("sf-multi-combobox", formControlBase, formControlSizes[size], "flex flex-wrap items-center gap-1 py-0.5", p.disabled && "bg-muted", p.className)}>
                <ul aria-label={ReactWidgetsMessage.TagsLabel.niceToString()} className="contents">
                    {p.value.map(v =>
                        <li key={p.getKey(v)} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 text-[.875em]">
                            {(p.renderItem ?? p.getLabel)(v)}
                            {!p.disabled &&
                                <button type="button" aria-label={ReactWidgetsMessage.RemoveLabel.niceToString() + " " + p.getLabel(v)}
                                    onClick={() => p.onChange(p.value.filter(x => p.getKey(x) !== p.getKey(v)))}
                                    className="cursor-pointer border-0 bg-transparent p-0 text-inherit opacity-60 hover:opacity-100">
                                    <FontAwesomeIcon icon="xmark" aria-hidden={true} />
                                </button>}
                        </li>)}
                </ul>
                <PopoverTrigger asChild disabled={p.disabled}>
                    <button type="button" role="combobox" aria-expanded={open} id={p.id}
                        aria-label={p["aria-label"]} aria-labelledby={p["aria-labelledby"]} aria-invalid={p["aria-invalid"]}
                        className={cn(triggerClass, "ms-auto min-w-8 flex-1 justify-end border-0 bg-transparent p-0 text-muted-foreground")}>
                        {p.value.length === 0 && <span className="me-auto truncate">{p.placeholder ?? ""}</span>}
                        <FontAwesomeIcon icon="chevron-down" className="text-[.75em] opacity-60" aria-hidden={true} />
                    </button>
                </PopoverTrigger>
            </div>
            <PopoverContent align="start" className="w-[20rem] max-w-none p-0">
                <ComboboxList {...p} m={m} selectedKeys={keys}
                    onPick={item => {
                        const key = p.getKey(item);
                        p.onChange(keys.includes(key) ? p.value.filter(x => p.getKey(x) !== key) : [...p.value, item]);
                    }} />
            </PopoverContent>
        </Popover>
    );
}

interface ComboboxListProps<T> extends ComboboxSource<T> {
    m: ReturnType<typeof useMatches<T>>;
    selectedKeys: string[];
    onPick: (item: T) => void;
    extra?: React.ReactNode;
}

function ComboboxList<T>(p: ComboboxListProps<T>): React.ReactElement {
    return (
        <Command shouldFilter={p.onSearch == null}>
            <CommandInput value={p.m.query} onValueChange={p.m.setQuery} />
            <CommandList>
                {p.m.loading && <CommandLoading>{JavascriptMessage.loading.niceToString()}</CommandLoading>}
                {!p.m.loading && <CommandEmpty>{(p.m.query ? ReactWidgetsMessage.EmptyFilter : ReactWidgetsMessage.EmptyList).niceToString()}</CommandEmpty>}
                {p.extra}
                {p.m.items.map(item => {
                    const key = p.getKey(item);
                    const selected = p.selectedKeys.includes(key);
                    return (
                        <CommandItem key={key} value={key} keywords={[p.getLabel(item)]} onSelect={() => p.onPick(item)} data-checked={selected}>
                            <FontAwesomeIcon icon="check" className={cn("text-[.75em]", !selected && "invisible")} aria-hidden={true} />
                            <span className="truncate">{(p.renderItem ?? p.getLabel)(item)}</span>
                        </CommandItem>
                    );
                })}
            </CommandList>
        </Command>
    );
}
