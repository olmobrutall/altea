import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { EntityControlMessage, JavascriptMessage, ReactWidgetsMessage } from "../../data/uiMessages";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandLoading } from "./Command";
import { formControlClass, formSelectClass, type FormSize } from "./Input";
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
    /** A richer rendering in the list (the search term, for highlighting); defaults to the label. */
    renderItem?: (item: T, query: string) => React.ReactNode;
    /** Whether an item matches what the user typed. Default: every word of it appears in the label. */
    filter?: (item: T, query: string) => boolean;
    /** Shows the search box (default true). Without it the list is a plain choice. */
    search?: boolean;
}

function defaultFilter<T>(src: ComboboxSource<T>): (item: T, query: string) => boolean {
    return (item, query) => {
        const label = src.getLabel(item).toLowerCase();
        return query.toLowerCase().split(" ").every(part => label.includes(part));
    };
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

    const filter = src.filter ?? defaultFilter(src);
    const items = src.onSearch ? found : (src.options ?? []).filter(i => query === "" || filter(i, query));
    return { query, setQuery, items, loading };
}

export interface ComboboxProps<T> extends ComboboxSource<T> {
    value: T | null | undefined;
    /** `keyboard`: picked with Enter rather than the pointer. */
    onChange: (item: T | null, meta: { keyboard: boolean }) => void;
    /** Shows a busy list (the options are still being fetched). */
    loading?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
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
    title?: string;
    /** The closed combobox's rendering of the value; defaults to `renderItem`, then the label. */
    renderValue?: (item: T) => React.ReactNode;
}

/** A searchable single choice: react-widgets' `DropdownList filter` and `Combobox`. */
export function Combobox<T>(p: ComboboxProps<T>): React.ReactElement {
    const [open, setOpenState] = React.useState(p.defaultOpen ?? false);
    const setOpen = (o: boolean): void => { setOpenState(o); p.onOpenChange?.(o); };
    const m = useMatches(p, open);
    const size = p.size ?? "md";

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild disabled={p.disabled}>
                <button type="button" role="combobox" aria-expanded={open} id={p.id} title={p.title}
                    aria-label={p["aria-label"]} aria-labelledby={p["aria-labelledby"]} aria-invalid={p["aria-invalid"]} aria-required={p["aria-required"]}
                    className={cn("sf-combobox", formSelectClass(size), "text-start cursor-pointer", p.className)}>
                    <span className={cn("block truncate", p.value == null && "text-muted-foreground")}>
                        {p.value != null ? (p.renderValue ? p.renderValue(p.value) : p.renderItem ? p.renderItem(p.value, "") : p.getLabel(p.value)) : p.placeholder ?? " "}
                    </span>
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-[12rem] max-w-none p-0">
                <ComboboxList {...p} m={m} selectedKeys={p.value != null ? [p.getKey(p.value)] : []}
                    extra={p.allowClear && p.value != null
                        ? <CommandItem value="__clear" onSelect={() => { p.onChange(null, { keyboard: false }); setOpen(false); }} aria-label={EntityControlMessage.Remove.niceToString()} className="text-muted-foreground">
                            -
                        </CommandItem>
                        : undefined}
                    onPick={(item, keyboard) => { p.onChange(item, { keyboard }); setOpen(false); }} />
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
            <div className={cn("sf-multi-combobox", formControlClass(size), "flex flex-wrap items-center gap-1 py-0.5", p.disabled && "bg-muted", p.className)}>
                <ul aria-label={ReactWidgetsMessage.TagsLabel.niceToString()} className="contents">
                    {p.value.map(v =>
                        <li key={p.getKey(v)} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 text-[.875em]">
                            {p.renderItem ? p.renderItem(v, "") : p.getLabel(v)}
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
                        className="ms-auto flex min-w-8 flex-1 cursor-pointer items-center justify-end gap-2 border-0 bg-transparent p-0 text-start text-muted-foreground">
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
    onPick: (item: T, keyboard: boolean) => void;
    loading?: boolean;
    extra?: React.ReactNode;
}

function ComboboxList<T>(p: ComboboxListProps<T>): React.ReactElement {
    const rootRef = React.useRef<HTMLDivElement>(null);
    const enterPressed = React.useRef(false);
    // Without a search box nothing in the list takes the focus, and cmdk reads the arrow keys on its root.
    React.useEffect(() => { if (p.search === false) rootRef.current?.focus(); }, []);
    return (
        <Command shouldFilter={false} ref={rootRef} tabIndex={p.search === false ? -1 : undefined} className="outline-none"
            onKeyDownCapture={e => { enterPressed.current = e.key === "Enter"; }}>
            {p.search !== false && <CommandInput value={p.m.query} onValueChange={p.m.setQuery} />}
            <CommandList>
                {(p.m.loading || p.loading) && <CommandLoading>{JavascriptMessage.loading.niceToString()}</CommandLoading>}
                {!p.m.loading && !p.loading && <CommandEmpty>{(p.m.query ? ReactWidgetsMessage.EmptyFilter : ReactWidgetsMessage.EmptyList).niceToString()}</CommandEmpty>}
                {p.extra}
                {p.m.items.map(item => {
                    const key = p.getKey(item);
                    const selected = p.selectedKeys.includes(key);
                    return (
                        <CommandItem key={key} value={key} onSelect={() => { p.onPick(item, enterPressed.current); enterPressed.current = false; }} data-checked={selected}>
                            <FontAwesomeIcon icon="check" className={cn("text-[.75em]", !selected && "invisible")} aria-hidden={true} />
                            <span className="truncate">{p.renderItem ? p.renderItem(item, p.m.query) : p.getLabel(item)}</span>
                        </CommandItem>
                    );
                })}
            </CommandList>
        </Command>
    );
}
