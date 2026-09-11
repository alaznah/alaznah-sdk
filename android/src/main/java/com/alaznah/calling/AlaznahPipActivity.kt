package com.alaznah.calling

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.FrameLayout

/**
 * Minimize PiP window in the **same task** as MainActivity.
 *
 * Why same-task (not singleInstance / separate affinity):
 * When this activity enters PiP, Android reveals MainActivity underneath so the
 * app stays usable. On maximize/close we simply [finish] — the call UI is
 * already under us. A separate task + finishAndRemoveTask sent users to Home.
 *
 * Home button PiP still uses MainActivity.enterPictureInPictureMode directly.
 */
class AlaznahPipActivity : Activity() {
  companion object {
    private const val TAG = "AlaznahCallingPip"

    @Volatile private var instance: AlaznahPipActivity? = null

    @JvmStatic
    fun isInPip(): Boolean {
      val current = instance ?: return false
      if (current.isFinishing || current.isDestroyed) return false
      return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && current.isInPictureInPictureMode
    }

    @JvmStatic
    fun isAlive(): Boolean {
      val current = instance ?: return false
      return !current.isFinishing && !current.isDestroyed
    }

    @JvmStatic
    fun launch(host: Activity): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      if (isInPip()) return true
      if (isAlive()) return true
      return try {
        val intent = Intent(host, AlaznahPipActivity::class.java)
        // Same task as host — no NEW_TASK / no separate affinity.
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        host.startActivity(intent)
        host.overridePendingTransition(0, 0)
        true
      } catch (err: Exception) {
        Log.w(TAG, "launch PiP activity failed: ${err.message}")
        false
      }
    }

    @JvmStatic
    fun dismiss() {
      val current = instance ?: return
      current.runOnUiThread { current.dismissNow(notifyJs = false) }
    }

    @JvmStatic
    fun attachIfActive() {
      val current = instance ?: return
      if (current.isFinishing || current.isDestroyed) return
      current.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && current.isInPictureInPictureMode) {
          AlaznahPipVideoController.attach(current)
          AlaznahPipVideoController.relayout(current)
        }
      }
    }
  }

  private var enteredOnce = false
  private var exitHandled = false
  private var attachRetries = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    instance = this
    Log.i(TAG, "[PIP_ACTIVITY] onCreate")
    val root = FrameLayout(this)
    root.setBackgroundColor(Color.BLACK)
    setContentView(root)
  }

  override fun onResume() {
    super.onResume()
    Log.i(TAG, "[PIP_ACTIVITY] onResume")
    if (exitHandled || isFinishing || isDestroyed) return

    AlaznahPipVideoController.attach(this)
    AlaznahPipVideoController.relayout(this)
    scheduleAttachRetry()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode) {
      return
    }
    window.decorView.post {
      if (exitHandled || isFinishing || isDestroyed) return@post
      enterOnce()
    }
  }

  private fun scheduleAttachRetry() {
    if (exitHandled || isFinishing || isDestroyed) return
    if (attachRetries >= 8) return
    attachRetries += 1
    window.decorView.postDelayed(
      {
        if (exitHandled || isFinishing || isDestroyed) return@postDelayed
        AlaznahPipVideoController.attach(this)
        AlaznahPipVideoController.relayout(this)
        scheduleAttachRetry()
      },
      250L,
    )
  }

  private fun enterOnce() {
    if (enteredOnce || exitHandled || isFinishing || isDestroyed) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      dismissNow(notifyJs = true)
      return
    }
    enteredOnce = true
    AlaznahPipVideoController.attach(this)
    AlaznahPipVideoController.relayout(this)
    val ok =
      try {
        enterPictureInPictureMode(AlaznahCallingPipModule.pipParams())
      } catch (err: Exception) {
        Log.w(TAG, "enterPictureInPictureMode threw: ${err.message}")
        false
      }
    if (!ok) {
      Log.w(TAG, "enterPictureInPictureMode returned false")
      dismissNow(notifyJs = true)
    }
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    Log.i(TAG, "[PIP_ACTIVITY] onPictureInPictureModeChanged inPip=$isInPictureInPictureMode")
    if (isInPictureInPictureMode) {
      if (exitHandled) return
      AlaznahPipVideoController.attach(this)
      AlaznahPipVideoController.relayout(this)
      AlaznahCallingPipModule.notifyPipModeChanged(true)
      return
    }
    restoreCallingScreen()
  }

  /**
   * Leave PiP → finish this activity. MainActivity is the previous activity in
   * the same task, so the call UI returns to fullscreen without hitting Home.
   */
  private fun restoreCallingScreen() {
    if (exitHandled) return
    exitHandled = true
    AlaznahCallingPipModule.noteIgnoreHostEnter(2_500L)
    AlaznahPipVideoController.disarmAndRelease(this)
    AlaznahCallingPipModule.notifyPipModeChanged(false)
    Log.i(TAG, "[PIP_WINDOW] finish → reveal MainActivity")
    if (!isFinishing && !isDestroyed) {
      overridePendingTransition(0, 0)
      finish()
      overridePendingTransition(0, 0)
    }
  }

  private fun dismissNow(notifyJs: Boolean) {
    AlaznahPipVideoController.disarmAndRelease(this)
    if (isFinishing || isDestroyed) return
    if (!exitHandled) {
      exitHandled = true
      if (notifyJs) AlaznahCallingPipModule.notifyPipModeChanged(false)
    }
    overridePendingTransition(0, 0)
    finish()
    overridePendingTransition(0, 0)
  }

  override fun onDestroy() {
    Log.i(TAG, "[PIP_ACTIVITY] onDestroy")
    if (instance === this) instance = null
    AlaznahPipVideoController.release()
    super.onDestroy()
  }
}
