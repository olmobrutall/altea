#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// altea-cli-utils/dist/ApplicationContext.js
import * as fs from "node:fs";
import * as path from "node:path";
var ApplicationContext = class _ApplicationContext {
  rootFolder;
  /** The application's directory name, which is also its package name — `eastwind`, or what it became. */
  applicationName;
  constructor(rootFolder, applicationName) {
    this.rootFolder = rootFolder;
    this.applicationName = applicationName;
  }
  /** Walk up from `from` for the workspace root, then read the application out of it. */
  static createFromDirectory(from = process.cwd()) {
    const rootFolder = _ApplicationContext.findRootFolder(from);
    return new _ApplicationContext(rootFolder, _ApplicationContext.findApplicationName(rootFolder));
  }
  static findRootFolder(from) {
    let directory = path.resolve(from);
    for (; ; ) {
      if (fs.existsSync(path.join(directory, "pnpm-workspace.yaml")) && fs.existsSync(path.join(directory, "altea")))
        return directory;
      const parent = path.dirname(directory);
      if (parent === directory)
        throw new Error(`Unable to detect the root folder: no ancestor of ${from} holds both pnpm-workspace.yaml and altea/.`);
      directory = parent;
    }
  }
  /**
   * The one workspace entry that is not a framework package. A workspace with several would be a
   * monorepo of applications, which these tools have no way to choose between — so it says so rather
   * than picking the first.
   */
  static findApplicationName(rootFolder) {
    const entries = _ApplicationContext.workspacePackages(rootFolder).filter((e) => !e.startsWith("altea/") && e !== "altea");
    if (entries.length === 0)
      throw new Error("pnpm-workspace.yaml lists no application package (every entry is under altea/).");
    if (entries.length > 1)
      throw new Error(`pnpm-workspace.yaml lists several application packages (${entries.join(", ")}); these tools work on one application at a time.`);
    return entries[0].replace(/\/$/, "");
  }
  /**
   * The entries under `packages:` — and only those. The file has other top-level LISTS
   * (`publicHoistPattern`), and reading every `- x` in it took `*eslint*` and `typescript` for
   * applications.
   */
  static workspacePackages(rootFolder) {
    const lines = fs.readFileSync(path.join(rootFolder, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
    const start = lines.findIndex((l) => /^packages\s*:/.test(l));
    if (start < 0)
      throw new Error("pnpm-workspace.yaml has no `packages:` list.");
    const result = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "" || line.trimStart().startsWith("#"))
        continue;
      const item = /^\s+-\s*(\S+)\s*$/.exec(line);
      if (item == null)
        break;
      result.push(item[1].replace(/^["']|["']$/g, ""));
    }
    return result;
  }
  // ---- paths -------------------------------------------------------------------------------------
  /** A repository-root-relative path made absolute, with `eastwind` substituted for this application. */
  absolutePath(name) {
    return path.join(this.rootFolder, this.replaceApplicationName(name));
  }
  /** `eastwind` → this application's name, in every casing — see {@link rename}. */
  replaceApplicationName(value) {
    return _ApplicationContext.rename(value, "eastwind", this.applicationName);
  }
  /** The application's own directory, absolute. */
  get applicationDirectory() {
    return path.join(this.rootFolder, this.applicationName);
  }
  /**
   * The casing-aware substitution, shared with the project copier.
   *
   * Signum does three — the exact spelling, all-lower and all-upper — and that is enough there because
   * its application name is already PascalCase (`Southwind` / `southwind` / `SOUTHWIND` covers every
   * form in its sources). altea's is a package name, so it is LOWER case, and the three collapse to two:
   * `Eastwind` was left untouched in `EastwindBrowser`, `EastwindEnvironment`, `Eastwind.es.xml` and
   * every message key that embeds it.
   *
   * So: UPPER, Title, lower, in that order. Order matters — the first two produce text that no longer
   * contains the lower-case form, so the last pass cannot re-replace what they just wrote.
   */
  static rename(value, from, to) {
    const title = (v) => v.charAt(0).toUpperCase() + v.slice(1);
    return value.split(from.toUpperCase()).join(to.toUpperCase()).split(title(from.toLowerCase())).join(title(to.toLowerCase())).split(from.toLowerCase()).join(to.toLowerCase());
  }
};

// altea-cli-utils/dist/Console.js
import * as readline from "node:readline";
var enabled = process.stdout.isTTY === true && process.env["NO_COLOR"] == void 0 && process.env["TERM"] !== "dumb";
var sgr = (code) => (text) => enabled ? `\x1B[${code}m${text}\x1B[0m` : text;
var Color = {
  white: sgr("97"),
  gray: sgr("90"),
  darkGray: sgr("90"),
  green: sgr("92"),
  darkGreen: sgr("32"),
  yellow: sgr("93"),
  darkYellow: sgr("33"),
  red: sgr("91"),
  darkRed: sgr("31"),
  magenta: sgr("95"),
  blue: sgr("94"),
  cyan: sgr("96")
};
var Console;
(function(Console2) {
  function isInteractive() {
    return process.stdin.isTTY === true;
  }
  Console2.isInteractive = isInteractive;
  function width() {
    return process.stdout.columns ?? 100;
  }
  Console2.width = width;
  function writeLine(text = "") {
    process.stdout.write(text + "\n");
  }
  Console2.writeLine = writeLine;
  function write(text) {
    process.stdout.write(text);
  }
  Console2.write = write;
  function writeColor(style, text) {
    process.stdout.write(style(text));
  }
  Console2.writeColor = writeColor;
  function writeLineColor(style, text) {
    process.stdout.write(style(text) + "\n");
  }
  Console2.writeLineColor = writeLineColor;
  function banner(text) {
    const line = `------- ${text} `;
    writeLine(line.padEnd(Math.max(line.length, width() - 2), "-"));
  }
  Console2.banner = banner;
  async function ask(question) {
    const answer = (await askString(`${question} (y/n) `)).toLowerCase();
    return answer === "y" || answer === "yes";
  }
  Console2.ask = ask;
  async function askOptions(question, ...options) {
    for (; ; ) {
      const answer = (await askString(`${question} (${options.join("/")}) `)).toLowerCase();
      if (answer === "")
        return void 0;
      const exact = options.find((o) => o.toLowerCase() === answer);
      if (exact != void 0)
        return exact;
      const byPrefix = options.filter((o) => o.toLowerCase().startsWith(answer));
      if (byPrefix.length === 1)
        return byPrefix[0];
      writeLineColor(Color.red, `'${answer}' is not one of ${options.join(", ")}`);
    }
  }
  Console2.askOptions = askOptions;
  async function askString(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    handleSigInt(rl);
    try {
      return await new Promise((resolve3) => rl.question(question, resolve3));
    } finally {
      rl.close();
    }
  }
  Console2.askString = askString;
  function handleSigInt(rl) {
    rl.once("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      if (process.listenerCount("SIGINT") > 0)
        process.emit("SIGINT");
      else
        process.exit(130);
    });
  }
  Console2.handleSigInt = handleSigInt;
})(Console || (Console = {}));

// altea-cli-utils/dist/Git.js
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, statSync } from "node:fs";
import { join as join2 } from "node:path";
var Git;
(function(Git2) {
  function run(cwd, args2) {
    const r = spawnSync("git", args2, { cwd, encoding: "utf8" });
    if (r.error != null)
      throw new Error(`git ${args2.join(" ")} could not be started: ${r.error.message}. Is git on PATH?`);
    return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
  }
  Git2.run = run;
  function must(cwd, args2) {
    const r = run(cwd, args2);
    if (!r.ok)
      throw new Error(`git ${args2.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  }
  function isRepository(cwd) {
    return run(cwd, ["rev-parse", "--git-dir"]).ok;
  }
  Git2.isRepository = isRepository;
  function isDirtyExceptSubmodules(cwd) {
    return must(cwd, ["status", "--porcelain", "--ignore-submodules=all"]) !== "";
  }
  Git2.isDirtyExceptSubmodules = isDirtyExceptSubmodules;
  function commitAll(cwd, message) {
    must(cwd, ["add", "-A"]);
    if (must(cwd, ["diff", "--cached", "--name-only"]) === "")
      return false;
    must(cwd, ["commit", "-m", message]);
    return true;
  }
  Git2.commitAll = commitAll;
  function init(cwd, initialBranch = "main") {
    must(cwd, ["init", "-b", initialBranch]);
  }
  Git2.init = init;
  function addSubmodule(cwd, url, relativePath) {
    must(cwd, ["submodule", "add", url, relativePath]);
  }
  Git2.addSubmodule = addSubmodule;
  function submoduleUrl(cwd, relativePath) {
    const r = run(cwd, ["config", "--file", ".gitmodules", `submodule.${relativePath}.url`]);
    return r.ok && r.stdout !== "" ? r.stdout : void 0;
  }
  Git2.submoduleUrl = submoduleUrl;
  function submoduleCommit(cwd, relativePath) {
    const r = run(cwd, ["rev-parse", "HEAD"]);
    return r.ok && r.stdout !== "" ? r.stdout : void 0;
  }
  Git2.submoduleCommit = submoduleCommit;
  function tryCheckout(cwd, commit) {
    return run(cwd, ["checkout", "--detach", commit]).ok;
  }
  Git2.tryCheckout = tryCheckout;
  function fetchFrom(cwd, source, commit) {
    return run(cwd, ["fetch", "--no-tags", source, commit]).ok;
  }
  Git2.fetchFrom = fetchFrom;
  async function waitForCleanTree(cwd, action = "Commit or reset them") {
    for (; ; ) {
      if (!isDirtyExceptSubmodules(cwd))
        return;
      const dirty = run(cwd, ["status", "--porcelain", "--ignore-submodules=all"]).stdout;
      if (!Console.isInteractive())
        throw new Error(`The git repo has uncommitted changes, and there is no console to resolve them on:
${dirty}`);
      Console.writeLine();
      Console.writeLineColor(Color.yellow, `There are changes in the git repo:
${dirty}`);
      Console.writeLineColor(Color.yellow, `${action}, then press [Enter].`);
      await Console.askString("");
    }
  }
  Git2.waitForCleanTree = waitForCleanTree;
  function trackedFiles(cwd, pathspec) {
    return list(cwd, ["ls-files", "-z"], pathspec);
  }
  Git2.trackedFiles = trackedFiles;
  function untrackedFiles(cwd, pathspec) {
    return list(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], pathspec);
  }
  Git2.untrackedFiles = untrackedFiles;
  function ignoredFiles(cwd, pathspec) {
    return list(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], pathspec);
  }
  Git2.ignoredFiles = ignoredFiles;
  function isGitlink(cwd, relativePath) {
    const full = join2(cwd, relativePath);
    return existsSync2(full) && statSync(full).isDirectory();
  }
  Git2.isGitlink = isGitlink;
  function list(cwd, args2, pathspec) {
    const full = pathspec == void 0 ? args2 : [...args2, "--", pathspec];
    return must(cwd, full).split("\0").filter((p) => p !== "");
  }
})(Git || (Git = {}));

// altea-cli-utils/dist/Prompt.js
import * as readline2 from "node:readline";
var Prompt;
(function(Prompt2) {
  async function multiSelect(title, choices) {
    if (!Console.isInteractive()) {
      Console.writeLineColor(Color.yellow, "Not an interactive console \u2014 using the default selection.");
      return choices.filter((c) => c.selected).map((c) => c.value);
    }
    for (const c of choices)
      if (!c.selected)
        cascade(choices, c);
    const rl = readline2.createInterface({ input: process.stdin, output: process.stdout });
    Console.handleSigInt(rl);
    try {
      for (; ; ) {
        draw(title, choices);
        const line = (await question(rl, "Toggle by number or name (comma separated, `a-f` ranges, `all`, `none`); Enter to accept: ")).trim();
        if (line === "")
          return choices.filter((c) => c.selected).map((c) => c.value);
        if (line.toLowerCase() === "q" || line.toLowerCase() === "quit")
          return void 0;
        applyToggles(choices, line);
      }
    } finally {
      rl.close();
    }
  }
  Prompt2.multiSelect = multiSelect;
  function draw(title, choices) {
    Console.writeLine();
    Console.banner(title);
    Console.writeLine();
    const width = String(choices.length).length;
    choices.forEach((c, i) => {
      const box = c.forced === true ? "[-]" : c.selected ? "[x]" : "[ ]";
      const style = c.forced === true ? Color.darkGray : c.selected ? Color.green : Color.darkGray;
      Console.writeColor(style, `  ${String(i + 1).padStart(width)} ${box} ${c.key}`);
      Console.writeLineColor(Color.darkGray, c.description === "" ? "" : `  \u2014 ${c.description}`);
    });
    Console.writeLine();
    const kept = choices.filter((c) => c.selected).length;
    Console.writeLineColor(Color.white, `  Keeping ${kept} of ${choices.length}; removing ${choices.length - kept}.`);
  }
  function applyToggles(choices, line) {
    if (line.toLowerCase() === "all") {
      choices.forEach((c) => {
        if (c.forced !== true)
          c.selected = true;
      });
      return;
    }
    if (line.toLowerCase() === "none") {
      choices.forEach((c) => {
        if (c.forced !== true)
          c.selected = false;
      });
      return;
    }
    for (const token of line.split(/[,\s]+/).filter((t) => t !== "")) {
      const range = /^(\d+)-(\d+)$/.exec(token);
      if (range != null) {
        const from = Number(range[1]), to = Number(range[2]);
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++)
          toggleIndex(choices, i - 1, token);
        continue;
      }
      if (/^\d+$/.test(token)) {
        toggleIndex(choices, Number(token) - 1, token);
        continue;
      }
      const byKey = choices.filter((c) => c.key.toLowerCase() === token.toLowerCase());
      if (byKey.length === 1) {
        toggle(choices, byKey[0], token);
        continue;
      }
      Console.writeLineColor(Color.red, `  '${token}' is not one of the options`);
    }
  }
  function toggleIndex(choices, index, token) {
    if (index < 0 || index >= choices.length) {
      Console.writeLineColor(Color.red, `  '${token}' is out of range`);
      return;
    }
    toggle(choices, choices[index], token);
  }
  function toggle(choices, choice, token) {
    if (choice.forced === true) {
      Console.writeLineColor(Color.yellow, `  '${token}' cannot be changed here (something selected depends on it)`);
      return;
    }
    choice.selected = !choice.selected;
    const changed = cascade(choices, choice);
    if (changed.length > 0)
      Console.writeLineColor(Color.yellow, choice.selected ? `  '${choice.key}' needs ${changed.join(", ")} \u2014 ticked too` : `  ${changed.join(", ")} need${changed.length === 1 ? "s" : ""} '${choice.key}' \u2014 unticked too`);
  }
  function cascade(choices, start) {
    const byKey = new Map(choices.map((c) => [c.key.toLowerCase(), c]));
    const changed = [];
    const pending = [start];
    while (pending.length > 0) {
      const c = pending.pop();
      const next = c.selected ? (c.requires ?? []).map((k) => byKey.get(k.toLowerCase())).filter((r) => r != void 0) : choices.filter((o) => (o.requires ?? []).some((k) => k.toLowerCase() === c.key.toLowerCase()));
      for (const n of next) {
        if (n.forced === true || n.selected === c.selected)
          continue;
        n.selected = c.selected;
        changed.push(n.key);
        pending.push(n);
      }
    }
    return changed;
  }
  async function askValidated(question_, validate, initial) {
    for (; ; ) {
      const answer = initial ?? await Console.askString(question_);
      initial = void 0;
      if (answer === "")
        return void 0;
      const complaint = validate(answer);
      if (complaint == void 0)
        return answer;
      Console.writeLineColor(Color.red, "  " + complaint);
    }
  }
  Prompt2.askValidated = askValidated;
  function question(rl, text) {
    return new Promise((resolve3) => rl.question(text, resolve3));
  }
})(Prompt || (Prompt = {}));

// altea-cli-utils/dist/Arguments.js
function parseArguments(argv) {
  const flags = /* @__PURE__ */ new Set();
  const values = /* @__PURE__ */ new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    const name = a.replace(/^--?/, "");
    const eq = name.indexOf("=");
    if (eq >= 0) {
      values.set(name.slice(0, eq), name.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next != void 0 && !next.startsWith("-")) {
      values.set(name, next);
      i++;
    } else
      flags.add(name);
  }
  return { flags, values, positional };
}

// altea-clone/dist/Clone.js
import * as fs2 from "node:fs";
import * as path2 from "node:path";
var Clone;
(function(Clone2) {
  const NEVER_COPIED = /* @__PURE__ */ new Set([".gitmodules"]);
  async function run(uctx, options = {}) {
    const name = await askName(options.name);
    if (name == void 0)
      return;
    const directory = await askDirectory(options.directory, uctx, options.yes === true);
    if (directory == void 0)
      return;
    const target = path2.resolve(directory, name);
    if (fs2.existsSync(target) && fs2.readdirSync(target).length > 0)
      throw new Error(`${target} already exists and is not empty.`);
    Console.writeLine();
    Console.banner("Clone");
    Console.writeLine(`  from   ${uctx.rootFolder}  (application '${uctx.applicationName}')`);
    Console.writeLine(`  to     ${target}  (application '${name}')`);
    Console.writeLine();
    if (options.dryRun === true) {
      Console.writeLineColor(Color.yellow, "Dry run \u2014 nothing was created.");
      return;
    }
    if (options.yes !== true && !await Console.ask("Create it?"))
      return;
    fs2.mkdirSync(target, { recursive: true });
    Git.init(target);
    Console.writeLineColor(Color.green, "  git init");
    addAlteaSubmodule(uctx, target);
    const copied = copyProject(uctx, target, name);
    Console.writeLineColor(Color.green, `  copied ${copied} files, ${uctx.applicationName} -> ${name}`);
    if (Git.commitAll(target, `Initial commit \u2014 ${name}, from ${uctx.applicationName}`))
      Console.writeLineColor(Color.white, "  initial commit created");
    Console.writeLine();
    Console.writeLineColor(Color.green, `${name} is ready at ${target}`);
    Console.writeLine();
    Console.writeLine("  Next:");
    Console.writeLine(`    cd ${target}`);
    Console.writeLine("    node altea/cli/altea-simplify/bin/altea-simplify.js");
    Console.writeLine("    pnpm install");
    Console.writeLine(`    pnpm --filter ${name} build`);
    Console.writeLine();
    Console.writeLineColor(Color.darkGray, `    Then edit ${name}/.env.local \u2014 the environment files came across, are git-ignored, and still hold the source application's connection strings.`);
  }
  Clone2.run = run;
  async function askName(given) {
    return await Prompt.askValidated("New application name? ", (value) => /^[a-z][a-z0-9]*$/.test(value) ? void 0 : "The name is a package name AND a directory name: lower-case letters and digits, starting with a letter (eastwind, northbreeze, acme).", given);
  }
  async function askDirectory(given, uctx, yes) {
    const parent = path2.dirname(uctx.rootFolder);
    const answer = given ?? await Console.askString(`Parent directory? (Enter for ${parent}) `);
    const directory = answer === "" ? parent : path2.resolve(answer);
    if (!fs2.existsSync(directory)) {
      if (!yes && !await Console.ask(`${directory} does not exist. Create it?`))
        return void 0;
      fs2.mkdirSync(directory, { recursive: true });
    }
    return directory;
  }
  function addAlteaSubmodule(uctx, target) {
    const url = Git.submoduleUrl(uctx.rootFolder, "altea");
    if (url == void 0)
      throw new Error("Could not read altea's submodule url from .gitmodules.");
    const commit = Git.submoduleCommit(path2.join(uctx.rootFolder, "altea"), "altea");
    Git.addSubmodule(target, url, "altea");
    Console.writeLineColor(Color.green, `  git submodule add ${url} altea`);
    if (commit == void 0)
      return;
    const submodule = path2.join(target, "altea");
    if (Git.tryCheckout(submodule, commit)) {
      Console.writeLineColor(Color.darkGray, `    pinned to ${commit.slice(0, 10)}`);
      return;
    }
    if (Git.fetchFrom(submodule, path2.join(uctx.rootFolder, "altea"), commit) && Git.tryCheckout(submodule, commit)) {
      Console.writeLineColor(Color.darkGray, `    pinned to ${commit.slice(0, 10)}`);
      Console.writeLineColor(Color.yellow, "    WARNING: that altea commit is not on the remote \u2014 it was copied from this workspace.");
      Console.writeLineColor(Color.yellow, "             Push altea before anyone else clones the new project.");
      return;
    }
    Console.writeLineColor(Color.yellow, `    WARNING: could not pin altea to ${commit.slice(0, 10)}; it is on its default branch.`);
  }
  function copyProject(uctx, target, name) {
    const root = uctx.rootFolder;
    const files = [
      ...Git.trackedFiles(root),
      ...Git.untrackedFiles(root),
      // The environment files are ignored BY DESIGN and copied anyway: a new project wants the
      // shape of its environment, and they stay ignored there, so they are never in its first
      // commit. A pathspec keeps this from walking node_modules.
      ...Git.ignoredFiles(root, `${uctx.applicationName}/.env*`)
    ];
    let copied = 0;
    for (const relative of new Set(files)) {
      if (NEVER_COPIED.has(relative) || Git.isGitlink(root, relative))
        continue;
      copyFileRenamed(path2.join(root, relative), path2.join(target, ApplicationContext.rename(relative, uctx.applicationName, name)), uctx.applicationName, name);
      copied++;
    }
    return copied;
  }
  function copyFileRenamed(source, destination, from, to) {
    fs2.mkdirSync(path2.dirname(destination), { recursive: true });
    const raw = fs2.readFileSync(source);
    if (isBinary(raw)) {
      fs2.writeFileSync(destination, raw);
      return;
    }
    fs2.writeFileSync(destination, ApplicationContext.rename(raw.toString("utf8"), from, to), "utf8");
  }
  function isBinary(buffer) {
    return buffer.subarray(0, 8e3).includes(0);
  }
})(Clone || (Clone = {}));

// altea-clone/dist/main.js
var args = parseArguments(process.argv.slice(2));
try {
  if (args.flags.has("help") || args.flags.has("h")) {
    usage();
  } else {
    Console.writeLine();
    Console.writeLine("  ..:: altea clone ::..");
    Console.writeLine();
    const uctx = ApplicationContext.createFromDirectory();
    Console.write("  root         ");
    Console.writeLineColor(Color.darkGray, uctx.rootFolder);
    Console.write("  application  ");
    Console.writeLineColor(Color.darkGray, uctx.applicationName);
    await Clone.run(uctx, {
      name: args.values.get("name") ?? args.positional[0],
      directory: args.values.get("directory") ?? args.positional[1],
      dryRun: args.flags.has("dry-run"),
      yes: args.flags.has("yes") || args.flags.has("y")
    });
  }
  process.exit(0);
} catch (e) {
  Console.writeLine();
  Console.writeLineColor(Color.red, `[FAILED] ${e.message}`);
  if (process.env["ALTEA_UPGRADE_STACK"] === "1")
    Console.writeLineColor(Color.darkGray, e.stack ?? "");
  process.exit(1);
}
function usage() {
  Console.writeLine(`
  altea-clone [--name <name>] [--directory <path>] [options]

  Copies this application into <directory>/<name>: a fresh git repository, the altea submodule pinned to
  the same commit this workspace has, and the application renamed in file names and in content. Asks for
  anything not given.

  Options:
    --name <name>       the new application's name (lower-case; a package AND a directory name)
    --directory <path>  where to create it; defaults to this workspace's parent
    --dry-run           print what would happen and create nothing
    --yes, -y           skip the confirmation (for a scripted run)

  Environment:
    ALTEA_UPGRADE_STACK=1  print a stack trace on failure
`);
}
