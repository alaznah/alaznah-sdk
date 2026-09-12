package com.alaznah.calling

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.view.WindowManager
import androidx.activity.ComponentActivity
import java.util.WeakHashMap

/**
 * Host Activity hooks merged into React Native apps without MainActivity edits.
 *
 * Wired from [AlaznahCallingModule] via [com.facebook.react.bridge.ActivityEventListener].
 */
object AlaznahCallingHostHooks {
  private val pipListenerAttached = WeakHashMap<Activity, Unit>()

  fun onHostResume(activity: Activity) {
    persistLaunchIntent(activity, activity.intent)
    emitAcceptIfPresent(activity, activity.intent)
    enableShowOverLockScreen(activity, activity.intent)
    attachPictureInPictureListener(activity)
    if (activity !is AlaznahPipActivity) {
      if (AlaznahPipVideoController.releaseLeftoverOnHost(activity)) {
        AlaznahCallingPipModule.notifyPipModeChanged(false, "host")
      }
    }
  }

  fun onHostPause(activity: Activity) {
    // no-op — kept for LifecycleEventListener symmetry
  }

  fun onNewIntent(activity: Activity, intent: Intent?) {
    if (intent != null) {
      activity.intent = intent
    }
    persistLaunchIntent(activity, intent)
    emitAcceptIfPresent(activity, intent)
    enableShowOverLockScreen(activity, intent)
  }

  private fun persistLaunchIntent(context: android.content.Context, intent: Intent?) {
    IncomingCallActionReceiver.persistFromLaunchIntent(context, intent)
  }

  /**
   * Emit Accept only after the React host Activity is resumed — never from
   * IncomingCallActivity. Emitting early started getUserMedia on the wrong
   * window and left background Accept stuck on Connecting.
   */
  private fun emitAcceptIfPresent(activity: Activity, intent: Intent?) {
    if (intent == null) return
    val callId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALL_ID)?.trim().orEmpty()
    val action = intent.getStringExtra(AlaznahCallingModule.EXTRA_ACTION)?.trim().orEmpty()
    if (callId.isEmpty() || action != "accept") return
    val callerId = intent.getStringExtra(AlaznahCallingModule.EXTRA_CALLER_ID).orEmpty()
    val mediaType = intent.getStringExtra(AlaznahCallingModule.EXTRA_MEDIA_TYPE) ?: "audio"
    AlaznahCallingModule.emitPendingAction(activity, callId, "accept", callerId, mediaType)
    // Prevent duplicate emit on the next resume with the same Intent.
    intent.removeExtra(AlaznahCallingModule.EXTRA_ACTION)
  }

  private fun attachPictureInPictureListener(activity: Activity) {
    if (activity is AlaznahPipActivity) return
    if (pipListenerAttached.containsKey(activity)) return
    if (activity !is ComponentActivity) return
    pipListenerAttached[activity] = Unit
    activity.addOnPictureInPictureModeChangedListener { info ->
      AlaznahCallingPipModule.onHostPipModeChanged(activity, info.isInPictureInPictureMode)
    }
  }

  private fun enableShowOverLockScreen(activity: Activity, intent: Intent?) {
    val fromIncomingAccept =
      intent?.getStringExtra(AlaznahCallingModule.EXTRA_ACTION) == "accept" ||
        !intent?.getStringExtra(AlaznahCallingModule.EXTRA_CALL_ID).isNullOrBlank()
    if (!fromIncomingAccept && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(true)
      activity.setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      activity.window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
      )
    }
    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
}
