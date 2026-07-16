export {}; // ensure this file is treated as a module (required for `declare global`)

declare global {

  interface String {
    contains(this: string, str: string): boolean;
    startsWith(this: string, str: string): boolean;
    endsWith(this: string, str: string): boolean;
    /** SQL LIKE: `%` matches any run of characters, `_` a single one. In a query
     *  this lowers to a LIKE predicate; in memory it falls back to a regex. */
    like(this: string, pattern: string): boolean;
    /** First `numChars` characters (SQL LEFT). */
    start(this: string, numChars: number): string;
    /** Last `numChars` characters (SQL RIGHT). */
    end(this: string, numChars: number): string;
    /** The string reversed (SQL REVERSE). */
    reverse(this: string): string;
    /** The string repeated `times` times (SQL REPLICATE / repeat). */
    replicate(this: string, times: number): string;
    formatWith(this: string, ...parameters: any[]): string;
    splitByRegex(this: string, regex: RegExp): { isMatch: boolean, value: string }[];
    forGenderAndNumber(this: string, number: number): string;
    forGenderAndNumber(this: string, gender: string | undefined): string;
    forGenderAndNumber(this: string, gender: any, number?: number): string;
    indent(this: string, numChars: number): string;
    between(this: string, separator: string): string;
    between(this: string, firstSeparator: string, secondSeparator: string): string;
    tryBetween(this: string, separator: string): string | undefined;
    tryBetween(this: string, firstSeparator: string, secondSeparator: string): string | undefined;
    after(this: string, separator: string): string;
    before(this: string, separator: string): string;
    tryAfter(this: string, separator: string): string | undefined;
    tryBefore(this: string, separator: string): string | undefined;
    afterLast(this: string, separator: string): string;
    beforeLast(this: string, separator: string): string;
    tryAfterLast(this: string, separator: string): string | undefined;
    tryBeforeLast(this: string, separator: string): string | undefined;
    etc(this: string, maxLength: number, etcString?: string): string;

    firstUpper(this: string): string;
    firstLower(this: string,): string;

    repeat(this: string, n: number): string;
  }
}

if (!String.prototype.includes) {
  String.prototype.includes = function (this: string, str: string, start?: number) {
    return this.indexOf(str, start) !== -1;
  };
}

String.prototype.contains = function (this: string, str: string) {
  return this.indexOf(str) !== -1;
}

String.prototype.startsWith = function (this: string, str: string) {
  return this.indexOf(str) === 0;
}

String.prototype.endsWith = function (this: string, str: string) {
  const index = this.lastIndexOf(str);
  return index !== -1 && index === (this.length - str.length); //keep it
}

String.prototype.like = function (this: string, pattern: string) {
  // SQL LIKE → regex: escape regex metachars, then map the LIKE wildcards
  // (% → .*, _ → .). Anchored, case-sensitive (matching the SQL path).
  const regex = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${regex}$`).test(this);
}

String.prototype.start = function (this: string, numChars: number) {
  return this.substring(0, numChars);
}

String.prototype.end = function (this: string, numChars: number) {
  return this.substring(this.length - numChars);
}

String.prototype.reverse = function (this: string) {
  return this.split("").reverse().join("");
}

String.prototype.replicate = function (this: string, times: number) {
  return this.repeat(times);
}

String.prototype.formatWith = function () {
  const regex = /\{([\w-]+)(?:\:([\w\.]*)(?:\((.*?)?\))?)?\}/g;

  const args: any = arguments;

  return (this as string).replace(regex, match => {
    //match will look like {sample-match}
    //key will be 'sample-match';
    const key = match.substr(1, match.length - 2);

    return args[key];
  });
};

String.prototype.splitByRegex = function splitByRegex(this: string, regex: RegExp): { isMatch: boolean, value: string }[] {
  const result: { isMatch: boolean, value: string }[] = [];
  let lastIndex = 0;

  // Iterate over matches
  for (const match of this.matchAll(regex)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    // Add the non-matching part before this match
    if (lastIndex < matchStart) {
      result.push({ isMatch: false, value: this.slice(lastIndex, matchStart) });
    }

    // Add the matching part
    result.push({ isMatch: true, value: match[0] });

    // Update lastIndex
    lastIndex = matchEnd;
  }

  // Add any remaining non-matching part at the end
  if (lastIndex < this.length) {
    result.push({ isMatch: false, value: this.slice(lastIndex) });
  }

  return result;
};

String.prototype.forGenderAndNumber = function (this: string, gender: any, number?: number) {

  if (!number && !isNaN(parseFloat(gender))) {
    number = gender;
    gender = undefined;
  }

  if ((gender == undefined || gender == "") && number == undefined)
    return this;

  function replacePart(textToReplace: string, ...prefixes: string[]): string {
    return textToReplace.replace(/\[[^\]\|]+(\|[^\]\|]+)*\]/g, m => {
      const captures = m.substring(1, m.length - 1).split("|");

      for (let i = 0; i < prefixes.length; i++) {
        const pr = prefixes[i];
        const capture = captures.filter(c => c.startsWith(pr)).firstOrNull();
        if (capture != undefined)
          return capture.substring(pr.length);
      }

      return "";
    });
  }


  if (number == undefined)
    return replacePart(this, gender + ":");

  if (gender == undefined) {
    if (number == 1)
      return replacePart(this, "1:");

    return replacePart(this, number + ":", ":", "");
  }

  if (number == 1)
    return replacePart(this, "1" + gender + ":", "1:");

  return replacePart(this, gender + number + ":", gender + ":", number + ":", ":");


};

String.prototype.indent = function (this: string, numChars: number) {
  const indent = " ".repeat(numChars);
  return this.split("\n").map(a => indent + a).join("\n");
};

String.prototype.between = function (this: string, firstSeparator: string, secondSeparator?: string) {

  if (!secondSeparator)
    secondSeparator = firstSeparator;

  const index = this.indexOf(firstSeparator);
  if (index == -1)
    throw Error("{0} not found".formatWith(firstSeparator));

  var from = index + firstSeparator.length;
  const index2 = this.indexOf(secondSeparator, from);
  if (index2 == -1)
    throw Error("{0} not found".formatWith(secondSeparator));

  return this.substring(from, index2);
};

String.prototype.tryBetween = function (this: string, firstSeparator: string, secondSeparator?: string) {

  if (!secondSeparator)
    secondSeparator = firstSeparator;

  const index = this.indexOf(firstSeparator);
  if (index == -1)
    return undefined;

  var from = index + firstSeparator.length;
  const index2 = this.indexOf(secondSeparator, from);
  if (index2 == -1)
    return undefined;

  return this.substring(from, index2);
};

String.prototype.after = function (this: string, separator: string) {
  const index = this.indexOf(separator);
  if (index == -1)
    throw Error("{0} not found".formatWith(separator));

  return this.substring(index + separator.length);
};

String.prototype.before = function (this: string, separator: string) {
  const index = this.indexOf(separator);
  if (index == -1)
    throw Error("{0} not found".formatWith(separator));

  return this.substring(0, index);
};

String.prototype.tryAfter = function (this: string, separator: string) {
  const index = this.indexOf(separator);
  if (index == -1)
    return undefined;

  return this.substring(index + separator.length);
};

String.prototype.tryBefore = function (this: string, separator: string) {
  const index = this.indexOf(separator);
  if (index == -1)
    return undefined;

  return this.substring(0, index);
};

String.prototype.beforeLast = function (this: string, separator: string) {
  const index = this.lastIndexOf(separator);
  if (index == -1)
    throw Error("{0} not found".formatWith(separator));

  return this.substring(0, index);
};

String.prototype.afterLast = function (this: string, separator: string) {
  const index = this.lastIndexOf(separator);
  if (index == -1)
    throw Error("{0} not found".formatWith(separator));

  return this.substring(index + separator.length);
};

String.prototype.tryBeforeLast = function (this: string, separator: string) {
  const index = this.lastIndexOf(separator);
  if (index == -1)
    return undefined;

  return this.substring(0, index);
};

String.prototype.tryAfterLast = function (this: string, separator: string) {
  const index = this.lastIndexOf(separator);
  if (index == -1)
    return undefined;

  return this.substring(index + separator.length);
};

String.prototype.etc = function (this: string, maxLength: number, etcString: string = "(…)") {
  let str = this;

  if (str.length > maxLength)
    str = str.substr(0, maxLength - etcString.length) + etcString;

  return str;
};

String.prototype.firstUpper = function () {
  return this[0].toUpperCase() + this.substring(1);
};

String.prototype.firstLower = function () {
  return this[0].toLowerCase() + this.substring(1);
};

String.prototype.repeat = function (this: string, n: number) {
  let result = "";
  for (let i = 0; i < n; i++)
    result += this;
  return result;
};
