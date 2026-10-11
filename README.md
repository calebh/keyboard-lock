# Keyboard Lock

The purpose of this package is to lock the keyboard for fullscreen Unity WebGL/WebGPU games. This prevents annoyances
such as the browser closing the tab when Ctrl+W is pressed (a common occurance in my FPS game). This should also prevent
the Escape key from closing fullscreen.

In your in-game menu you may want to consider a "Quit" button of some sort that will run `Screen.fullScreen = false;` since
with the keyboard lock the user has to **hold** the escape button exit fullscreen.

## Install

Add this git repository's URL to your Unity package manager.

That is all the setup there is. The package hooks the page's `fullscreenchange`
event at startup, calls `navigator.keyboard.lock()` when the page enters
fullscreen and `navigator.keyboard.unlock()` when it leaves.

## API

Everything is on the static class `WebKeyboardLock.KeyboardLock`.

| Member | |
| --- | --- |
| `bool IsSupported` | The browser has the Keyboard Lock API. |
| `bool IsLocked` | The browser has granted a lock that has not been released since. |
| `bool LockWhileFullscreen` | Lock on entering fullscreen, unlock on leaving. On by default. |
| `Task<bool> LockAsync()` | Locks every key. Completes with `true` once the browser grants the lock, `false` if it is refused or unsupported. Never throws. |
| `void Unlock()` | Releases the lock. |

`LockAsync` and `Unlock` are only needed to manage the lock by hand:

```csharp
using WebKeyboardLock;

KeyboardLock.LockWhileFullscreen = false;

if (await KeyboardLock.LockAsync())
{
    // Ctrl+W now reaches the game whenever the page is fullscreen.
}
```

In the editor, in non-WebGL players and in browsers without the API,
`IsSupported` is false, `LockAsync` completes with `false` and the rest does
nothing, so none of this needs `#if UNITY_WEBGL`.

## What to expect from the browser

* **Chromium and Safari only.** Chrome and Edge have the API; [Safari implemented the API in 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/). In Firefox this package does nothing.
* **Fullscreen only.** The browser acts on the lock only while the page is in
  fullscreen entered from script, which is what `Screen.fullScreen = true` does.
  In a window, or in F11 fullscreen, Ctrl+W still closes the tab.
* **Esc is locked too.** A tap of Esc goes to the game instead of leaving
  fullscreen; the player holds Esc for two seconds to leave.
* **HTTPS only.** `navigator.keyboard` does not exist on a plain `http://` page
  (`localhost` is fine).
* **Top-level page only.** Chrome refuses the lock when the game is embedded in
  an iframe. That appears as a console warning, and as `false` from `LockAsync`.

## Tests

```bash
node Tests~/jslib-keyboard-lock.test.js
```

Loads `Runtime/Plugins/WebGL/KeyboardLock.jslib` with the Emscripten globals
stubbed out and drives it against a fake `navigator.keyboard` and `document`:
support detection, locking and unlocking across fullscreen changes, leaving
fullscreen before the lock is granted, and how refusals are reported. Needs
Node 18 or newer, and nothing else.
