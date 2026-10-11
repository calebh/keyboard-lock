// Exercises KeyboardLock.jslib against a scripted fake navigator.keyboard and
// document, so each lock() promise can be settled by hand and fullscreen can be
// entered and left without a browser.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const jslib = process.argv[2] ||
    path.join(__dirname, "..", "Runtime", "Plugins", "WebGL", "KeyboardLock.jslib");

// Emscripten expands {{{ makeDynCall(signature, pointer) }}} into a call
// through the wasm function table. Here a "function pointer" is an index into
// `callbacks`.
const MACRO = /\{\{\{\s*makeDynCall\(\s*'\w+'\s*,\s*'(\w+)'\s*\)\s*\}\}\}/g;
const raw = fs.readFileSync(jslib, "utf8");
const source = raw.replace(MACRO, "callbacks[$1]");

// ---------------------------------------------------------------------------
// fake browser
// ---------------------------------------------------------------------------

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    return { promise, resolve, reject };
}

function domError(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
}

// Follows the spec where it matters to the plugin: a lock() that is still
// pending is rejected with AbortError by unlock() and by the next lock().
function FakeKeyboard() {
    this.lockCalls = [];
    this.unlockCalls = 0;
    this.pending = null;
    this.throwOnLock = null;
    this.throwOnUnlock = null;
}
FakeKeyboard.prototype.abortPending = function () {
    if (this.pending) {
        this.pending.reject(domError("AbortError", "preempted"));
        this.pending = null;
    }
};
FakeKeyboard.prototype.lock = function () {
    this.lockCalls.push(Array.from(arguments));
    if (this.throwOnLock) throw this.throwOnLock;
    this.abortPending();
    this.pending = deferred();
    return this.pending.promise;
};
FakeKeyboard.prototype.unlock = function () {
    this.unlockCalls++;
    if (this.throwOnUnlock) throw this.throwOnUnlock;
    this.abortPending();
};
// Settle the lock() in flight the way the browser would.
FakeKeyboard.prototype.grant = function () {
    const pending = this.pending;
    this.pending = null;
    pending.resolve();
};
FakeKeyboard.prototype.refuse = function (error) {
    const pending = this.pending;
    this.pending = null;
    pending.reject(error);
};

const fakeDocument = {
    fullscreenElement: null,
    listeners: {},
    addEventListener(type, listener) {
        (this.listeners[type] = this.listeners[type] || []).push(listener);
    }
};

function setFullscreen(on) {
    fakeDocument.fullscreenElement = on ? {} : null;
    (fakeDocument.listeners.fullscreenchange || []).forEach((listener) => listener());
}

// ---------------------------------------------------------------------------
// load the library
// ---------------------------------------------------------------------------

const warnings = [];

// What C# would have received through its callback, as [requestId, locked].
const settled = [];
const CALLBACK = 7;
const callbacks = { [CALLBACK]: (requestId, locked) => settled.push([requestId, locked]) };

const sandbox = {
    console: { log: console.log, warn: (message) => warnings.push(String(message)) },
    document: fakeDocument,
    navigator: {},
    callbacks,
    autoAddDeps() {},
    LibraryManager: { library: {} },
    mergeInto(target, src) { Object.assign(target, src); }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: path.basename(jslib) });

const lib = sandbox.LibraryManager.library;
sandbox.KBLock = lib.$KBLock;
const KBLock = sandbox.KBLock;

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log("  ok    " + name);
    } else {
        failures++;
        console.log("  FAIL  " + name + (detail !== undefined ? "  (" + detail + ")" : ""));
    }
}

// Lets every promise reaction that is ready run.
function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

// A fresh browser with the API, not fullscreen, with nothing locked.
function reset() {
    const keyboard = new FakeKeyboard();
    sandbox.navigator = { keyboard };
    fakeDocument.fullscreenElement = null;
    KBLock.locked = false;
    KBLock.pending = null;
    KBLock.lockWhileFullscreen = false;
    warnings.length = 0;
    settled.length = 0;
    return keyboard;
}

function listenerCount() {
    return (fakeDocument.listeners.fullscreenchange || []).length;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

async function main() {
    console.log("build macros");
    check("makeDynCall is the only macro used", !source.includes("{{{"));
    check("the callback goes through makeDynCall", raw.match(MACRO) !== null);

    console.log("support detection");
    delete sandbox.navigator;
    check("no navigator", lib.KeyboardLock_IsSupported() === 0);
    sandbox.navigator = {};
    check("navigator without keyboard", lib.KeyboardLock_IsSupported() === 0);
    sandbox.navigator = { keyboard: {} };
    check("keyboard without lock()", lib.KeyboardLock_IsSupported() === 0);
    sandbox.navigator = { keyboard: new FakeKeyboard() };
    check("keyboard with lock()", lib.KeyboardLock_IsSupported() === 1);

    console.log("browser without the API");
    reset();
    sandbox.navigator = {};
    lib.KeyboardLock_SetLockWhileFullscreen(1);
    check("no fullscreen listener is installed", listenerCount() === 0);
    setFullscreen(true);
    lib.KeyboardLock_Lock(1, CALLBACK);
    check("the answer is not delivered re-entrantly", settled.length === 0);
    await tick();
    check("Lock reports false", JSON.stringify(settled) === "[[1,0]]", JSON.stringify(settled));
    lib.KeyboardLock_Unlock();
    setFullscreen(false);
    check("IsLocked stays false", lib.KeyboardLock_IsLocked() === 0);
    check("nothing is logged", warnings.length === 0, warnings.join(" | "));

    console.log("locking while fullscreen");
    let keyboard = reset();
    lib.KeyboardLock_SetLockWhileFullscreen(1);
    lib.KeyboardLock_SetLockWhileFullscreen(1);
    check("one fullscreen listener is installed", listenerCount() === 1, listenerCount());
    check("nothing is locked before fullscreen", keyboard.lockCalls.length === 0);

    setFullscreen(true);
    check("entering fullscreen calls lock()", keyboard.lockCalls.length === 1);
    check("lock() is given no key codes", keyboard.lockCalls[0].length === 0);
    check("not locked until the browser answers", lib.KeyboardLock_IsLocked() === 0);
    keyboard.grant();
    await tick();
    check("locked once the browser grants it", lib.KeyboardLock_IsLocked() === 1);
    check("unlock() has not been called", keyboard.unlockCalls === 0);

    setFullscreen(false);
    check("leaving fullscreen calls unlock()", keyboard.unlockCalls === 1);
    check("no longer locked", lib.KeyboardLock_IsLocked() === 0);

    setFullscreen(true);
    keyboard.grant();
    await tick();
    check("entering fullscreen again locks again",
        keyboard.lockCalls.length === 2 && lib.KeyboardLock_IsLocked() === 1);
    check("nothing is logged", warnings.length === 0, warnings.join(" | "));

    console.log("leaving fullscreen before the lock is granted");
    keyboard = reset();
    lib.KeyboardLock_SetLockWhileFullscreen(1);
    setFullscreen(true);
    setFullscreen(false);
    await tick();
    check("lock() then unlock()", keyboard.lockCalls.length === 1 && keyboard.unlockCalls === 1);
    check("not locked", lib.KeyboardLock_IsLocked() === 0);
    check("the abort is not logged", warnings.length === 0, warnings.join(" | "));
    setFullscreen(true);
    keyboard.grant();
    await tick();
    check("the next fullscreen still locks",
        keyboard.lockCalls.length === 2 && lib.KeyboardLock_IsLocked() === 1);

    console.log("LockWhileFullscreen switched off and on");
    keyboard = reset();
    lib.KeyboardLock_SetLockWhileFullscreen(0);
    setFullscreen(true);
    check("entering fullscreen does not lock", keyboard.lockCalls.length === 0);
    setFullscreen(false);
    check("leaving fullscreen does not unlock", keyboard.unlockCalls === 0);
    setFullscreen(true);
    lib.KeyboardLock_SetLockWhileFullscreen(1);
    check("switching on while fullscreen locks at once", keyboard.lockCalls.length === 1);
    keyboard.grant();
    await tick();
    lib.KeyboardLock_SetLockWhileFullscreen(0);
    check("switching off keeps the lock",
        keyboard.unlockCalls === 0 && lib.KeyboardLock_IsLocked() === 1);
    check("still one fullscreen listener", listenerCount() === 1, listenerCount());

    console.log("KeyboardLock_Lock");
    keyboard = reset();
    lib.KeyboardLock_Lock(10, CALLBACK);
    check("calls lock() with no key codes",
        keyboard.lockCalls.length === 1 && keyboard.lockCalls[0].length === 0);
    await tick();
    check("no answer while the browser is deciding", settled.length === 0);
    keyboard.grant();
    await tick();
    check("granted: callback gets (id, 1)", JSON.stringify(settled) === "[[10,1]]", JSON.stringify(settled));
    check("granted: IsLocked", lib.KeyboardLock_IsLocked() === 1);

    keyboard = reset();
    lib.KeyboardLock_Lock(20, CALLBACK);
    lib.KeyboardLock_Lock(21, CALLBACK);
    setFullscreen(true);
    check("requests made while one is pending share it", keyboard.lockCalls.length === 1);
    keyboard.grant();
    await tick();
    check("every sharer is answered",
        JSON.stringify(settled) === "[[20,1],[21,1]]", JSON.stringify(settled));

    keyboard = reset();
    lib.KeyboardLock_Lock(30, CALLBACK);
    keyboard.refuse(domError("InvalidStateError", "lock() must be called from a primary top-level browsing context."));
    await tick();
    check("refused: callback gets (id, 0)", JSON.stringify(settled) === "[[30,0]]", JSON.stringify(settled));
    check("refused: not locked", lib.KeyboardLock_IsLocked() === 0);
    check("refused: the reason is logged",
        warnings.length === 1 && warnings[0].includes("InvalidStateError"), warnings.join(" | "));
    lib.KeyboardLock_Lock(31, CALLBACK);
    check("a refusal does not block the next request", keyboard.lockCalls.length === 2);

    keyboard = reset();
    keyboard.throwOnLock = domError("SecurityError", "blocked");
    lib.KeyboardLock_Lock(40, CALLBACK);
    await tick();
    check("lock() throwing: callback gets (id, 0)",
        JSON.stringify(settled) === "[[40,0]]", JSON.stringify(settled));
    check("lock() throwing: logged", warnings.length === 1, warnings.join(" | "));

    console.log("KeyboardLock_Unlock");
    keyboard = reset();
    lib.KeyboardLock_Lock(50, CALLBACK);
    lib.KeyboardLock_Unlock();
    await tick();
    check("a pending request is answered with (id, 0)",
        JSON.stringify(settled) === "[[50,0]]", JSON.stringify(settled));
    check("and is not logged", warnings.length === 0, warnings.join(" | "));
    check("and leaves nothing locked", lib.KeyboardLock_IsLocked() === 0);

    // An unlock() overtaking a lock(), then a second lock(): the first must not
    // be mistaken for the second, whichever order the browser answers in.
    keyboard = reset();
    const first = deferred();
    const second = deferred();
    const answers = [first, second];
    keyboard.lock = function () { this.lockCalls.push([]); return answers.shift().promise; };
    keyboard.unlock = function () { this.unlockCalls++; };
    lib.KeyboardLock_Lock(60, CALLBACK);
    lib.KeyboardLock_Unlock();
    lib.KeyboardLock_Lock(61, CALLBACK);
    check("a request after unlock() is a new lock()", keyboard.lockCalls.length === 2);
    second.resolve();
    await tick();
    first.resolve();
    await tick();
    check("an overtaken request never reports a lock",
        JSON.stringify(settled) === "[[61,1],[60,0]]", JSON.stringify(settled));
    check("the newer request decides IsLocked", lib.KeyboardLock_IsLocked() === 1);

    keyboard = reset();
    lib.KeyboardLock_Lock(70, CALLBACK);
    keyboard.grant();
    await tick();
    lib.KeyboardLock_Unlock();
    check("calls unlock()", keyboard.unlockCalls === 1);
    check("clears IsLocked", lib.KeyboardLock_IsLocked() === 0);
    keyboard.throwOnUnlock = domError("InvalidStateError", "detached");
    lib.KeyboardLock_Unlock();
    check("unlock() throwing is logged, not thrown", warnings.length === 1, warnings.join(" | "));

    console.log(failures === 0 ? "\nall passed" : "\n" + failures + " failed");
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
