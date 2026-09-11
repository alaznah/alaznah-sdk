package com.alaznah.calling

import android.app.Activity
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import com.facebook.react.bridge.ReactApplicationContext
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.util.concurrent.atomic.AtomicInteger

/**
 * Dedicated Android PiP renderer for the live remote WebRTC video track.
 *
 * Why this exists: react-native-webrtc [RTCView] is a [org.webrtc.SurfaceViewRenderer]
 * (a [android.view.SurfaceView]) inside Yoga. SurfaceView keeps a separate window/surface
 * that does not resize with Activity PiP, so the live video appears as a tiny top-left
 * crop of the previous fullscreen surface. This overlay is a [TextureView] attached to
 * the Activity content view with MATCH_PARENT so Android (not Yoga) lays it out to the
 * actual PiP window, while [VideoTrack.addSink] keeps the same live frames flowing.
 */
internal object AlaznahPipVideoController {
  private const val TAG = "AlaznahCallingPip"

  private val mainHandler = Handler(Looper.getMainLooper())
  private val generation = AtomicInteger(0)

  @Volatile private var streamUrl: String = ""
  @Volatile private var videoWidth: Int = 0
  @Volatile private var videoHeight: Int = 0

  private var overlay: PipOverlay? = null
  private var attachedTrack: VideoTrack? = null
  private var reactContext: ReactApplicationContext? = null
  private var onVideoSize: ((Int, Int) -> Unit)? = null

  fun videoWidth(): Int = videoWidth
  fun videoHeight(): Int = videoHeight

  fun bind(context: ReactApplicationContext, onSize: (Int, Int) -> Unit) {
    reactContext = context
    onVideoSize = onSize
  }

  fun setStreamUrl(url: String?) {
    val next = url.orEmpty()
    if (next == streamUrl) return
    streamUrl = next
    Log.i(TAG, "remote stream url set empty=${next.isEmpty()}")
    val current = overlay
    if (current != null && current.isAttachedToWindow) {
      val activity = current.context as? Activity ?: return
      attach(activity)
    }
  }

  fun attach(activity: Activity) {
    if (activity.isDestroyed) return
    generation.incrementAndGet()

    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: run {
      Log.w(TAG, "attach skipped: no android.R.id.content")
      return
    }

    val existing = overlay
    val reuse = existing != null && existing.parent === content
    if (!reuse) {
      unbindTrack()
      existing?.let { old ->
        old.release()
        (old.parent as? ViewGroup)?.removeView(old)
      }
    }

    val view =
      if (reuse && existing != null) {
        existing
      } else {
        PipOverlay(activity).also { created ->
          overlay = created
          content.addView(
            created,
            FrameLayout.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.MATCH_PARENT,
            ),
          )
        }
      }

    view.bringToFront()
    view.layoutParams =
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
    view.isEnabled = true
    view.visibility = View.VISIBLE
    view.requestLayout()
    relayout(activity)

    val url = streamUrl
    val ctx = reactContext
    if (url.isBlank()) {
      Log.w(TAG, "attach: no remote stream URL yet")
      return
    }

    AlaznahWebRtcAccess.runOnWebRtcExecutor {
      val track = AlaznahWebRtcAccess.findVideoTrack(ctx, url)
      mainHandler.post {
        if (activity.isDestroyed) return@post
        val current = overlay ?: return@post
        bindTrack(track, current)
      }
    }
  }

  fun relayout(activity: Activity) {
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    val overlayView = overlay ?: return
    val w = content.width
    val h = content.height
    Log.i(
      TAG,
      "relayout pip=${if (android.os.Build.VERSION.SDK_INT >= 24) activity.isInPictureInPictureMode else false}" +
        " content=${w}x${h}" +
        " overlayMeasured=${overlayView.measuredWidth}x${overlayView.measuredHeight}" +
        " overlayLaidOut=${overlayView.width}x${overlayView.height}" +
        " video=${videoWidth}x${videoHeight}",
    )
    overlayView.layoutParams =
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
    if (w > 0 && h > 0) {
      overlayView.measure(
        View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
      )
      overlayView.layout(0, 0, w, h)
    }
    overlayView.requestLayout()
    overlayView.updateAspectFromLayout()
  }

  fun disarmAndRelease(activity: Activity? = null) {
    logRestoreState(activity, "before-disarm")
    overlay?.disarm()
    release()
    sweepLeftoverOverlays(activity)
    logRestoreState(activity, "after-disarm")
  }

  /**
   * Home PiP leftover: overlay stays on MainActivity if maximize skipped
   * onPictureInPictureModeChanged. Remove it when the host is resumed and
   * is no longer in PiP.
   *
   * NEVER run this while [AlaznahPipActivity] owns the live PiP window —
   * `isAttachedToWindow` is true for the companion overlay too, and a naive
   * check was disarming Minimize PiP (black window) + notifying JS `active=false`
   * so the call Modal popped back over the app.
   */
  fun releaseLeftoverOnHost(activity: Activity): Boolean {
    if (activity is AlaznahPipActivity) return false
    if (AlaznahPipActivity.isAlive()) {
      Log.i(TAG, "[PIP_RESTORE] skip leftover sweep — companion PiP alive")
      return false
    }
    if (android.os.Build.VERSION.SDK_INT >= 24 && activity.isInPictureInPictureMode) {
      return false
    }
    val view = overlay ?: run {
      sweepLeftoverOverlays(activity)
      return false
    }
    // Only the overlay parented to THIS host activity — not "any attached window".
    val parent = view.parent as? View
    val attachedHere =
      view.context === activity ||
        parent?.context === activity ||
        parent === activity.findViewById(android.R.id.content)
    if (!attachedHere) return false
    Log.w(
      TAG,
      "[PIP_RESTORE] leftover overlay on resumed host vis=${view.visibility} " +
        "attached=${view.isAttachedToWindow} parent=${parent?.javaClass?.simpleName}",
    )
    disarmAndRelease(activity)
    return true
  }

  fun logRestoreState(activity: Activity?, phase: String) {
    val view = overlay
    val parent = view?.parent
    val flags = activity?.window?.attributes?.flags ?: 0
    val touchable = flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE == 0
    val inPip =
      activity != null &&
        android.os.Build.VERSION.SDK_INT >= 24 &&
        activity.isInPictureInPictureMode
    Log.i(TAG, "[PIP_RESTORE] phase=$phase activity=${activity?.javaClass?.simpleName}")
    Log.i(
      TAG,
      "[PIP_OVERLAY] exists=${view != null}" +
        " visibility=${view?.visibility}" +
        " alpha=${view?.alpha}" +
        " elevation=${view?.elevation}" +
        " attached=${view?.isAttachedToWindow}" +
        " parent=${parent?.javaClass?.simpleName}" +
        " bounds=${view?.width ?: 0}x${view?.height ?: 0}" +
        " textureAttached=${view?.textureAttached() ?: false}",
    )
    Log.i(
      TAG,
      "[PIP_ACTIVITY] finishing=${activity?.isFinishing}" +
        " destroyed=${activity?.isDestroyed}" +
        " pip=$inPip",
    )
    Log.i(TAG, "[PIP_WINDOW] touchable=$touchable finishing=${activity?.isFinishing}")
    val content = activity?.findViewById<ViewGroup>(android.R.id.content)
    if (content != null) {
      for (i in 0 until content.childCount) {
        val child = content.getChildAt(i)
        Log.i(
          TAG,
          "[PIP_RESTORE] content[$i]=${child.javaClass.simpleName}" +
            " vis=${child.visibility} ${child.width}x${child.height}" +
            " elev=${child.elevation}" +
            if (child is PipOverlay) " [PIP_OVERLAY]" else "",
        )
      }
    }
  }

  fun release() {
    generation.incrementAndGet()
    unbindTrack()
    val view = overlay
    overlay = null
    videoWidth = 0
    videoHeight = 0
    if (view != null) {
      view.disarm()
      (view.parent as? ViewGroup)?.removeView(view)
      view.release()
    }
    Log.i(TAG, "[PIP_OVERLAY] released parent=null attached=false")
  }

  private fun sweepLeftoverOverlays(activity: Activity?) {
    val content = activity?.findViewById<ViewGroup>(android.R.id.content) ?: return
    val leftover = ArrayList<View>()
    for (i in 0 until content.childCount) {
      val child = content.getChildAt(i)
      if (child is PipOverlay) leftover.add(child)
    }
    leftover.forEach { child ->
      Log.w(TAG, "[PIP_OVERLAY] sweeping leftover vis=${child.visibility}")
      (child as PipOverlay).disarm()
      (child.parent as? ViewGroup)?.removeView(child)
      child.release()
    }
  }

  private fun unbindTrack() {
    val track = attachedTrack
    val sink = overlay?.videoSink
    attachedTrack = null
    overlay?.isSinkAttached = false
    if (track == null || sink == null) return
    AlaznahWebRtcAccess.runOnWebRtcExecutor {
      try {
        track.removeSink(sink)
        Log.i(TAG, "removed PiP sink from track=${track.id()}")
      } catch (err: Throwable) {
        Log.w(TAG, "removeSink failed: ${err.message}")
      }
    }
  }

  private fun bindTrack(track: VideoTrack?, view: PipOverlay) {
    if (track == null) {
      Log.w(TAG, "bindTrack: no VideoTrack for url=$streamUrl")
      return
    }
    val shared = AlaznahWebRtcAccess.getRootEglBaseContext()
    if (shared == null) {
      Log.e(TAG, "bindTrack: no shared EGL context")
      return
    }
    view.ensureInit(shared)
    val previous = attachedTrack
    if (previous === track && view.isSinkAttached) {
      Log.i(TAG, "bindTrack: already attached track=${track.id()}")
      view.updateAspectFromLayout()
      return
    }
    val sink = view.videoSink
    if (previous != null && previous !== track) {
      AlaznahWebRtcAccess.runOnWebRtcExecutor {
        try {
          previous.removeSink(sink)
        } catch (_: Throwable) {
        }
      }
    }
    attachedTrack = track
    AlaznahWebRtcAccess.runOnWebRtcExecutor {
      try {
        track.addSink(sink)
        mainHandler.post { view.isSinkAttached = true }
        Log.i(TAG, "added PiP sink track=${track.id()} url=$streamUrl")
      } catch (err: Throwable) {
        Log.e(TAG, "addSink failed: ${err.message}")
      }
    }
    view.updateAspectFromLayout()
  }

  private fun onFrameSize(width: Int, height: Int) {
    if (width <= 0 || height <= 0) return
    if (width == videoWidth && height == videoHeight) return
    videoWidth = width
    videoHeight = height
    Log.i(TAG, "remote frame ${width}x${height}")
    onVideoSize?.invoke(width, height)
  }

  private class PipOverlay(activity: Activity) : FrameLayout(activity), TextureView.SurfaceTextureListener {
    private val textureView = TextureView(activity)
    private val eglRenderer = EglRenderer("AlaznahPip")
    private var eglInitialized = false
    private var surfaceReady = false
    private var pendingSurface: SurfaceTexture? = null
    @Volatile private var releasing = false
    @Volatile var isSinkAttached: Boolean = false

    val videoSink =
      VideoSink { frame ->
        reportFrameSize(frame)
        eglRenderer.onFrame(frame)
      }

    init {
      setBackgroundColor(Color.BLACK)
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      isClickable = false
      isFocusable = false
      isFocusableInTouchMode = false
      textureView.isClickable = false
      textureView.isFocusable = false
      textureView.setOpaque(true)
      textureView.surfaceTextureListener = this
      addView(
        textureView,
        LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER),
      )
      elevation = 10_000f
    }

    fun textureAttached(): Boolean = surfaceReady && isAttachedToWindow

    /**
     * GONE views are skipped by hit-testing. INVISIBLE / alpha=0 views are not —
     * they still sit on top of ReactRootView and consume every MotionEvent.
     */
    fun disarm() {
      isClickable = false
      isFocusable = false
      isFocusableInTouchMode = false
      isEnabled = false
      visibility = View.GONE
      setOnTouchListener { _, _ -> false }
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
      if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
        Log.i(
          TAG,
          "[PIP_TOUCH_TRACE] PipOverlay ACTION_DOWN vis=$visibility enabled=$isEnabled" +
            " attached=$isAttachedToWindow parent=${(parent as? View)?.javaClass?.simpleName}",
        )
      }
      if (visibility != View.VISIBLE || !isEnabled) {
        return false
      }
      return super.dispatchTouchEvent(ev)
    }

    fun ensureInit(sharedContext: EglBase.Context) {
      if (eglInitialized) return
      eglRenderer.init(sharedContext, EglBase.CONFIG_PLAIN, GlRectDrawer())
      eglRenderer.setMirror(false)
      eglInitialized = true
      Log.i(TAG, "EglRenderer initialized")
      pendingSurface?.let { surface ->
        eglRenderer.createEglSurface(surface)
        surfaceReady = true
        pendingSurface = null
        Log.i(TAG, "EGL surface created from pending TextureView")
      }
    }

    private var lastLaidOutW = 0
    private var lastLaidOutH = 0

    fun updateAspectFromLayout() {
      val w = if (width > 0) width else measuredWidth
      val h = if (height > 0) height else measuredHeight
      if (w <= 0 || h <= 0) return
      val ratio = w.toFloat() / h.toFloat()
      eglRenderer.setLayoutAspectRatio(ratio)
      if (w != lastLaidOutW || h != lastLaidOutH) {
        lastLaidOutW = w
        lastLaidOutH = h
        Log.i(TAG, "renderer layout ${w}x${h} aspect=$ratio surfaceReady=$surfaceReady")
      }
    }

    fun release() {
      if (releasing) return
      releasing = true
      isSinkAttached = false
      pendingSurface = null
      surfaceReady = false
      textureView.surfaceTextureListener = null
      if (eglInitialized) {
        eglInitialized = false
        // Never block the UI thread waiting for EGL. That freeze/blur after
        // call-end was this CountDownLatch deadlocking the React Native activity.
        try {
          eglRenderer.releaseEglSurface { }
          eglRenderer.release()
        } catch (err: Throwable) {
          Log.w(TAG, "egl release: ${err.message}")
        }
      }
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      super.onLayout(changed, left, top, right, bottom)
      if (changed || right - left > 0) {
        updateAspectFromLayout()
      }
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
      Log.i(TAG, "TextureView surface created ${width}x${height}")
      if (eglInitialized) {
        eglRenderer.createEglSurface(surface)
        surfaceReady = true
        updateAspectFromLayout()
      } else {
        pendingSurface = surface
      }
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
      Log.i(TAG, "TextureView surface size ${width}x${height}")
      updateAspectFromLayout()
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
      Log.i(TAG, "TextureView surface destroyed")
      pendingSurface = null
      surfaceReady = false
      if (!releasing && eglInitialized) {
        try {
          eglRenderer.releaseEglSurface { }
        } catch (err: Throwable) {
          Log.w(TAG, "releaseEglSurface: ${err.message}")
        }
      }
      return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit

    private fun reportFrameSize(frame: VideoFrame) {
      val rotated = frame.rotation % 180 == 0
      val w = if (rotated) frame.buffer.width else frame.buffer.height
      val h = if (rotated) frame.buffer.height else frame.buffer.width
      onFrameSize(w, h)
    }
  }
}
