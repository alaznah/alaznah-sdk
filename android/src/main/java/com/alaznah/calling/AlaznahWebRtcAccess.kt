package com.alaznah.calling

import android.util.Log
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactContext
import org.webrtc.EglBase
import org.webrtc.MediaStream
import org.webrtc.VideoTrack

/**
 * Reflective access to react-native-webrtc internals.
 *
 * [com.oney.WebRTCModule.WebRTCModule.getStreamForReactTag] is package-private, and
 * we must not take a compile dependency on that module. The host app already ships
 * WebRTC at runtime via `react-native-webrtc`.
 */
internal object AlaznahWebRtcAccess {
  private const val TAG = "AlaznahCallingPip"

  fun getRootEglBaseContext(): EglBase.Context? {
    return try {
      val clazz = Class.forName("com.oney.WebRTCModule.EglUtils")
      clazz.getMethod("getRootEglBaseContext").invoke(null) as? EglBase.Context
    } catch (err: Throwable) {
      Log.w(TAG, "EglUtils.getRootEglBaseContext failed: ${err.message}")
      null
    }
  }

  fun runOnWebRtcExecutor(runnable: Runnable) {
    try {
      val clazz = Class.forName("com.oney.WebRTCModule.ThreadUtils")
      clazz.getMethod("runOnExecutor", Runnable::class.java).invoke(null, runnable)
    } catch (_: Throwable) {
      runnable.run()
    }
  }

  fun findVideoTrack(reactContext: ReactContext?, streamUrl: String?): VideoTrack? {
    if (reactContext == null || streamUrl.isNullOrBlank()) return null
    return try {
      val module = nativeWebRtcModule(reactContext) ?: run {
        Log.w(TAG, "WebRTCModule not registered")
        return null
      }
      val method = module.javaClass.getDeclaredMethod("getStreamForReactTag", String::class.java)
      method.isAccessible = true
      val stream = method.invoke(module, streamUrl) as? MediaStream
      if (stream == null) {
        Log.w(TAG, "No MediaStream for url=$streamUrl")
        return null
      }
      val track = stream.videoTracks.firstOrNull()
      if (track == null) {
        Log.w(TAG, "MediaStream has no video track url=$streamUrl")
      }
      track
    } catch (err: Throwable) {
      Log.w(TAG, "findVideoTrack failed: ${err.message}")
      null
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun nativeWebRtcModule(reactContext: ReactContext): NativeModule? {
    return try {
      val clazz = Class.forName("com.oney.WebRTCModule.WebRTCModule") as Class<out NativeModule>
      reactContext.getNativeModule(clazz)
    } catch (err: Throwable) {
      Log.w(TAG, "WebRTCModule class lookup failed: ${err.message}")
      null
    }
  }
}
