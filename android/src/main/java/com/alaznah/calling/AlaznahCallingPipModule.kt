package com.alaznah.calling

import android.app.Activity
import android.app.PictureInPictureParams
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

@ReactModule(name = AlaznahCallingPipModule.NAME)
class AlaznahCallingPipModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "AlaznahCallingPip"

    @Volatile
    private var enabled: Boolean = false

    @Volatile
    private var emitterContext: ReactApplicationContext? = null

    @JvmStatic
    fun isPipEnabled(): Boolean = enabled

    @JvmStatic
    fun enterIfEnabled(activity: Activity): Boolean {
      if (!enabled) return false
      return enterPictureInPicture(activity)
    }

    @JvmStatic
    fun enterPictureInPicture(activity: Activity): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      if (activity.isInPictureInPictureMode) return true
      return try {
        val params =
          PictureInPictureParams.Builder()
            .setAspectRatio(Rational(9, 16))
            .build()
        activity.enterPictureInPictureMode(params)
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
        // JS runtime may be paused while entering PiP.
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
    super.invalidate()
  }

  @ReactMethod
  fun setEnabled(enabledFlag: Boolean, promise: Promise) {
    enabled = enabledFlag
    promise.resolve(true)
  }

  @ReactMethod
  fun isSupported(promise: Promise) {
    promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
  }

  @ReactMethod
  fun enter(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    UiThreadUtil.runOnUiThread {
      if (!enabled) {
        promise.resolve(false)
        return@runOnUiThread
      }
      promise.resolve(enterPictureInPicture(activity))
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

  // Required for NativeEventEmitter on Android.
  @ReactMethod
  fun addListener(eventName: String) {
  }

  @ReactMethod
  fun removeListeners(count: Int) {
  }
}
