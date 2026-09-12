package com.alaznah.calling

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Short-lived phone-call foreground service so Android allows launching
 * [IncomingCallActivity] from a killed/background FCM wake (BAL exemption).
 */
class IncomingCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val callId = intent?.getStringExtra(AlaznahCallingModule.EXTRA_CALL_ID).orEmpty()
    val callerId = intent?.getStringExtra(AlaznahCallingModule.EXTRA_CALLER_ID).orEmpty()
    val mediaType = intent?.getStringExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE) ?: "audio"
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Incoming call"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: "$callerId is calling…"

    if (callId.isBlank()) {
      // Satisfy startForegroundService contract before exiting.
      val stub =
        AlaznahCallingModule.buildIncomingNotification(
          this,
          "Incoming call",
          "Connecting…",
          "invalid",
          callerId,
          mediaType,
        )
      startForegroundBestEffort(71_091, stub)
      stopSelf()
      return START_NOT_STICKY
    }

    if (AlaznahCallingModule.isCallCanceled(this, callId)) {
      val stub =
        AlaznahCallingModule.buildIncomingNotification(
          this,
          title,
          body,
          callId,
          callerId,
          mediaType,
        )
      startForegroundBestEffort(AlaznahCallingModule.notificationIdPublic(callId), stub)
      stopSelf()
      return START_NOT_STICKY
    }

    val notification = AlaznahCallingModule.buildIncomingNotification(
      this,
      title,
      body,
      callId,
      callerId,
      mediaType,
    )

    val notifId = AlaznahCallingModule.notificationIdPublic(callId)
    if (!startForegroundBestEffort(notifId, notification)) {
      android.util.Log.w("AlaznahCalling", "IncomingCallService startForeground failed")
      // Still try to post the notification + activity.
      AlaznahCallingModule.postIncomingNotification(this, notification, callId)
    }

    try {
      val activity = Intent(this, IncomingCallActivity::class.java)
        .addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_CLEAR_TOP or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        .putExtra(AlaznahCallingModule.EXTRA_CALL_ID, callId)
        .putExtra(AlaznahCallingModule.EXTRA_CALLER_ID, callerId)
        .putExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE, mediaType)
      startActivity(activity)
    } catch (err: Exception) {
      android.util.Log.w("AlaznahCalling", "start IncomingCallActivity failed", err)
    }

    // Keep FGS briefly so the Activity can attach; then drop to notification-only.
    android.os.Handler(mainLooper).postDelayed({
      try {
        stopForeground(STOP_FOREGROUND_DETACH)
      } catch (_: Exception) {
        // ignore
      }
      stopSelf()
    }, 2_500L)

    return START_NOT_STICKY
  }

  private fun startForegroundBestEffort(notifId: Int, notification: Notification): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return try {
        @Suppress("DEPRECATION")
        startForeground(notifId, notification)
        true
      } catch (err: Exception) {
        android.util.Log.w("AlaznahCalling", "IncomingCallService legacy startForeground failed", err)
        false
      }
    }

    // Incoming ring: mediaPlayback is enough and works without dialer role.
    // microphone/phoneCall often throw on targetSdk 34+ without MANAGE_OWN_CALLS.
    val candidates =
      mutableListOf(
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
      )

    for (type in candidates) {
      try {
        startForeground(notifId, notification, type)
        return true
      } catch (err: Exception) {
        android.util.Log.w(
          "AlaznahCalling",
          "IncomingCallService startForeground type=$type failed: ${err.message}",
        )
      }
    }

    return try {
      @Suppress("DEPRECATION")
      startForeground(notifId, notification)
      true
    } catch (err: Exception) {
      android.util.Log.w("AlaznahCalling", "IncomingCallService untyped startForeground failed", err)
      false
    }
  }

  companion object {
    const val EXTRA_TITLE = "audioVideoTitle"
    const val EXTRA_BODY = "audioVideoBody"

    fun start(
      context: Context,
      title: String,
      body: String,
      callId: String,
      callerId: String,
      mediaType: String,
    ) {
      val intent = Intent(context, IncomingCallService::class.java)
        .putExtra(AlaznahCallingModule.EXTRA_CALL_ID, callId)
        .putExtra(AlaznahCallingModule.EXTRA_CALLER_ID, callerId)
        .putExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE, mediaType)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_BODY, body)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (err: Exception) {
        android.util.Log.w("AlaznahCalling", "IncomingCallService start failed", err)
        // Fallback without re-entering this service starter.
        val notification = AlaznahCallingModule.buildIncomingNotification(
          context, title, body, callId, callerId, mediaType,
        )
        AlaznahCallingModule.postIncomingNotification(context, notification, callId)
        try {
          context.startActivity(
            Intent(context, IncomingCallActivity::class.java)
              .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                  Intent.FLAG_ACTIVITY_CLEAR_TOP or
                  Intent.FLAG_ACTIVITY_SINGLE_TOP,
              )
              .putExtra(AlaznahCallingModule.EXTRA_CALL_ID, callId)
              .putExtra(AlaznahCallingModule.EXTRA_CALLER_ID, callerId)
              .putExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE, mediaType),
          )
        } catch (_: Exception) {
          // Notification remains.
        }
      }
    }
  }
}
