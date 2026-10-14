import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Temporal } from "../../data/basics";
import { Clock } from "../../data/utils/clock";
import { ReactWidgetsMessage } from "../../data/uiMessages";
import { Calendar, type DayRender } from "./Calendar";
import { dateTimePlaceholder, formatDateValue, parseDateText, type DateValue } from "./dateFormat";
import { Input, InputGroup, formControlSizes, type FormSize } from "./Input";
import { Popover, PopoverAnchor, PopoverContent } from "./Tooltip";
import { cn } from "./utils";

export interface DateTimePickerProps {
    /** A PlainDateTime is in the Clock's frame; the picker shows it in the user's. */
    value: DateValue | null | undefined;
    onChange: (value: DateValue | null) => void;
    type: "PlainDate" | "PlainDateTime";
    /** How the value is shown and how typed text is read. */
    format: Intl.DateTimeFormatOptions;
    min?: Temporal.PlainDate;
    max?: Temporal.PlainDate;
    renderDay?: (date: Temporal.PlainDate) => DayRender | undefined;
    size?: FormSize;
    disabled?: boolean;
    readOnly?: boolean;
    placeholder?: string;
    id?: string;
    className?: string;
    inputClassName?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
    "aria-required"?: boolean;
}

/** A date / date-time field: type it in the culture's format, or pick it from the calendar. */
export function DateTimePicker(p: DateTimePickerProps): React.ReactElement {
    const size = p.size ?? "md";
    const [open, setOpen] = React.useState(false);
    const [text, setText] = React.useState<string | null>(null);
    const [invalid, setInvalid] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);

    const shown = p.value == null ? "" : formatDateValue(p.value, p.format);
    const uiValue = p.value == null ? null
        : p.value instanceof Temporal.PlainDate ? p.value : Clock.toUserInterface(p.value);
    const day = uiValue == null ? null : uiValue instanceof Temporal.PlainDate ? uiValue : uiValue.toPlainDate();

    function commitText(): void {
        if (text == null)
            return;
        if (text.trim() === "") {
            setInvalid(false);
            p.onChange(null);
        } else {
            const parsed = parseDateText(text, p.format, p.type, Temporal.Now.plainDateISO());
            setInvalid(parsed == null);
            if (parsed == null)
                return;
            p.onChange(parsed);
        }
        setText(null);
    }

    function pickDay(d: Temporal.PlainDate): void {
        setText(null);
        setInvalid(false);
        if (p.type === "PlainDate")
            p.onChange(d);
        else {
            const time = uiValue instanceof Temporal.PlainDateTime ? uiValue.toPlainTime() : Temporal.PlainTime.from("00:00");
            p.onChange(Clock.fromUserInterface(d.toPlainDateTime(time)));
        }
        if (p.type === "PlainDate") {
            setOpen(false);
            inputRef.current?.focus();
        }
    }

    function pickTime(value: string): void {
        if (value === "")
            return;
        const base = day ?? Temporal.Now.plainDateISO();
        p.onChange(Clock.fromUserInterface(base.toPlainDateTime(Temporal.PlainTime.from(value))));
    }

    const editable = !p.disabled && !p.readOnly;
    const showSeconds = p.format.second != null || p.format.timeStyle === "medium" || p.format.timeStyle === "long";

    return (
        <Popover open={open && editable} onOpenChange={setOpen}>
            <PopoverAnchor asChild>
                <InputGroup size={size} className={cn("sf-date-time-picker", p.className)}>
                    <Input ref={inputRef} id={p.id} size={size} className={p.inputClassName}
                        value={text ?? shown}
                        placeholder={p.placeholder ?? dateTimePlaceholder(p.format)}
                        disabled={p.disabled} readOnly={p.readOnly}
                        aria-label={p["aria-label"]} aria-labelledby={p["aria-labelledby"]} aria-describedby={p["aria-describedby"]}
                        aria-required={p["aria-required"]} aria-invalid={invalid || p["aria-invalid"] || undefined}
                        onChange={e => setText(e.currentTarget.value)}
                        onBlur={commitText}
                        onKeyDown={e => {
                            if (e.key === "Enter") commitText();
                            else if (e.key === "ArrowDown" && e.altKey) { e.preventDefault(); setOpen(true); }
                        }} />
                    {editable &&
                        <button type="button" tabIndex={-1} aria-label={ReactWidgetsMessage.DateButton.niceToString()} title={ReactWidgetsMessage.DateButton.niceToString()}
                            onClick={() => setOpen(!open)}
                            className={cn("sf-date-button inline-flex cursor-pointer items-center border-1 border-input bg-muted text-foreground hover:bg-accent", formControlSizes[size])}>
                            <FontAwesomeIcon icon={["far", "calendar"]} aria-hidden={true} />
                        </button>}
                </InputGroup>
            </PopoverAnchor>
            <PopoverContent align="start" className="w-auto max-w-none border-0 bg-transparent p-0 shadow-none"
                onOpenAutoFocus={e => e.preventDefault()}>
                <div className="rounded-md bg-popover shadow-md">
                    <Calendar value={day} onChange={pickDay} min={p.min} max={p.max} renderDay={p.renderDay} autoFocus
                        className={p.type === "PlainDateTime" ? "rounded-b-none border-b-0" : undefined} />
                    {p.type === "PlainDateTime" &&
                        <div className="rounded-b-md border-1 border-t-0 bg-popover px-2 pb-2">
                            <Input type="time" size="sm" step={showSeconds ? 1 : 60}
                                aria-label={p["aria-label"]}
                                value={uiValue instanceof Temporal.PlainDateTime ? uiValue.toPlainTime().toString({ smallestUnit: showSeconds ? "second" : "minute" }) : ""}
                                onChange={e => pickTime(e.currentTarget.value)} />
                        </div>}
                </div>
            </PopoverContent>
        </Popover>
    );
}
