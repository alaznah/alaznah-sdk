package com.alaznah.calling

import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class AlaznahCallingModule(reactContext: ReactApplicationContext) :
  NativeAlaznahCallingSpec(reactContext) {

  init {
    ensureChannel(reactContext)
    moduleInstance = this
  }

  override fun invalidate() {
    if (moduleInstance === this) {
      moduleInstance = null
    }
    super.invalidate()
  }

  override fun requestPermission(promise: Promise) {
    // Runtime POST_NOTIFICATIONS permission must be requested by the host UI.
    promise.resolve(true)
  }

  override fun registerVoip(promise: Promise) {
    promise.resolve(null)
  }

  override fun getVoipToken(promise: Promise) {
    promise.resolve(null)
  }

  override fun show(title: String, body: String, callId: String, promise: Promise) {
    showIncoming(title, body, callId, "", "audio", promise)
  }

  override fun showIncoming(
    title: String,
    body: String,
    callId: String,
    callerId: String,
    mediaType: String,
    promise: Promise,
  ) {
    try {
      showFromPush(reactApplicationContext, title, body, callId, callerId, mediaType)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("audio_video_call_notify_error", error)
    }
  }

  override fun cancel(callId: String, promise: Promise) {
    cancelCall(reactApplicationContext, callId)
    promise.resolve(true)
  }

  override fun cancelAll(promise: Promise) {
    NotificationManagerCompat.from(reactApplicationContext).cancelAll()
    dismissIncomingActivity(reactApplicationContext, "")
    promise.resolve(true)
  }

  override fun consumePendingAction(promise: Promise) {
    val preferences = IncomingCallActionReceiver.preferences(reactApplicationContext)
    val callId = preferences.getString(KEY_CALL_ID, null)
    if (callId == null) {
      promise.resolve(null)
      return
    }

    val timestamp = preferences.getLong(KEY_TIMESTAMP, 0)
    if (System.currentTimeMillis() - timestamp > ACTION_TTL_MS) {
      clearPendingActionKeys(preferences)
      promise.resolve(null)
      return
    }

    val result = Arguments.createMap().apply {
      putString("callId", callId)
      putString("action", preferences.getString(KEY_ACTION, "open"))
      putString("callerId", preferences.getString(KEY_CALLER_ID, ""))
      putString("mediaType", preferences.getString(KEY_MEDIA_TYPE, "audio"))
      putDouble("timestamp", timestamp.toDouble())
    }
    clearPendingActionKeys(preferences)
    promise.resolve(result)
  }

  /**
   * Persists signaling HTTP base + userId so kill-state Decline can POST
   * /call/reject without opening the React UI.
   */
  override fun configureCallEndpoint(httpBaseUrl: String, userId: String, promise: Promise) {
    IncomingCallActionReceiver.preferences(reactApplicationContext).edit()
      .putString(KEY_HTTP_BASE, httpBaseUrl.trim())
      .putString(KEY_USER_ID, userId.trim())
      .commit()
    promise.resolve(true)
  }

  override fun storeRejectToken(callId: String, rejectToken: String, promise: Promise) {
    Companion.storeRejectToken(reactApplicationContext, callId, rejectToken)
    promise.resolve(true)
  }

  override fun reportOutgoingCall(
    callId: String,
    peerId: String,
    mediaType: String,
    promise: Promise,
  ) {
    promise.resolve(true)
  }

  override fun reportOngoingCall(
    callId: String,
    peerId: String,
    mediaType: String,
    promise: Promise,
  ) {
    promise.resolve(true)
  }

  override fun reportCallConnected(callId: String, promise: Promise) {
    promise.resolve(true)
  }

  override fun enableBackgroundCamera(promise: Promise) {
    promise.resolve(true)
  }

  override fun hasCameraTorch(facingMode: String, promise: Promise) {
    try {
      promise.resolve(findTorchCameraId(facingMode) != null)
    } catch (error: Exception) {
      promise.resolve(false)
    }
  }

  override fun setCameraTorch(enabled: Boolean, facingMode: String, promise: Promise) {
    try {
      val cameraId = findTorchCameraId(facingMode)
        ?: run {
          promise.reject("audio_video_call_torch_error", "Torch not available on this camera")
          return
        }
      val manager =
        reactApplicationContext.getSystemService(Context.CAMERA_SERVICE) as? android.hardware.camera2.CameraManager
          ?: run {
            promise.reject("audio_video_call_torch_error", "CameraManager unavailable")
            return
          }
      manager.setTorchMode(cameraId, enabled)
      promise.resolve(enabled)
    } catch (error: Exception) {
      promise.reject("audio_video_call_torch_error", error.message, error)
    }
  }

  private fun findTorchCameraId(facingMode: String): String? {
    val manager =
      reactApplicationContext.getSystemService(Context.CAMERA_SERVICE) as? android.hardware.camera2.CameraManager
        ?: return null
    val wantFront = facingMode.equals("user", ignoreCase = true)
    for (id in manager.cameraIdList) {
      val chars = manager.getCameraCharacteristics(id)
      val facing = chars.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING)
      val match =
        if (wantFront) {
          facing == android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
        } else {
          facing == android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK
        }
      if (!match) continue
      val hasFlash =
        chars.get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
      if (hasFlash) return id
    }
    return null
  }

  private fun emitAction(payload: WritableMap) {
    // DeviceEventEmitter reaches JS even when the TurboModule EventEmitter is
    // not yet subscribed during cold start / IncomingCallActivity trampoline.
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("IncomingCallAction", payload)
    } catch (_: Exception) {
      // JS may not be ready yet — SharedPreferences persist is the durable path.
    }
  }

  companion object {
    const val NAME = NativeAlaznahCallingSpec.NAME
    const val EXTRA_CALL_ID = "alaznahCallId"
    const val EXTRA_CALLER_ID = "alaznahCallerId"
    const val EXTRA_MEDIA_TYPE = "alaznahMediaType"
    const val EXTRA_ACTION = "alaznahIncomingAction"
    const val EXTRA_DISMISS = "alaznahIncomingDismiss"
    const val ACTION_DISMISS_INCOMING = "com.alaznah.calling.DISMISS_INCOMING_CALL"
    const val KEY_CALL_ID = "callId"
    const val KEY_CALLER_ID = "callerId"
    const val KEY_MEDIA_TYPE = "mediaType"
    const val KEY_ACTION = "action"
    const val KEY_TIMESTAMP = "timestamp"
    const val KEY_HTTP_BASE = "httpBaseUrl"
    const val KEY_USER_ID = "userId"
    const val KEY_REJECT_TOKEN_PREFIX = "rejectToken:"

    fun storeRejectToken(context: Context, callId: String, rejectToken: String) {
      val id = callId.trim()
      val token = rejectToken.trim()
      if (id.isEmpty() || token.isEmpty()) return
      IncomingCallActionReceiver.preferences(context).edit()
        .putString(KEY_REJECT_TOKEN_PREFIX + id, token)
        .apply()
    }

    fun readRejectToken(context: Context, callId: String): String =
      IncomingCallActionReceiver.preferences(context)
        .getString(KEY_REJECT_TOKEN_PREFIX + callId.trim(), "")
        .orEmpty()
        .trim()

    private const val CHANNEL_ID = "alaznah_incoming_calls_v2"
    private const val BASE_NOTIFICATION_ID = 71_001
    private const val ACTION_TTL_MS = 70_000L
    private const val CANCELED_TTL_MS = 120_000L

    @Volatile
    private var moduleInstance: AlaznahCallingModule? = null

    private fun clearPendingActionKeys(preferences: android.content.SharedPreferences) {
      // Keep httpBaseUrl / userId — Decline needs them after kill.
      preferences.edit()
        .remove(KEY_CALL_ID)
        .remove(KEY_ACTION)
        .remove(KEY_CALLER_ID)
        .remove(KEY_MEDIA_TYPE)
        .remove(KEY_TIMESTAMP)
        .apply()
    }

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      // Drop the old channel so importance / FSI behaviour picks up cleanly.
      try {
        manager.deleteNotificationChannel("alaznah_incoming_calls_v1")
      } catch (_: Exception) {
        // ignore
      }
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Incoming calls",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "Full-screen incoming audio and video call alerts"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 1_000, 1_000, 1_000)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        val attributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
        setSound(Settings.System.DEFAULT_RINGTONE_URI, attributes)
      }
      manager.createNotificationChannel(channel)
    }

    private fun wakeScreen(context: Context) {
      try {
        val manager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        @Suppress("DEPRECATION")
        val lock = manager.newWakeLock(
          PowerManager.FULL_WAKE_LOCK or
            PowerManager.ACQUIRE_CAUSES_WAKEUP or
            PowerManager.ON_AFTER_RELEASE,
          "@alaznah/calling:incoming",
        )
        lock.acquire(10_000L)
      } catch (_: Exception) {
        // The high-priority full-screen notification remains available.
      }
    }

    /** True when the host RN UI is already visible — never steal focus. */
    fun isHostInForeground(context: Context): Boolean {
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        ?: return false
      val pkg = context.packageName
      val processes = am.runningAppProcesses ?: return false
      return processes.any {
        it.processName == pkg &&
          it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
      }
    }

    fun showFromPush(
      context: Context,
      title: String,
      body: String,
      callId: String,
      callerId: String,
      mediaType: String,
    ) {
      // Foreground host already owns the in-app ringing UI.
      if (isHostInForeground(context)) {
        return
      }
      if (isCallCanceled(context, callId)) {
        android.util.Log.i("AlaznahCalling", "ignore late invite for canceled callId=$callId")
        return
      }

      ensureChannel(context)
      wakeScreen(context)

      IncomingCallService.start(context, title, body, callId, callerId, mediaType)
    }

    fun buildIncomingNotification(
      context: Context,
      title: String,
      body: String,
      callId: String,
      callerId: String,
      mediaType: String,
    ): Notification {
      ensureChannel(context)

      val fullScreenIntent = Intent(context, IncomingCallActivity::class.java)
        .addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_CLEAR_TOP or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        .putExtra(EXTRA_CALL_ID, callId)
        .putExtra(EXTRA_CALLER_ID, callerId)
        .putExtra(EXTRA_MEDIA_TYPE, mediaType)
      val fullScreenPending = PendingIntent.getActivity(
        context,
        callId.hashCode(),
        fullScreenIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

      val acceptPending = PendingIntent.getActivity(
        context,
        callId.hashCode() + 1,
        Intent(context, IncomingCallActivity::class.java)
          .addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
              Intent.FLAG_ACTIVITY_CLEAR_TOP or
              Intent.FLAG_ACTIVITY_SINGLE_TOP,
          )
          .putExtra(EXTRA_CALL_ID, callId)
          .putExtra(EXTRA_CALLER_ID, callerId)
          .putExtra(EXTRA_MEDIA_TYPE, mediaType)
          .putExtra(EXTRA_ACTION, "accept"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val declinePending = PendingIntent.getBroadcast(
        context,
        callId.hashCode() + 2,
        Intent(context, IncomingCallActionReceiver::class.java)
          .setAction(IncomingCallActionReceiver.ACTION_DECLINE)
          .putExtra(EXTRA_CALL_ID, callId)
          .putExtra(EXTRA_CALLER_ID, callerId)
          .putExtra(EXTRA_MEDIA_TYPE, mediaType),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

      val isVideo = mediaType.equals("video", ignoreCase = true)
      val callLabel = if (isVideo) "Video call" else "Voice call"
      val displayTitle = title.ifBlank {
        if (isVideo) "Incoming video call" else "Incoming voice call"
      }
      val displayBody = body.ifBlank {
        "${callerId.ifBlank { "Someone" }} is calling…"
      }

      val caller = androidx.core.app.Person.Builder()
        .setName(callerId.ifBlank { "Incoming call" })
        .setImportant(true)
        .build()

      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(displayTitle)
        .setContentText("$callLabel · $displayBody")
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setTimeoutAfter(60_000L)
        .setContentIntent(fullScreenPending)
        .setFullScreenIntent(fullScreenPending, true)
        .setStyle(
          NotificationCompat.CallStyle.forIncomingCall(caller, declinePending, acceptPending),
        )
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build()
    }

    fun postIncomingNotification(context: Context, notification: Notification, callId: String) {
      NotificationManagerCompat.from(context).notify(notificationId(callId), notification)
    }

    fun notificationIdPublic(callId: String): Int = notificationId(callId)

    fun cancelCall(context: Context, callId: String) {
      markCallCanceled(context, callId)
      try {
        context.stopService(Intent(context, IncomingCallService::class.java))
      } catch (_: Exception) {
        // ignore
      }
      NotificationManagerCompat.from(context).cancel(notificationId(callId))
      dismissIncomingActivity(context, callId)
    }

    fun markCallCanceled(context: Context, callId: String) {
      if (callId.isBlank()) return
      IncomingCallActionReceiver.preferences(context).edit()
        .putLong(canceledKey(callId), System.currentTimeMillis())
        .apply()
    }

    fun isCallCanceled(context: Context, callId: String): Boolean {
      if (callId.isBlank()) return false
      val prefs = IncomingCallActionReceiver.preferences(context)
      val at = prefs.getLong(canceledKey(callId), 0L)
      if (at <= 0L) return false
      if (System.currentTimeMillis() - at > CANCELED_TTL_MS) {
        prefs.edit().remove(canceledKey(callId)).apply()
        return false
      }
      return true
    }

    private fun canceledKey(callId: String): String = "canceled:$callId"

    fun dismissIncomingActivity(context: Context, callId: String) {
      // Broadcast only — do NOT startActivity here (that re-opens the green
      // ringing screen and is exactly the stuck-UI bug).
      try {
        context.sendBroadcast(
          Intent(ACTION_DISMISS_INCOMING)
            .setPackage(context.packageName)
            .putExtra(EXTRA_CALL_ID, callId),
        )
      } catch (_: Exception) {
        // ignore
      }
    }

    fun emitPendingAction(
      context: Context,
      callId: String,
      action: String,
      callerId: String,
      mediaType: String,
    ) {
      val payload = Arguments.createMap().apply {
        putString("callId", callId)
        putString("action", action)
        putString("callerId", callerId)
        putString("mediaType", mediaType)
        putDouble("timestamp", System.currentTimeMillis().toDouble())
      }
      moduleInstance?.emitAction(payload)
    }

    private fun notificationId(callId: String): Int =
      BASE_NOTIFICATION_ID + ((callId.hashCode() and Int.MAX_VALUE) % 1_000)
  }
}
