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
    enableShowOverLockScreen(activity, activity.intent)
    attachPictureInPictureListener(activity)
    if (activity !is AlaznahPipActivity) {
      if (AlaznahPipVideoController.releaseLeftoverOnHost(activity)) {
        AlaznahCallingPipModule.notifyPipModeChanged(false)
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
    enableShowOverLockScreen(activity, intent)
  }

  private fun persistLaunchIntent(context: android.content.Context, intent: Intent?) {
    IncomingCallActionReceiver.persistFromLaunchIntent(context, intent)
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
