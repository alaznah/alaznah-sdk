package com.alaznah.calling

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Ongoing call foreground service — keeps the process / JS timers alive in PiP
 * and background so signaling heartbeats do not die mid-call.
 *
 * Prefer microphone(+camera) FGS types: `phoneCall` often throws on Android 14+
 * unless the app is the dialer / owns a ConnectionService.
 */
class ActiveCallKeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }

    ensureChannel(this)
    val notification = buildNotification(this)
    if (!startForegroundBestEffort(notification)) {
      android.util.Log.w("AlaznahCalling", "ActiveCallKeepAlive startForeground failed")
      stopSelf()
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  private fun startForegroundBestEffort(notification: Notification): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      @Suppress("DEPRECATION")
      startForeground(NOTIFICATION_ID, notification)
      return true
    }

    val candidates = mutableListOf<Int>()
    if (Build.VERSION.SDK_INT >= 34) {
      candidates.add(
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA,
      )
      candidates.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    }
    candidates.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
    if (Build.VERSION.SDK_INT >= 29) {
      candidates.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    }

    for (type in candidates) {
      try {
        startForeground(NOTIFICATION_ID, notification, type)
        return true
      } catch (err: Exception) {
        android.util.Log.w(
          "AlaznahCalling",
          "ActiveCallKeepAlive startForeground type=$type failed: ${err.message}",
        )
      }
    }

    return try {
      @Suppress("DEPRECATION")
      startForeground(NOTIFICATION_ID, notification)
      true
    } catch (err: Exception) {
      android.util.Log.w("AlaznahCalling", "ActiveCallKeepAlive legacy startForeground failed", err)
      false
    }
  }

  companion object {
    private const val CHANNEL_ID = "alaznah_active_calls"
    private const val NOTIFICATION_ID = 71_090
    const val ACTION_STOP = "com.alaznah.calling.STOP_ACTIVE_CALL_KEEPALIVE"

    @JvmStatic
    fun start(context: Context) {
      val intent = Intent(context, ActiveCallKeepAliveService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (err: Exception) {
        android.util.Log.w("AlaznahCalling", "ActiveCallKeepAlive start failed", err)
      }
    }

    @JvmStatic
    fun stop(context: Context) {
      try {
        val intent =
          Intent(context, ActiveCallKeepAliveService::class.java).setAction(ACTION_STOP)
        context.startService(intent)
      } catch (_: Exception) {
        try {
          context.stopService(Intent(context, ActiveCallKeepAliveService::class.java))
        } catch (_: Exception) {
          // ignore
        }
      }
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      val channel =
        NotificationChannel(
          CHANNEL_ID,
          "Active calls",
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "Keeps the call connected while in Picture-in-Picture"
          setShowBadge(false)
        }
      manager.createNotificationChannel(channel)
    }

    private fun buildNotification(context: Context): Notification {
      val launch =
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
      val pending =
        if (launch != null) {
          PendingIntent.getActivity(
            context,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          )
        } else {
          null
        }

      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setContentTitle("Call in progress")
        .setContentText("Tap to return to the call")
        .setSmallIcon(context.applicationInfo.icon)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setContentIntent(pending)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()
    }
  }
}
