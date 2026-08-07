package com.alaznah.calling

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class IncomingCallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    val callId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALL_ID) ?: return
    val callerId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALLER_ID).orEmpty()
    val mediaType = intent.getStringExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE) ?: "audio"

    when (action) {
      ACTION_ACCEPT -> {
        AlaznahCallingModule.cancelCall(context, callId)
        persist(context, callId, "accept", callerId, mediaType, commit = true)
        launchHostApp(context, callId, "accept", callerId, mediaType)
      }
      ACTION_DECLINE -> {
        // Silent decline: dismiss UI + HTTP reject. Do NOT open the host app.
        AlaznahCallingModule.cancelCall(context, callId)
        persist(context, callId, "decline", callerId, mediaType, commit = true)
        val pending = goAsync()
        rejectViaHttp(context, callId) { pending.finish() }
      }
    }
  }

  companion object {
    const val ACTION_ACCEPT = "com.alaznah.calling.INCOMING_CALL_ACCEPT"
    const val ACTION_DECLINE = "com.alaznah.calling.INCOMING_CALL_DECLINE"
    private const val PREFERENCES = "alaznah_incoming_call"

    fun persist(
      context: Context,
      callId: String,
      action: String,
      callerId: String,
      mediaType: String,
      commit: Boolean = false,
    ) {
      val editor = preferences(context).edit()
        .putString(AlaznahCallingModule.KEY_CALL_ID, callId)
        .putString(AlaznahCallingModule.KEY_ACTION, action)
        .putString(AlaznahCallingModule.KEY_CALLER_ID, callerId)
        .putString(AlaznahCallingModule.KEY_MEDIA_TYPE, mediaType)
        .putLong(AlaznahCallingModule.KEY_TIMESTAMP, System.currentTimeMillis())
      if (commit) editor.commit() else editor.apply()
    }

    /** Persist Accept/Decline extras from the host launch Intent (cold-start safety). */
    fun persistFromLaunchIntent(context: Context, intent: Intent?) {
      if (intent == null) return
      val callId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALL_ID)?.trim().orEmpty()
      val action = intent.getStringExtra(AlaznahCallingModule.EXTRA_ACTION)?.trim().orEmpty()
      if (callId.isEmpty() || (action != "accept" && action != "decline")) return
      val callerId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALLER_ID).orEmpty()
      val mediaType = intent.getStringExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE) ?: "audio"
      persist(context, callId, action, callerId, mediaType, commit = true)
    }

    fun preferences(context: Context): SharedPreferences =
      context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun launchHostApp(
      context: Context,
      callId: String,
      action: String,
      callerId: String,
      mediaType: String,
    ) {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
      launch
        .addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_CLEAR_TOP or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        .putExtra(AlaznahCallingModule.EXTRA_CALL_ID, callId)
        .putExtra(AlaznahCallingModule.EXTRA_ACTION, action)
        .putExtra(AlaznahCallingModule.EXTRA_CALLER_ID, callerId)
        .putExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE, mediaType)
      context.startActivity(launch)
    }

    /** Reject over HTTP so kill-state Decline does not need to open React UI. */
    fun rejectViaHttp(context: Context, callId: String, onDone: (() -> Unit)? = null) {
      val prefs = preferences(context)
      val base = prefs.getString(AlaznahCallingModule.KEY_HTTP_BASE, null)?.trim().orEmpty()
      val userId = prefs.getString(AlaznahCallingModule.KEY_USER_ID, null)?.trim().orEmpty()
      val rejectToken = AlaznahCallingModule.readRejectToken(context, callId)
      if (base.isEmpty() || userId.isEmpty() || callId.isEmpty()) {
        android.util.Log.e(
          "AlaznahCalling",
          "rejectViaHttp missing endpoint/userId base='$base' userId='$userId' callId='$callId'",
        )
        onDone?.invoke()
        return
      }
      if (rejectToken.isEmpty()) {
        android.util.Log.e(
          "AlaznahCalling",
          "rejectViaHttp missing rejectToken callId='$callId'",
        )
        onDone?.invoke()
        return
      }
      // Emulator-style host is useless on a physical device — last-known LAN from prefs wins.
      thread(name = "avc-reject") {
        var lastError: Exception? = null
        val candidates = linkedSetOf(base.trimEnd('/'))
        // Common misconfig: ws URL accidentally stored
        if (base.startsWith("ws://")) {
          candidates.add("http://" + base.removePrefix("ws://").trimEnd('/'))
        }
        if (base.startsWith("wss://")) {
          candidates.add("https://" + base.removePrefix("wss://").trimEnd('/'))
        }
        for (candidate in candidates) {
          try {
            val url = URL("$candidate/call/reject")
            val conn = (url.openConnection() as HttpURLConnection).apply {
              requestMethod = "POST"
              connectTimeout = 8_000
              readTimeout = 8_000
              doOutput = true
              setRequestProperty("Content-Type", "application/json")
            }
            val payload =
              """{"callId":${jsonString(callId)},"userId":${jsonString(userId)},"reason":"declined","rejectToken":${jsonString(rejectToken)}}"""
            OutputStreamWriter(conn.outputStream).use { it.write(payload) }
            val code = conn.responseCode
            android.util.Log.i(
              "AlaznahCalling",
              "rejectViaHttp status=$code url=$candidate callId=$callId",
            )
            conn.disconnect()
            if (code in 200..299) {
              onDone?.invoke()
              return@thread
            }
          } catch (err: Exception) {
            lastError = err
            android.util.Log.w("AlaznahCalling", "rejectViaHttp failed for $candidate", err)
          }
        }
        if (lastError != null) {
          android.util.Log.e("AlaznahCalling", "rejectViaHttp all candidates failed", lastError)
        }
        onDone?.invoke()
      }
    }

    private fun jsonString(value: String): String =
      "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
  }
}
