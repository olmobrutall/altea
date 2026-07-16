export {}; // ensure this file is treated as a module (required for `declare global`)

declare global {

  interface RegExpConstructor {
    escape(str: string): string;
  }
}

RegExp.escape = function (s: string) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};
