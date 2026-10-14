// altea replacement for Signum's ConfigureReactWidgets.tsx. Signum built a react-widgets
// DateLocalizer<string> on luxon (format = luxon token strings). altea drops luxon (→ Temporal), so
// the picker's display/parse layer is built on react-widgets' own Intl-based localizer instead, and
// the localizer's format type is `Intl.DateTimeFormatOptions`. This module wires the picker's localizer, maps
// altea/.NET format specifiers to Intl options, supplies the widgets' own message strings, and owns the one
// value boundary the date lines have: a Temporal value ⇄ the JS Date the picker shows, and trimming.
import { DateLocalizer as IntlDateLocalizer, NumberLocalizer as IntlNumberLocalizer } from 'react-widgets-up/IntlLocalizer';
import { Localization } from 'react-widgets-up';
import type { DateLocalizer, NumberLocalizer } from 'react-widgets-up';
import type { UserProvidedMessages } from 'react-widgets-up/messages';
import * as React from 'react';
import { ReactWidgetsMessage } from '../../data/uiMessages';

// react-widgets firstOfWeek is 0=Sunday..6=Saturday; the modern Intl weekInfo.firstDay is
// 1=Monday..7=Sunday, so `% 7` maps Sunday(7)→0 and leaves Mon..Sat as 1..6. Undefined ⇒ let the
// Intl localizer pick its default.
function computeFirstOfWeek(): number | undefined {
  try {
    const loc = new Intl.Locale(new Intl.DateTimeFormat().resolvedOptions().locale) as any;
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay != null)
      return info.firstDay % 7;
  } catch { /* older engines: fall through */ }
  return undefined;
}

export function getDateLocalizer(): DateLocalizer<Intl.DateTimeFormatOptions> {
  return new IntlDateLocalizer({ firstOfWeek: computeFirstOfWeek() }) as DateLocalizer<Intl.DateTimeFormatOptions>;
}

export function getNumberLocalizer(): NumberLocalizer<Intl.NumberFormatOptions> {
  return new IntlNumberLocalizer() as NumberLocalizer<Intl.NumberFormatOptions>;
}

// The third half of <Localization>: the widgets' OWN strings (Signum's ConfigureReactWidgets.getMessages).
// Signum builds this once at boot and wraps the whole router in a single <Localization>; altea wraps each
// widget site instead, so the object is built once HERE and shared — passing the same identity keeps
// react-widgets' useMessagesWithDefaults memo stable across every site.
//
// Every value is a THUNK: react-widgets calls a function message at render time (it only wraps the
// non-function ones), so a label follows the translation blob even though this module is imported long
// before the blob loads. `filterPlaceholder` has no slot in the Messages contract, so it is not passed.
const messages: UserProvidedMessages = {
  moveToday: () => ReactWidgetsMessage.MoveToday.niceToString(),
  moveBack: () => ReactWidgetsMessage.MoveBack.niceToString(),
  moveForward: () => ReactWidgetsMessage.MoveForward.niceToString(),
  dateButton: () => ReactWidgetsMessage.DateButton.niceToString(),
  openCombobox: () => ReactWidgetsMessage.OpenCombobox.niceToString(),
  emptyList: () => ReactWidgetsMessage.EmptyList.niceToString(),
  emptyFilter: () => ReactWidgetsMessage.EmptyFilter.niceToString(),
  createOption: (_value, searchTerm) =>
    !searchTerm ? ReactWidgetsMessage.CreateOption.niceToString() :
      ReactWidgetsMessage.CreateOption0.niceToString().formatHtml(<strong>{'"' + searchTerm + '"'}</strong>),
  tagsLabel: () => ReactWidgetsMessage.TagsLabel.niceToString(),
  removeLabel: () => ReactWidgetsMessage.RemoveLabel.niceToString(),
  noneSelected: () => ReactWidgetsMessage.NoneSelected.niceToString(),
  selectedItems: labels => ReactWidgetsMessage.SelectedItems0.niceToString(labels.join(", ")),
  increment: () => ReactWidgetsMessage.IncrementValue.niceToString(),
  decrement: () => ReactWidgetsMessage.DecrementValue.niceToString(),
};

export function getMessages(): UserProvidedMessages {
  return messages;
}

// ONE provider for the whole application, wrapped around the router — Signum's shape (Southwind's
// MainPublic builds the two localizers at module scope and renders a single `<Localization>` around
// `<RouterProvider>`).
//
// altea used to wrap each widget SITE instead: seven `<Localization>` elements across DateTimeLine,
// EntityCombo, EntityMultiSelect, EnumLine, MultiPropertySetter and QueryTokenBuilder, each with its own
// localizer instances. Nothing was gained by it — every one of those sites built its localizers at module
// scope too, so they were no fresher than a single pair at the root — and it cost a context provider per
// site, duplicate localizer objects, and the standing requirement that anyone adding a react-widgets
// control remember to wrap it or silently get English.
//
// The component lives HERE rather than being assembled in the app, so an application wires the widgets'
// localization with one element and never has to know which three props it takes.
const dateLocalizer = getDateLocalizer();
const numberLocalizer = getNumberLocalizer();

export function ReactWidgetsLocalization({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <Localization date={dateLocalizer} number={numberLocalizer} messages={messages}>
      {children}
    </Localization>
  );
}

export { toDateFormatOptions, dateTimePlaceholder, formatDateValue, dateValueToDate, dateToDateValue, trimDateToFormat, type DateValue } from "../ui/dateFormat";
