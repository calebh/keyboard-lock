using System.Collections.Generic;
using System.Threading.Tasks;
using AOT;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace WebKeyboardLock
{
    /// <summary>
    /// The browser Keyboard Lock API (<c>navigator.keyboard.lock</c>), which
    /// gives a fullscreen page the shortcuts the browser normally keeps for
    /// itself: Ctrl+W, Ctrl+T, Ctrl+N, Esc and so on.
    /// </summary>
    /// <remarks>
    /// Nothing has to be called for the usual case. While
    /// <see cref="LockWhileFullscreen"/> is on, which it is by default, the
    /// keyboard is locked whenever the page enters fullscreen and unlocked when
    /// it leaves.
    ///
    /// Only Chromium based browsers have the API. In every other browser, in the
    /// editor and in non-WebGL players <see cref="IsSupported"/> is false,
    /// <see cref="LockAsync"/> completes with false and the rest does nothing,
    /// so calling code needs no conditional compilation.
    /// </remarks>
    public static class KeyboardLock
    {
        delegate void LockCallback(int requestId, int locked);

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")]
        static extern int KeyboardLock_IsSupported();

        [DllImport("__Internal")]
        static extern int KeyboardLock_IsLocked();

        [DllImport("__Internal")]
        static extern void KeyboardLock_Lock(int requestId, LockCallback callback);

        [DllImport("__Internal")]
        static extern void KeyboardLock_Unlock();

        [DllImport("__Internal")]
        static extern void KeyboardLock_SetLockWhileFullscreen(int enabled);
#else
        // Stand-ins for KeyboardLock.jslib that behave like a browser without
        // the API.
        static int KeyboardLock_IsSupported() => 0;
        static int KeyboardLock_IsLocked() => 0;
        static void KeyboardLock_Lock(int requestId, LockCallback callback) => callback(requestId, 0);
        static void KeyboardLock_Unlock() { }
        static void KeyboardLock_SetLockWhileFullscreen(int enabled) { }
#endif

        static readonly Dictionary<int, TaskCompletionSource<bool>> PendingLocks = new Dictionary<int, TaskCompletionSource<bool>>();
        static int nextRequestId;
        static bool lockWhileFullscreen = true;

        /// <summary>True when the browser exposes the Keyboard Lock API at all.</summary>
        public static bool IsSupported => KeyboardLock_IsSupported() != 0;

        /// <summary>
        /// True once the browser has granted a lock that has not been released
        /// since. The browser only acts on the lock while the page is fullscreen.
        /// </summary>
        public static bool IsLocked => KeyboardLock_IsLocked() != 0;

        /// <summary>
        /// Lock the keyboard on entering fullscreen and unlock it on leaving.
        /// On by default. Turning it off leaves a lock that is already held in
        /// place; call <see cref="Unlock"/> to release it.
        /// </summary>
        public static bool LockWhileFullscreen
        {
            get => lockWhileFullscreen;
            set
            {
                lockWhileFullscreen = value;
                KeyboardLock_SetLockWhileFullscreen(value ? 1 : 0);
            }
        }

        /// <summary>
        /// Asks the browser to lock every key. Completes with true once the lock
        /// is granted, and with false when it is refused, unsupported, or
        /// overtaken by <see cref="Unlock"/>. Never throws.
        /// </summary>
        public static Task<bool> LockAsync()
        {
            var requestId = nextRequestId++;
            var completion = new TaskCompletionSource<bool>();
            PendingLocks[requestId] = completion;
            KeyboardLock_Lock(requestId, OnLockSettled);
            return completion.Task;
        }

        /// <summary>Releases the lock, and abandons one that is still being requested.</summary>
        public static void Unlock() => KeyboardLock_Unlock();

        //[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        public static void Initialize() => KeyboardLock_SetLockWhileFullscreen(lockWhileFullscreen ? 1 : 0);

        [MonoPInvokeCallback(typeof(LockCallback))]
        static void OnLockSettled(int requestId, int locked)
        {
            if (PendingLocks.Remove(requestId, out var completion))
            {
                completion.SetResult(locked != 0);
            }
        }
    }
}
