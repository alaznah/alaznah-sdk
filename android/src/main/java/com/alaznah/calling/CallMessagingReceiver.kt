package com.alaznah.calling

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * Handles Alaznah call FCM payloads before React Native Firebase's headless JS task.
 *
 * Registered in the SDK manifest. Kill-state JS is too late for call cancel; forwarding
 * invite/cancel to RN duplicated notifications. Non-call messages are delegated to RN
 * Firebase when that library is present (reflection — no compile dependency).
 */
class CallMessagingReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val extras = intent?.extras
    if (extras == null) {
      Log.e(TAG, "FCM intent missing extras")
      return
    }

    val type = readData(extras, "type")
    val callId = readData(extras, "callId")

    if (callId.isNotEmpty() &&
      (
        type == "call_canceled" ||
          type == "call_cancelled" ||
          type == "call_end"
        )
    ) {
      Log.i(TAG, "native cancel callId=$callId")
      AlaznahCallingModule.cancelCall(context.applicationContext, callId)
      return
    }

    if (callId.isNotEmpty() && type == "incoming_call") {
      val callerId = readData(extras, "callerId").ifEmpty {
        readData(extras, "handle").ifEmpty { "Incoming call" }
      }
      val callerDisplayName = readData(extras, "callerDisplayName").ifEmpty {
        readData(extras, "handle").ifEmpty { callerId }
      }
      val mediaType = if (readData(extras, "mediaType") == "video") "video" else "audio"
      val signalingHttp = readData(extras, "signalingHttp").trim()
      val calleeId = readData(extras, "calleeId").trim()

      if (signalingHttp.isNotEmpty() && calleeId.isNotEmpty()) {
        IncomingCallActionReceiver.preferences(context).edit()
          .putString(AlaznahCallingModule.KEY_HTTP_BASE, signalingHttp)
          .putString(AlaznahCallingModule.KEY_USER_ID, calleeId)
          .commit()
        Log.i(TAG, "stored decline endpoint=$signalingHttp user=$calleeId")
      } else {
        Log.w(TAG, "invite missing signalingHttp/calleeId — Decline may not reach signaling")
      }

      val rejectToken = readData(extras, "rejectToken").trim()
      if (rejectToken.isNotEmpty()) {
        AlaznahCallingModule.storeRejectToken(context.applicationContext, callId, rejectToken)
      } else {
        Log.w(TAG, "invite missing rejectToken — kill-state Decline will be rejected by server")
      }

      val title = "Incoming ${if (mediaType == "video") "Video" else "Audio"} call"
      val body = "$callerDisplayName is calling…"
      Log.i(TAG, "native incoming callId=$callId from=$callerDisplayName")
      AlaznahCallingModule.showFromPush(
        context.applicationContext,
        title,
        body,
        callId,
        callerDisplayName,
        mediaType,
      )
      return
    }

    forwardToRnFirebase(context, intent)
  }

  private fun readData(extras: Bundle, key: String): String {
    val raw = extras.get(key) ?: return ""
    return raw.toString().trim()
  }

  private fun forwardToRnFirebase(context: Context, intent: Intent?) {
    if (intent == null) return
    try {
      val cls = Class.forName("io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver")
      val receiver = cls.getDeclaredConstructor().newInstance() as BroadcastReceiver
      receiver.onReceive(context, intent)
    } catch (_: ClassNotFoundException) {
      // Host does not use @react-native-firebase/messaging — ignore.
    } catch (error: Exception) {
      Log.w(TAG, "RN Firebase delegate failed", error)
    }
  }

  companion object {
    private const val TAG = "AlaznahCallMessaging"
  }
}
