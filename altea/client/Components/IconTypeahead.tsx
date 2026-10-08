import * as React from 'react'
import { library, config, type IconName, type IconPrefix } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { classes } from '../../data/globals'
import type { TypeContext } from '../TypeContext'
import { FormGroup } from '../Lines/FormGroup'
import { useForceUpdate } from '../Hooks'
import { Typeahead, type TextHighlighter } from './Typeahead'
import { parseIcon, prefixes as prefixAliases } from './IconHelpers'

// Port of Signum's React/Components/IconTypeahead.tsx — the icon picker: a typeahead over every icon
// registered in the FontAwesome library (with a preview), plus a select for the family when the icon
// exists in more than one. It writes Signum's stored format (see IconHelpers): a bare name for the default
// family, "<long prefix> fa-<name>" otherwise. altea divergence: the parsing lives in IconHelpers.parseIcon,
// shared with every renderer, so this file only reads its result.

export interface IconTypeaheadLineProps {
  ctx: TypeContext<string | null | undefined>;
  onChange?: () => void;
  extraIcons?: string[];
  inputAttrs?: React.InputHTMLAttributes<HTMLInputElement>;
  extraButtons?: () => React.ReactNode;
}

export function IconTypeaheadLine(p: IconTypeaheadLineProps): React.ReactElement {
  const forceUpdate = useForceUpdate();
  function handleChange(newIcon: string | undefined | null) {
    p.ctx.value = newIcon;
    if (p.onChange)
      p.onChange();
    forceUpdate();
  }

  const ctx = p.ctx;

  return (
    <FormGroup ctx={ctx} label={ctx.niceName()}>
      {inputId => <>
        <IconTypeahead icon={ctx.value}
          placeholder={ctx.placeholderLabels ? ctx.niceName() : undefined}
          extraIcons={p.extraIcons}
          formControlClass={ctx.formControlClass}
          inputAttrs={{ id: inputId, disabled: ctx.readOnly, ...p.inputAttrs }}
          onChange={handleChange} />
        {p.extraButtons?.()}
      </>
      }
    </FormGroup>
  );
}

// The library's registry: prefix → icon name → definition. Not in the public typings, read as Signum does.
const lib = library as unknown as { definitions: { [prefix: string]: { [iconName: string]: unknown } } };

function getAllIcons(): IconName[] {
  // Not cached: an icon set registered later (a lazily loaded module's `library.add`) must show up.
  return Object.values(lib.definitions).flatMap(dic => Object.keys(dic)).distinct().orderBy(a => a) as IconName[];
}

function getPrefixes(iconName: string): IconPrefix[] {
  return Object.keys(lib.definitions).filter(prefix => iconName && lib.definitions[prefix]?.[iconName]) as IconPrefix[];
}

function toLongPrefix(prefix: IconPrefix): string | undefined {
  switch (prefix) {
    case "fas": return "fa-solid";
    case "fab": return "fa-brands";
    case "far": return "fa-regular";
    case "fal": return "fa-light";
    case "fat": return "fa-thin";
    case "fad": return "fa-duotone";
    default: return undefined;
  }
}

export interface IconTypeaheadProps {
  icon: string | null | undefined;
  onChange: (newIcon: string | null | undefined) => void;
  extraIcons?: string[];
  formControlClass: string | undefined;
  placeholder?: string;
  inputAttrs?: React.InputHTMLAttributes<HTMLInputElement>;
}

export function IconTypeahead(p: IconTypeaheadProps): React.ReactElement {
  const forceUpdate = useForceUpdate();

  const parsedIcon = parseIcon(p.icon);

  function handleGetItems(query: string): Promise<string[]> {
    if (!query)
      return Promise.resolve([...p.extraIcons ?? []]);

    const words = query.toLowerCase().split(" ");
    const icons = [...p.extraIcons ?? [], ...getAllIcons()];

    const result = icons
      .filter(k => {
        const lk = k.toLowerCase();
        return words.every(w => lk.includes(w));
      })
      .orderBy(a => a.length)
      .filter((k, i) => i < 5);

    return Promise.resolve(result);
  }

  // A name that only exists as a brand needs its family spelled out; any other is stored bare (the default).
  function toValidIcon(iconName: string | null): string | null {
    if (!iconName)
      return null;

    if (p.extraIcons?.includes(iconName))
      return iconName;

    const prefixes = getPrefixes(iconName);
    if (prefixes.length == 0 || prefixes.some(a => a != "fab"))
      return iconName;

    return `${toLongPrefix(prefixes[0])} fa-${iconName}`;
  }

  function handleSelectIcon(item: unknown): string {
    p.onChange(toValidIcon(item as string | null));
    forceUpdate();
    return item as string;
  }

  function handleSelectFamily(e: React.ChangeEvent<HTMLSelectElement>) {
    if (currentIcon == null)
      return;

    const family = e.currentTarget.value;
    p.onChange(family == "" ? currentIcon : `${family} fa-${currentIcon}`);
    forceUpdate();
  }

  function handleRenderItem(item: unknown, hl: TextHighlighter) {
    const icon = parseIcon(toValidIcon(item as string));

    return (
      <span>
        {icon && <FontAwesomeIcon aria-hidden={true} icon={icon} className="icon me-2" style={{ width: "12px", height: "12px" }} />}
        {hl.highlight(item as string)}
      </span>
    );
  }

  // parseIcon gives a bare name (default family) or a [prefix, name] pair.
  const currentPrefix: IconPrefix | "" = Array.isArray(parsedIcon) ? parsedIcon[0] : "";
  const currentIcon: string | null = parsedIcon == null ? null :
    Array.isArray(parsedIcon) ? parsedIcon[1] :
      typeof parsedIcon == "string" ? parsedIcon : parsedIcon.iconName;

  const prefixes = currentIcon ? getPrefixes(currentIcon) : null;
  const hasDefault = prefixes?.some(a => a != "fab");
  const defaultPrefix = prefixAliases[config.styleDefault] ?? config.styleDefault;

  return (
    <div className="row g-2">
      <div className="col-sm-7">
        <Typeahead
          value={currentIcon ?? ""}
          inputAttrs={{ className: classes(p.formControlClass, "sf-entity-autocomplete"), placeholder: p.placeholder, ...p.inputAttrs }}
          getItems={handleGetItems}
          onSelect={handleSelectIcon}
          onChange={handleSelectIcon}
          renderItem={handleRenderItem}
          minLength={0}
        />
      </div>
      <div className="col-sm-5">
        <select className={p.formControlClass?.replaceAll("control", "select")}
          value={currentPrefix && (toLongPrefix(currentPrefix) ?? currentPrefix)}
          disabled={p.inputAttrs?.disabled || !(p.icon && (hasDefault || prefixes != null && prefixes.length > 1))}
          onChange={handleSelectFamily}>
          {hasDefault && <option value="">({toLongPrefix(defaultPrefix) ?? defaultPrefix})</option>}
          {prefixes?.map(prefix => <option key={prefix} value={toLongPrefix(prefix)}>{toLongPrefix(prefix)}</option>)}
        </select>
      </div>
    </div>
  );
}
