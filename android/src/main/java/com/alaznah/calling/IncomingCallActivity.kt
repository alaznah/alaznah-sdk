package com.alaznah.calling

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView

/**
 * Full-screen incoming call UI + Accept trampoline.
 *
 * Decline is silent (notification BroadcastReceiver or in-UI button) and must
 * NOT open the host React app. Accept persists the action and launches the host.
 */
class IncomingCallActivity : Activity() {
  private var callId: String = ""
  private var callerId: String = "Incoming call"
  private var mediaType: String = "audio"
  private var uiReady = false
  private var handled = false

  private val dismissReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val id = intent?.getStringExtra(AlaznahCallingModule.EXTRA_CALL_ID) ?: return
      if (id == callId || id.isBlank()) {
        finish()
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    showOverLockScreen()
    registerDismissReceiver()
    handleIncomingIntent(intent, fromNewIntent = false)
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    if (intent != null) {
      setIntent(intent)
      handleIncomingIntent(intent, fromNewIntent = true)
    }
  }

  override fun onDestroy() {
    try {
      unregisterReceiver(dismissReceiver)
    } catch (_: Exception) {
      // Already unregistered.
    }
    super.onDestroy()
  }

  private fun registerDismissReceiver() {
    val filter = IntentFilter(AlaznahCallingModule.ACTION_DISMISS_INCOMING)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(dismissReceiver, filter, RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(dismissReceiver, filter)
    }
  }

  private fun handleIncomingIntent(intent: Intent, fromNewIntent: Boolean) {
    if (intent.getBooleanExtra(AlaznahCallingModule.EXTRA_DISMISS, false)) {
      finish()
      return
    }

    val nextCallId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALL_ID)
    if (nextCallId.isNullOrBlank()) {
      if (!fromNewIntent) finish()
      return
    }

    callId = nextCallId
    callerId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALLER_ID)
      ?.takeIf(String::isNotBlank)
      ?: "Incoming call"
    mediaType = intent.getStringExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE) ?: "audio"

    val autoAction = intent.getStringExtra(AlaznahCallingModule.EXTRA_ACTION)
    if (autoAction == "accept") {
      handleAccept()
      return
    }
    if (autoAction == "decline") {
      handleDecline()
      return
    }

    if (!uiReady) {
      setContentView(R.layout.alaznah_activity_incoming_call)
      findViewById<Button>(R.id.rnc_accept).setOnClickListener { handleAccept() }
      findViewById<Button>(R.id.rnc_decline).setOnClickListener { handleDecline() }
      uiReady = true
    }
    findViewById<TextView>(R.id.rnc_incoming_caller).text = callerId
    findViewById<TextView>(R.id.rnc_incoming_subtitle).text =
      "${if (mediaType.equals("video", ignoreCase = true)) "Video" else "Audio"} call · ringing…"
  }

  private fun handleAccept() {
    if (handled) return
    handled = true
    AlaznahCallingModule.cancelCall(this, callId)
    IncomingCallActionReceiver.persist(this, callId, "accept", callerId, mediaType, commit = true)
    AlaznahCallingModule.emitPendingAction(this, callId, "accept", callerId, mediaType)
    IncomingCallActionReceiver.launchHostApp(this, callId, "accept", callerId, mediaType)
    finish()
  }

  private fun handleDecline() {
    if (handled) return
    handled = true
    AlaznahCallingModule.cancelCall(this, callId)
    IncomingCallActionReceiver.persist(this, callId, "decline", callerId, mediaType, commit = true)
    IncomingCallActionReceiver.rejectViaHttp(this, callId)
    finish()
  }

  private fun showOverLockScreen() {
    // Draw over the lock screen like a phone call. Do NOT call
    // requestDismissKeyguard here — that forces an "unlock first" prompt before Accept.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
      )
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
}
