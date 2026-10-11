// Browser half of the Keyboard Lock plugin.
//
// Wraps the Keyboard Lock API (navigator.keyboard.lock / unlock), which lets a
// fullscreen page receive the shortcuts the browser normally keeps for itself:
// Ctrl+W, Ctrl+T, Ctrl+N, Esc and so on.
//
// The browser only honours a lock while the page is fullscreen, so that is
// when this takes it: on fullscreenchange the keyboard is locked on the way in
// and unlocked on the way out. The listener lives here rather than in C#
// because the page can leave fullscreen without the game asking (Esc, the
// browser's own UI), and the lock should follow in the same event.
//
// Only Chromium based browsers have the API, and only in a secure context.
// Everywhere else every entry point is a no-op that reports "not locked".
//
// Written in ES5 style (var, function, promise chains) because Emscripten
// embeds this verbatim and it may be run through a minifier targeting ES5.

var KeyboardLockLibrary = {

    $KBLock: {
        // The browser's last word on whether the keyboard is locked.
        locked: false,

        // The lock() the browser has not answered yet, as a promise of
        // true / false. null when nothing is in flight.
        pending: null,

        lockWhileFullscreen: false,
        listening: false,

        IsSupported: function () {
            return typeof navigator !== "undefined" &&
                "keyboard" in navigator &&
                !!navigator.keyboard &&
                typeof navigator.keyboard.lock === "function";
        },

        IsFullscreen: function () {
            return !!document.fullscreenElement;
        },

        // Resolves to whether the keyboard ended up locked. Never rejects.
        Lock: function () {
            if (!KBLock.IsSupported()) {
                return Promise.resolve(false);
            }

            // The browser aborts a pending lock() when a second one is made,
            // so everybody who asks in the meantime waits on the first.
            if (KBLock.pending) {
                return KBLock.pending;
            }

            var request;
            try {
                // No key codes: lock every key the browser will hand over.
                request = navigator.keyboard.lock();
            } catch (error) {
                request = Promise.reject(error);
            }

            var pending = request.then(function () {
                // Unlock() ran while this was in flight. The browser should
                // have aborted the request; either way it no longer counts.
                if (KBLock.pending !== pending) {
                    return false;
                }
                KBLock.pending = null;
                KBLock.locked = true;
                return true;
            }, function (error) {
                if (KBLock.pending === pending) {
                    KBLock.pending = null;
                    KBLock.locked = false;
                }
                // AbortError is the browser reporting that unlock() overtook
                // this request, which is routine when fullscreen is toggled
                // quickly. Anything else is worth knowing about.
                if (!error || error.name !== "AbortError") {
                    console.warn("[KeyboardLock] navigator.keyboard.lock() failed: " + error);
                }
                return false;
            });

            KBLock.pending = pending;
            return pending;
        },

        Unlock: function () {
            // Whatever is still in flight is aborted by unlock().
            KBLock.pending = null;
            KBLock.locked = false;

            if (!KBLock.IsSupported()) {
                return;
            }
            try {
                navigator.keyboard.unlock();
            } catch (error) {
                console.warn("[KeyboardLock] navigator.keyboard.unlock() failed: " + error);
            }
        },

        OnFullscreenChange: function () {
            if (!KBLock.lockWhileFullscreen) {
                return;
            }
            if (KBLock.IsFullscreen()) {
                KBLock.Lock();
            } else {
                KBLock.Unlock();
            }
        }
    },

    KeyboardLock_IsSupported: function () {
        return KBLock.IsSupported() ? 1 : 0;
    },

    KeyboardLock_IsLocked: function () {
        return KBLock.locked ? 1 : 0;
    },

    // navigator.keyboard.lock() is asynchronous; the outcome is reported back
    // to C# through the callback as (requestId, locked).
    KeyboardLock_Lock: function (requestId, callback) {
        KBLock.Lock().then(function (locked) {
            {{{ makeDynCall('vii', 'callback') }}}(requestId, locked ? 1 : 0);
        });
    },

    KeyboardLock_Unlock: function () {
        KBLock.Unlock();
    },

    KeyboardLock_SetLockWhileFullscreen: function (enabled) {
        KBLock.lockWhileFullscreen = !!enabled;
        if (!enabled || !KBLock.IsSupported()) {
            return;
        }

        if (!KBLock.listening) {
            KBLock.listening = true;
            document.addEventListener("fullscreenchange", KBLock.OnFullscreenChange);
        }

        // Switched on while already fullscreen: there is no event to wait for.
        if (KBLock.IsFullscreen()) {
            KBLock.Lock();
        }
    }
};

autoAddDeps(KeyboardLockLibrary, "$KBLock");
mergeInto(LibraryManager.library, KeyboardLockLibrary);
