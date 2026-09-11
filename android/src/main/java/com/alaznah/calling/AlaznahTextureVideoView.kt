package com.alaznah.calling

import android.content.Context
import android.graphics.Color
import android.util.AttributeSet
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactContext
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.view.TextureView
import android.graphics.SurfaceTexture
import android.graphics.Matrix

/**
 * In-call Android video surface backed by [TextureView] + [EglRenderer].
 *
 * react-native-webrtc [RTCView] uses [org.webrtc.SurfaceViewRenderer], which:
 *  - composites in a separate surface (hole-punch) that ignores Yoga z-order
 *  - does not resize/transform smoothly with Animated width/height
 *  - covers sibling avatar Views when fullscreen
 *
 * TextureView lives in the normal view hierarchy, so float↔fullscreen morphs
 * and avatar overlays work like iOS Metal without remounting tracks.
 */
class AlaznahTextureVideoView
@JvmOverloads
constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : FrameLayout(context, attrs), TextureView.SurfaceTextureListener, LifecycleEventListener {

  companion object {
    private const val TAG = "AlaznahTextureVideo"
  }

  private val textureView = TextureView(context)
  private val eglRenderer = EglRenderer("AlaznahCallVideo")
  private var eglInitialized = false
  private var surfaceReady = false
  private var pendingSurface: SurfaceTexture? = null
  private var releasing = false
  private var rendererAttached = false
  private var videoTrack: VideoTrack? = null
  private var streamURL: String? = null
  private var mirror = false
  private var objectFitCover = true
  private var frameWidth = 0
  private var frameHeight = 0

  private val videoSink =
    VideoSink { frame ->
      reportFrameSize(frame)
      eglRenderer.onFrame(frame)
    }

  private val reactContext: ReactContext?
    get() = context as? ReactContext

  init {
    setBackgroundColor(Color.BLACK)
    textureView.isOpaque = true
    textureView.surfaceTextureListener = this
    addView(
      textureView,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER),
    )
    reactContext?.addLifecycleEventListener(this)
  }

  fun setStreamURL(url: String?) {
    if (streamURL == url) return
    streamURL = url
    bindTrackFromUrl()
  }

  fun setMirror(value: Boolean) {
    if (mirror == value) return
    mirror = value
    if (eglInitialized) {
      eglRenderer.setMirror(value)
    }
  }

  fun setObjectFit(fit: String?) {
    val cover = fit != "contain"
    if (objectFitCover == cover) return
    objectFitCover = cover
    updateAspect()
  }

  /** zOrder is a no-op for TextureView — RN elevation/zIndex owns stacking. */
  @Suppress("UNUSED_PARAMETER")
  fun setZOrder(zOrder: Int) = Unit

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ensureEgl()
    bindTrackFromUrl()
  }

  override fun onDetachedFromWindow() {
    unbindTrack()
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    if (changed || right - left > 0) {
      updateAspect()
    }
  }

  override fun onHostResume() = Unit

  override fun onHostPause() = Unit

  override fun onHostDestroy() {
    releaseFully()
  }

  fun releaseFully() {
    if (releasing) return
    releasing = true
    unbindTrack()
    textureView.surfaceTextureListener = null
    reactContext?.removeLifecycleEventListener(this)
    if (eglInitialized) {
      val latch = CountDownLatch(1)
      eglRenderer.releaseEglSurface { latch.countDown() }
      try {
        latch.await(400, TimeUnit.MILLISECONDS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
      eglRenderer.release()
      eglInitialized = false
    }
    surfaceReady = false
    pendingSurface = null
  }

  private fun ensureEgl() {
    if (eglInitialized || releasing) return
    val shared = AlaznahWebRtcAccess.getRootEglBaseContext() ?: run {
      Log.w(TAG, "No shared EGL context yet")
      return
    }
    eglRenderer.init(shared, EglBase.CONFIG_PLAIN, GlRectDrawer())
    eglRenderer.setMirror(mirror)
    eglInitialized = true
    pendingSurface?.let { surface ->
      eglRenderer.createEglSurface(surface)
      surfaceReady = true
      pendingSurface = null
      updateAspect()
    }
  }

  private fun bindTrackFromUrl() {
    if (releasing) return
    ensureEgl()
    val url = streamURL
    if (url.isNullOrBlank()) {
      unbindTrack()
      runCatching { eglRenderer.clearImage() }
      return
    }
    AlaznahWebRtcAccess.runOnWebRtcExecutor {
      val track = AlaznahWebRtcAccess.findVideoTrack(reactContext, url)
      post {
        if (releasing) return@post
        if (track === videoTrack && rendererAttached) return@post
        unbindTrack()
        videoTrack = track
        if (track == null) {
          runCatching { eglRenderer.clearImage() }
          return@post
        }
        if (!eglInitialized) ensureEgl()
        if (!eglInitialized) return@post
        AlaznahWebRtcAccess.runOnWebRtcExecutor {
          try {
            track.addSink(videoSink)
            rendererAttached = true
          } catch (err: Throwable) {
            Log.e(TAG, "addSink failed: ${err.message}")
          }
        }
      }
    }
  }

  private fun unbindTrack() {
    val track = videoTrack
    if (rendererAttached && track != null) {
      AlaznahWebRtcAccess.runOnWebRtcExecutor {
        try {
          track.removeSink(videoSink)
        } catch (_: Throwable) {
        }
      }
    }
    rendererAttached = false
    videoTrack = null
  }

  private fun updateAspect() {
    if (!eglInitialized) return
    val w = if (width > 0) width else measuredWidth
    val h = if (height > 0) height else measuredHeight
    if (w <= 0 || h <= 0) return

    if (objectFitCover && frameWidth > 0 && frameHeight > 0) {
      // Match CSS object-fit: cover — fill the view, crop overflow via layout ratio 0
      // (drawer fills) and TextureView scale transform.
      eglRenderer.setLayoutAspectRatio(0f)
      val viewAspect = w.toFloat() / h.toFloat()
      val videoAspect = frameWidth.toFloat() / frameHeight.toFloat()
      val scaleX: Float
      val scaleY: Float
      if (videoAspect > viewAspect) {
        scaleX = videoAspect / viewAspect
        scaleY = 1f
      } else {
        scaleX = 1f
        scaleY = viewAspect / videoAspect
      }
      val matrix = Matrix()
      matrix.setScale(scaleX, scaleY, w / 2f, h / 2f)
      textureView.setTransform(matrix)
    } else {
      textureView.setTransform(Matrix())
      eglRenderer.setLayoutAspectRatio(w.toFloat() / h.toFloat())
    }
  }

  private fun reportFrameSize(frame: VideoFrame) {
    val rotated = frame.rotation % 180 == 0
    val w = if (rotated) frame.buffer.width else frame.buffer.height
    val h = if (rotated) frame.buffer.height else frame.buffer.width
    if (w == frameWidth && h == frameHeight) return
    frameWidth = w
    frameHeight = h
    post { updateAspect() }
  }

  override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
    if (eglInitialized) {
      eglRenderer.createEglSurface(surface)
      surfaceReady = true
      updateAspect()
    } else {
      pendingSurface = surface
      ensureEgl()
    }
    bindTrackFromUrl()
  }

  override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
    updateAspect()
  }

  override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
    pendingSurface = null
    surfaceReady = false
    if (!releasing && eglInitialized) {
      val latch = CountDownLatch(1)
      eglRenderer.releaseEglSurface { latch.countDown() }
      try {
        latch.await(400, TimeUnit.MILLISECONDS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    return true
  }

  override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
}
