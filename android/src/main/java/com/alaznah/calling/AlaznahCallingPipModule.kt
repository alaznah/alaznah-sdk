package com.alaznah.calling

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.util.Rational
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Android Activity Picture-in-Picture for active video calls.
 *
 * Host contract (example MainActivity):
 * - [onUserLeaveHint] → [enterIfEnabled]
 * - [onPictureInPictureModeChanged] → [notifyPipModeChanged]
 *
 * Owns window/PiP state only — CallManager owns the call.
 */
@ReactModule(name = AlaznahCallingPipModule.NAME)
class AlaznahCallingPipModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "AlaznahCallingPip"
    private const val MAX_ASPECT = 2.39
    private const val ENTER_DEBOUNCE_MS = 400L

    @Volatile private var enabled: Boolean = false
    @Volatile private var emitterContext: ReactApplicationContext? = null

    @Volatile private var aspectW: Int = 9
    @Volatile private var aspectH: Int = 16
    @Volatile private var hintLeft: Int = 0
    @Volatile private var hintTop: Int = 0
    @Volatile private var hintRight: Int = 0
    @Volatile private var hintBottom: Int = 0
    @Volatile private var hasSourceHint: Boolean = false

    @Volatile private var lastEnterAtMs: Long = 0L
    @Volatile private var enterGeneration: Int = 0

    @JvmStatic
    fun isPipEnabled(): Boolean = enabled

    /**
     * Called from Activity.onUserLeaveHint when the user leaves the app
     * (Home / recents). No-ops unless JS has armed PiP for an eligible call.
     */
    @JvmStatic
    fun enterIfEnabled(activity: Activity): Boolean {
      if (!enabled) return false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      if (activity.isDestroyed) return false
      if (activity.isInPictureInPictureMode) return true

      val now = System.currentTimeMillis()
      if (now - lastEnterAtMs < ENTER_DEBOUNCE_MS) return false
      lastEnterAtMs = now

      // Tell JS first so ActiveCallScreen can switch remote objectFit→contain
      // and move off the Modal Dialog before the Activity window shrinks.
      val gen = ++enterGeneration
      notifyPipModeChanged(true)
      activity.window.decorView.postDelayed(
        {
          if (gen != enterGeneration) return@postDelayed
          if (!enabled || activity.isDestroyed) {
            notifyPipModeChanged(false)
            return@postDelayed
          }
          if (activity.isInPictureInPictureMode) return@postDelayed
          val ok = enterPictureInPicture(activity)
          if (!ok) notifyPipModeChanged(false)
        },
        320L,
      )
      return true
    }

    @JvmStatic
    fun enterPictureInPicture(activity: Activity): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      if (activity.isDestroyed) return false
      if (activity.isInPictureInPictureMode) return true
      if (!enabled) return false

      return try {
        ActiveCallKeepAliveService.start(activity.applicationContext)
        activity.enterPictureInPictureMode(buildPipParameters(autoEnter = true))
        true
      } catch (_: Exception) {
        false
      }
    }

    @JvmStatic
    fun notifyPipModeChanged(active: Boolean) {
      val ctx = emitterContext ?: return
      if (!ctx.hasActiveReactInstance()) return
      try {
        ctx
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(
            "AlaznahCallingPipModeChanged",
            Arguments.createMap().apply { putBoolean("active", active) },
          )
      } catch (_: Exception) {
        // Bridge may be paused mid-transition.
      }
    }

    /**
     * Expand out of PiP (no public exitPiP API). Used when the call ends
     * while the Activity is still in picture-in-picture mode.
     */
    @JvmStatic
    fun closeIfActive(activity: Activity?) {
      if (activity == null || activity.isDestroyed) return
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
      if (!activity.isInPictureInPictureMode) return
      try {
        val intent = Intent(activity, activity.javaClass)
        intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        activity.startActivity(intent)
      } catch (_: Exception) {
        // Leave PiP window for the user to dismiss.
      }
    }

    @JvmStatic
    private fun pipRational(width: Int, height: Int): Rational {
      var w = width.coerceAtLeast(1)
      var h = height.coerceAtLeast(1)
      val ratio = w.toDouble() / h.toDouble()
      if (ratio > MAX_ASPECT) {
        w = (h * MAX_ASPECT).toInt().coerceAtLeast(1)
      } else if (ratio < 1.0 / MAX_ASPECT) {
        h = (w * MAX_ASPECT).toInt().coerceAtLeast(1)
      }
      return Rational(w, h)
    }

    @JvmStatic
    private fun buildPipParameters(autoEnter: Boolean): PictureInPictureParams {
      // Fixed portrait PiP chrome. Video uses objectFit=contain inside the Activity;
      // sourceRectHint is intentionally omitted (cover SurfaceView metrics crop top-left).
      val builder =
        PictureInPictureParams.Builder()
          .setAspectRatio(Rational(9, 16))

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        builder.setAutoEnterEnabled(autoEnter && enabled)
      }
      return builder.build()
    }

    @JvmStatic
    private fun applyParamsToActivity(autoEnter: Boolean) {
      val activity = emitterContext?.currentActivity ?: return
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      try {
        activity.setPictureInPictureParams(buildPipParameters(autoEnter))
      } catch (_: Exception) {
        // Activity may not support PiP yet.
      }
    }
  }

  override fun getName(): String = NAME

  override fun initialize() {
    super.initialize()
    emitterContext = reactContext
  }

  override fun invalidate() {
    if (emitterContext === reactContext) {
      emitterContext = null
    }
    enterGeneration += 1
    enabled = false
    super.invalidate()
  }

  /** Arm / disarm automatic home leave PiP for the current activity. */
  @ReactMethod
  fun setEnabled(enabledFlag: Boolean, promise: Promise) {
    val gen = ++enterGeneration
    UiThreadUtil.runOnUiThread {
      if (gen != enterGeneration) {
        promise.resolve(false)
        return@runOnUiThread
      }
      enabled = enabledFlag
      val appContext = reactContext.applicationContext
      if (enabledFlag) {
        ActiveCallKeepAliveService.start(appContext)
        applyParamsToActivity(autoEnter = true)
      } else {
        hasSourceHint = false
        applyParamsToActivity(autoEnter = false)
        // Do NOT REORDER_TO_FRONT here — ACS remount races would abort PiP mid-enter.
        // Call end removes the Activity host; the user/system dismisses the PiP window.
        ActiveCallKeepAliveService.stop(appContext)
      }
      promise.resolve(true)
    }
  }

  /**
   * Update aspect ratio and optional sourceRectHint from the fullscreen video surface.
   * Ignored while already in PiP (avoids aspect thrash from the shrunk window).
   */
  @ReactMethod
  fun updatePictureInPicture(
    width: Double,
    height: Double,
    x: Double,
    y: Double,
    promise: Promise,
  ) {
    UiThreadUtil.runOnUiThread {
      val activity = reactContext.currentActivity
      if (activity != null &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
        activity.isInPictureInPictureMode
      ) {
        promise.resolve(false)
        return@runOnUiThread
      }

      val w = width.toInt().coerceAtLeast(1)
      val h = height.toInt().coerceAtLeast(1)
      // Skip no-op updates.
      if (hasSourceHint &&
        aspectW == w &&
        aspectH == h &&
        hintLeft == x.toInt() &&
        hintTop == y.toInt() &&
        hintRight == x.toInt() + w &&
        hintBottom == y.toInt() + h
      ) {
        promise.resolve(true)
        return@runOnUiThread
      }

      aspectW = w
      aspectH = h
      hintLeft = x.toInt()
      hintTop = y.toInt()
      hintRight = hintLeft + w
      hintBottom = hintTop + h
      hasSourceHint = true

      if (enabled) {
        applyParamsToActivity(autoEnter = true)
      }
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun isSupported(promise: Promise) {
    promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
  }

  @ReactMethod
  fun enter(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = reactContext.currentActivity
      if (activity == null || !enabled) {
        promise.resolve(false)
        return@runOnUiThread
      }
      promise.resolve(enterIfEnabled(activity))
    }
  }

  @ReactMethod
  fun isActive(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false)
      return
    }
    promise.resolve(activity.isInPictureInPictureMode)
  }

  @ReactMethod
  fun addListener(eventName: String) {
  }

  @ReactMethod
  fun removeListeners(count: Int) {
  }
}
