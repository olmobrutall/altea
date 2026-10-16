import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Temporal } from "../../data/basics";
import { Alert, AlertTitle } from "./Alert";
import { Badge } from "./Badge";
import { Button, ButtonGroup, type ButtonVariantProps } from "./Button";
import { Calendar } from "./Calendar";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./Card";
import { Checkbox, RadioGroup, RadioGroupItem, Switch } from "./Checkbox";
import { Combobox, MultiCombobox } from "./Combobox";
import { DateTimePicker } from "./DateTimePicker";
import type { DateValue } from "./dateFormat";
import { DropdownButton, DropdownCheckboxItem, DropdownItem, DropdownLabel, DropdownSeparator } from "./Dropdown";
import { Input, InputGroup, InputGroupText, Label, Textarea, type FormSize } from "./Input";
import { Modal } from "./Modal";
import { Progress, Skeleton, Spinner } from "./Progress";
import { Select } from "./Select";
import { Tab, Tabs } from "./Tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Popover, PopoverContent, PopoverTrigger, WithTooltip } from "./Tooltip";
import { setDesign, useDesign } from "./design";

// A development page: the labels are sample text, not messages.

const fruits = ["Apple", "Apricot", "Banana", "Blueberry", "Cherry", "Grape", "Lemon", "Mango", "Orange", "Peach", "Pear", "Plum"];

function searchFruits(query: string, signal: AbortSignal): Promise<string[]> {
    return new Promise(resolve => {
        const t = window.setTimeout(() => resolve(fruits.filter(f => f.toLowerCase().includes(query.toLowerCase()))), 300);
        signal.addEventListener("abort", () => window.clearTimeout(t));
    });
}

function Section(p: { title: string, children: React.ReactNode }): React.ReactElement {
    return (
        <section className="mb-8">
            <h2 className="mb-3 border-b pb-1 text-h4 font-medium">{p.title}</h2>
            {p.children}
        </section>
    );
}

export default function UiKitPage(): React.ReactElement {
    const [theme, setThemeState] = React.useState(() => document.documentElement.dataset.theme ?? "light");
    function setTheme(mode: "light" | "dark"): void {
        // Through the app's ThemeModeSelector, which owns the attributes.
        window.dispatchEvent(new CustomEvent("change-theme-mode", { detail: mode }));
        setThemeState(mode);
    }
    const design = useDesign();

    const [modal, setModal] = React.useState<false | "md" | "lg" | "static">(false);
    const [nested, setNested] = React.useState(false);
    const [exited, setExited] = React.useState(0);
    const [select, setSelect] = React.useState<string | null>("b");
    const [fruit, setFruit] = React.useState<string | null>(null);
    const [server, setServer] = React.useState<string | null>(null);
    const [many, setMany] = React.useState<string[]>(["Apple"]);
    const [day, setDay] = React.useState<Temporal.PlainDate | null>(Temporal.Now.plainDateISO());
    const [date, setDate] = React.useState<DateValue | null>(Temporal.Now.plainDateISO());
    const [dateTime, setDateTime] = React.useState<DateValue | null>(null);
    const [checked, setChecked] = React.useState(true);
    const [tab, setTab] = React.useState("b");
    const [compact, setCompact] = React.useState(false);

    const variants: NonNullable<ButtonVariantProps["variant"]>[] = ["primary", "secondary", "tertiary", "success", "destructive", "warning", "info", "light", "dark", "ghost", "link"];
    const sizes: FormSize[] = ["xs", "sm", "md", "lg"];
    const holiday = Temporal.Now.plainDateISO().with({ day: 12 });

    return (
        <div className="sf-ui-kit mx-auto max-w-[1100px] p-4">
            <div className="mb-6 flex items-center gap-2">
                <h1 className="m-0 me-auto text-display-6 font-light">UI kit</h1>
                <ButtonGroup>
                    <Button variant={theme === "light" ? "primary" : "outline"} size="sm" onClick={() => setTheme("light")}><FontAwesomeIcon icon="sun" /> Light</Button>
                    <Button variant={theme === "dark" ? "primary" : "outline"} size="sm" onClick={() => setTheme("dark")}><FontAwesomeIcon icon="moon" /> Dark</Button>
                </ButtonGroup>
                <ButtonGroup>
                    <Button variant={design === "classic" ? "primary" : "outline"} size="sm" onClick={() => setDesign("classic")}>Classic</Button>
                    <Button variant={design === "modern" ? "primary" : "outline"} size="sm" onClick={() => setDesign("modern")}>Modern</Button>
                </ButtonGroup>
            </div>

            <Section title="Buttons">
                <div className="mb-2 flex flex-wrap gap-2">{variants.map(v => <Button key={v} variant={v}>{v}</Button>)}</div>
                <div className="mb-2 flex flex-wrap gap-2">
                    {(["primary", "secondary", "success", "destructive", "warning", "info", "dark"] as const).map(t => <Button key={t} variant="outline" tone={t}>outline {t}</Button>)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {(["xs", "sm", "md", "lg"] as const).map(s => <Button key={s} size={s}>size {s}</Button>)}
                    <Button size="icon" variant="ghost" aria-label="Settings"><FontAwesomeIcon icon="gear" /></Button>
                    <Button disabled>disabled</Button>
                    <Button asChild variant="link"><a href="#buttons">as a link</a></Button>
                    <ButtonGroup><Button variant="secondary">Left</Button><Button variant="secondary">Middle</Button><Button variant="secondary">Right</Button></ButtonGroup>
                </div>
            </Section>

            <Section title="Badges, alerts, progress">
                <div className="mb-3 flex flex-wrap gap-2">
                    {(["primary", "secondary", "tertiary", "success", "destructive", "warning", "info", "light", "dark"] as const).map(v => <Badge key={v} variant={v}>{v}</Badge>)}
                    <Badge variant="destructive" pill>12</Badge>
                </div>
                <Alert variant="info"><AlertTitle>Heads up</AlertTitle>An informational alert with a <a href="#x" className="font-semibold underline">link</a>.</Alert>
                <Alert variant="warning" onClose={() => { }}>A dismissible warning.</Alert>
                <Alert variant="destructive">Something failed.</Alert>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <Progress value={35} label="35%" />
                    <Progress value={70} variant="success" striped />
                    <Progress value={null} variant="info" />
                </div>
                <div className="mt-3 flex items-center gap-4">
                    <Spinner /> <Spinner size="sm" className="text-primary" /> <Skeleton className="h-4 w-48" />
                </div>
            </Section>

            <Section title="Form controls">
                <div className="mb-3 flex items-center gap-2"><Switch checked={compact} onCheckedChange={setCompact} id="compact" /><Label htmlFor="compact" className="m-0">Read-only and disabled states</Label></div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {sizes.map(s =>
                        <div key={s}>
                            <Label htmlFor={"input-" + s}>Input {s}</Label>
                            <InputGroup size={s}>
                                <InputGroupText>@</InputGroupText>
                                <Input id={"input-" + s} size={s} placeholder="user name" readOnly={compact} />
                                <Button size={s} variant="secondary">Go</Button>
                            </InputGroup>
                        </div>)}
                    <div>
                        <Label htmlFor="notes">Textarea</Label>
                        <Textarea id="notes" rows={3} disabled={compact} defaultValue="Multi-line text" />
                    </div>
                    <div>
                        <Label htmlFor="invalid">Invalid</Label>
                        <Input id="invalid" aria-invalid={true} defaultValue="not an email" />
                        <div className="sf-invalid-feedback mt-1 text-sm text-destructive">Enter a valid email.</div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2"><Checkbox id="c1" checked={checked} onCheckedChange={v => setChecked(v === true)} /><Label htmlFor="c1" className="m-0">Checkbox</Label></div>
                        <div className="flex items-center gap-2"><Checkbox id="c2" checked="indeterminate" /><Label htmlFor="c2" className="m-0">Indeterminate</Label></div>
                        <RadioGroup defaultValue="one" className="flex gap-4">
                            <div className="flex items-center gap-2"><RadioGroupItem value="one" id="r1" /><Label htmlFor="r1" className="m-0">One</Label></div>
                            <div className="flex items-center gap-2"><RadioGroupItem value="two" id="r2" /><Label htmlFor="r2" className="m-0">Two</Label></div>
                        </RadioGroup>
                    </div>
                </div>
            </Section>

            <Section title="Choosing">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div><Label>Select</Label>
                        <Select value={select} onChange={setSelect} aria-label="Select" disabled={compact}
                            options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma", disabled: true }]} /></div>
                    <div><Label>Combobox (local filter)</Label>
                        <Combobox value={fruit} onChange={setFruit} options={fruits} getKey={f => f} getLabel={f => f} allowClear placeholder="Pick a fruit" aria-label="Fruit" disabled={compact} /></div>
                    <div><Label>Combobox (server search)</Label>
                        <Combobox value={server} onChange={setServer} onSearch={searchFruits} getKey={f => f} getLabel={f => f}
                            renderItem={f => <span><FontAwesomeIcon icon="lemon" className="me-2 text-warning" />{f}</span>} aria-label="Fruit from server" disabled={compact} /></div>
                    <div><Label>Multi combobox</Label>
                        <MultiCombobox value={many} onChange={setMany} options={fruits} getKey={f => f} getLabel={f => f} placeholder="Pick fruits" aria-label="Fruits" disabled={compact} /></div>
                </div>
            </Section>

            <Section title="Dates (Temporal)">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_1fr]">
                    <Calendar value={day} onChange={setDay}
                        renderDay={d => Temporal.PlainDate.compare(d, holiday) === 0 ? { className: "sf-holiday text-destructive", title: "Holiday" } : undefined} />
                    <div className="flex flex-col gap-3">
                        <div><Label htmlFor="d1">Date</Label>
                            <DateTimePicker id="d1" value={date} onChange={setDate} type="PlainDate" format={{ dateStyle: "medium" }} disabled={compact} /></div>
                        <div><Label htmlFor="d2">Date and time</Label>
                            <DateTimePicker id="d2" value={dateTime} onChange={setDateTime} type="PlainDateTime" format={{ dateStyle: "medium", timeStyle: "short" }} size="sm" /></div>
                        <div className="text-sm text-muted-foreground">
                            Calendar: {day?.toString() ?? "—"} · Date: {date?.toString() ?? "—"} · Date time: {dateTime?.toString() ?? "—"}
                        </div>
                    </div>
                </div>
            </Section>

            <Section title="Overlays">
                <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => setModal("md")}>Modal</Button>
                    <Button variant="secondary" onClick={() => setModal("lg")}>Large modal</Button>
                    <Button variant="tertiary" onClick={() => setModal("static")}>Static backdrop</Button>
                    <span className="text-sm text-muted-foreground">onExited fired {exited}×</span>
                    <DropdownButton title="Dropdown" variant="secondary">
                        <DropdownLabel>Actions</DropdownLabel>
                        <DropdownItem onClick={() => { }}><FontAwesomeIcon icon="pen" className="me-2" />Edit</DropdownItem>
                        <DropdownItem active>Current choice</DropdownItem>
                        <DropdownCheckboxItem checked={checked} onCheckedChange={setChecked}>Checked</DropdownCheckboxItem>
                        <DropdownSeparator />
                        <DropdownItem disabled>Disabled</DropdownItem>
                    </DropdownButton>
                    <WithTooltip tooltip="A tooltip"><Button variant="outline">Hover me</Button></WithTooltip>
                    <Popover>
                        <PopoverTrigger asChild><Button variant="outline" tone="info">Popover</Button></PopoverTrigger>
                        <PopoverContent title="Popover title" arrow>Some content in the popover body.</PopoverContent>
                    </Popover>
                </div>

                <Modal show={modal !== false} size={modal === "lg" ? "lg" : "md"} backdrop={modal === "static" ? "static" : true}
                    onHide={() => setModal(false)} onExited={() => setExited(n => n + 1)}>
                    <Modal.Header closeButton><Modal.Title>A {modal} modal</Modal.Title></Modal.Header>
                    <Modal.Body>
                        <p>Escape{modal === "static" ? "" : ", the backdrop"} or the × close it. Tab stays inside.</p>
                        <Combobox value={fruit} onChange={setFruit} options={fruits} getKey={f => f} getLabel={f => f} aria-label="Fruit in modal" />
                        <div className="mt-3"><DateTimePicker value={date} onChange={setDate} type="PlainDate" format={{ dateStyle: "medium" }} aria-label="Date in modal" /></div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" onClick={() => setNested(true)}>Open another</Button>
                        <Button onClick={() => setModal(false)}>OK</Button>
                    </Modal.Footer>
                </Modal>
                <Modal show={nested} size="sm" onHide={() => setNested(false)}>
                    <Modal.Header closeButton><Modal.Title>Nested</Modal.Title></Modal.Header>
                    <Modal.Body>A modal over a modal.</Modal.Body>
                    <Modal.Footer><Button onClick={() => setNested(false)}>Close</Button></Modal.Footer>
                </Modal>
            </Section>

            <Section title="Tabs, cards, collapsible">
                <Tabs id="kit-tabs" activeKey={tab} onSelect={setTab} mountOnEnter>
                    <Tab eventKey="a" title="First"><div className="p-3">First panel.</div></Tab>
                    <Tab eventKey="b" title="Second"><div className="p-3">Second panel (active).</div></Tab>
                    <Tab eventKey="c" title={<span><FontAwesomeIcon icon="star" /> With icon</span>}><div className="p-3">Third panel.</div></Tab>
                    <Tab eventKey="d" title="Disabled" disabled><div /></Tab>
                </Tabs>
                <div className="my-4"><Tabs variant="pills" defaultActiveKey="x">
                    <Tab eventKey="x" title="Pill one"><div className="p-3">Pills.</div></Tab>
                    <Tab eventKey="y" title="Pill two"><div className="p-3">Second pill.</div></Tab>
                </Tabs></div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Card>
                        <CardHeader>Header</CardHeader>
                        <CardContent><CardTitle>Card title</CardTitle><CardDescription>Card description text.</CardDescription></CardContent>
                        <CardFooter className="text-sm text-muted-foreground">Footer</CardFooter>
                    </Card>
                    <Collapsible className="rounded-md border-1 p-3">
                        <CollapsibleTrigger asChild><Button variant="link" className="p-0">Toggle details</Button></CollapsibleTrigger>
                        <CollapsibleContent><p className="mt-2 mb-0">Hidden until expanded.</p></CollapsibleContent>
                    </Collapsible>
                </div>
            </Section>
        </div>
    );
}
