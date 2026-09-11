package com.alaznah.calling

import android.app.Activity
import android.app.PictureInPictureParams
import android.os.Build
import android.util.Log
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
 * Android system Picture-in-Picture.
 *
 * Enter (do not change these; they work):
 * 1. Minimize → [AlaznahPipActivity]
 * 2. Home / leave-app → [enterIfEnabled] on MainActivity via onUserLeaveHint
 *
 * Both use [AlaznahPipVideoController]. Restore always: disarm overlay (GONE +
 * remove), never re-enter PiP from onResume / onPictureInPictureModeChanged.
 */
@ReactModule(name = AlaznahCallingPipModule.NAME)
class AlaznahCallingPipModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "AlaznahCallingPip"
    private const val TAG = "AlaznahCallingPip"
    /** Cap extreme portrait/landscape so the PiP window is not a tall strip. */
    private const val MAX_ASPECT = 16.0 / 9.0

    @Volatile private var enabled: Boolean = false
    @Volatile private var emitterContext: ReactApplicationContext? = null
    @Volatile private var aspectW: Int = 16
    @Volatile private var aspectH: Int = 9
    @Volatile private var ignoreHostEnterUntilMs: Long = 0L

    @JvmStatic
    fun isPipEnabled(): Boolean = enabled

    @JvmStatic
    fun noteIgnoreHostEnter(durationMs: Long) {
      ignoreHostEnterUntilMs = System.currentTimeMillis() + durationMs
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
      }
    }

    @JvmStatic
    fun pipParams(): PictureInPictureParams = buildPipParameters()

    /**
     * Minimize: dedicated PiP Activity. MainActivity is not put into PiP.
     */
    @JvmStatic
    fun startPip(host: Activity): Boolean {
      if (!enabled) return false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      if (host.isDestroyed) return false
      if (AlaznahPipActivity.isInPip()) {
        notifyPipModeChanged(true)
        return true
      }
      noteIgnoreHostEnter(1_500L)
      ActiveCallKeepAliveService.start(host.applicationContext)
      return AlaznahPipActivity.launch(host)
    }

    /**
     * Home / recents only. Must not run while companion PiP is active or
     * while companion PiP is restoring (that pause looks like leave-hint).
     */
    @JvmStatic
    fun enterIfEnabled(activity: Activity): Boolean {
      if (!enabled) return false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      if (activity.isDestroyed) return false
      if (activity is AlaznahPipActivity) return false
      if (AlaznahPipActivity.isInPip()) return false
      if (System.currentTimeMillis() < ignoreHostEnterUntilMs) {
        Log.i(TAG, "[PIP_RESTORE] skip enterIfEnabled ignoreHostEnter")
        return false
      }
      if (activity.isInPictureInPictureMode) {
        AlaznahPipVideoController.attach(activity)
        AlaznahPipVideoController.relayout(activity)
        return true
      }
      Log.i(TAG, "Home PiP enter")
      AlaznahPipVideoController.attach(activity)
      return try {
        activity.enterPictureInPictureMode(buildPipParameters())
        true
      } catch (err: Exception) {
        Log.w(TAG, "Home enterPictureInPictureMode: ${err.message}")
        AlaznahPipVideoController.release()
        false
      }
    }

    @JvmStatic
    fun onHostPipModeChanged(activity: Activity, inPip: Boolean) {
      if (activity is AlaznahPipActivity) return
      if (AlaznahPipActivity.isInPip()) return
      Log.i(TAG, "[PIP_RESTORE] host onPictureInPictureModeChanged inPip=$inPip")
      if (inPip) {
        AlaznahPipVideoController.attach(activity)
        AlaznahPipVideoController.relayout(activity)
        notifyPipModeChanged(true)
        return
      }
      // Maximize / close Home PiP. Overlay is a MATCH_PARENT sibling of
      // ReactRootView — GONE + remove immediately. Never relayout-to-fullscreen.
      noteIgnoreHostEnter(2_500L)
      AlaznahPipVideoController.disarmAndRelease(activity)
      notifyPipModeChanged(false)
    }

    @JvmStatic
    fun dismiss() {
      AlaznahPipActivity.dismiss()
      AlaznahPipVideoController.release()
    }

    @JvmStatic
    fun releaseRenderer() {
      AlaznahPipVideoController.release()
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
    private fun buildPipParameters(): PictureInPictureParams {
      val vw = AlaznahPipVideoController.videoWidth()
      val vh = AlaznahPipVideoController.videoHeight()
      val aspect =
        if (vw > 0 && vh > 0) {
          pipRational(vw, vh)
        } else {
          pipRational(aspectW, aspectH)
        }
      val builder = PictureInPictureParams.Builder().setAspectRatio(aspect)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        builder.setAutoEnterEnabled(false)
        builder.setSeamlessResizeEnabled(true)
      }
      return builder.build()
    }
  }

  override fun getName(): String = NAME

  override fun initialize() {
    super.initialize()
    emitterContext = reactContext
    AlaznahPipVideoController.bind(reactContext) { width, height ->
      UiThreadUtil.runOnUiThread {
        aspectW = width
        aspectH = height
        if (AlaznahPipActivity.isInPip()) {
          AlaznahPipActivity.attachIfActive()
        }
      }
    }
  }

  override fun invalidate() {
    if (emitterContext === reactContext) {
      emitterContext = null
    }
    enabled = false
    dismiss()
    super.invalidate()
  }

  @ReactMethod
  fun setEnabled(enabledFlag: Boolean, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      enabled = enabledFlag
      val appContext = reactContext.applicationContext
      if (enabledFlag) {
        ActiveCallKeepAliveService.start(appContext)
      } else {
        dismiss()
        ActiveCallKeepAliveService.stop(appContext)
      }
      Log.i(TAG, "PiP armed=$enabledFlag")
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun setRemoteStreamUrl(url: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      AlaznahPipVideoController.setStreamUrl(url)
      if (AlaznahPipActivity.isInPip()) {
        AlaznahPipActivity.attachIfActive()
      }
      promise.resolve(true)
    }
  }

  @ReactMethod
  @Suppress("UNUSED_PARAMETER")
  fun updatePictureInPicture(
    width: Double,
    height: Double,
    x: Double,
    y: Double,
    promise: Promise,
  ) {
    val w = width.toInt().coerceAtLeast(1)
    val h = height.toInt().coerceAtLeast(1)
    if (AlaznahPipVideoController.videoWidth() <= 0) {
      aspectW = w
      aspectH = h
    }
    promise.resolve(true)
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
      promise.resolve(startPip(activity))
    }
  }

  @ReactMethod
  fun isActive(promise: Promise) {
    val activity = reactContext.currentActivity
    val hostPip =
      activity != null &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        activity.isInPictureInPictureMode
    promise.resolve(AlaznahPipActivity.isInPip() || hostPip)
  }

  @ReactMethod
  fun addListener(eventName: String) {
  }

  @ReactMethod
  fun removeListeners(count: Int) {
  }
}
