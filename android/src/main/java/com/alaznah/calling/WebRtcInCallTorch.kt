package com.alaznah.calling

import android.hardware.Camera
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CaptureRequest
import android.os.Handler
import android.util.Log
import android.view.Surface
import com.facebook.react.bridge.ReactApplicationContext
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Toggle torch while WebRTC already owns the camera.
 *
 * [android.hardware.camera2.CameraManager.setTorchMode] fails with CAMERA_IN_USE
 * during an active getUserMedia capture. Instead we reach into react-native-webrtc's
 * Camera1/Camera2 session (same process) and set flash on the live capture request.
 */
internal object WebRtcInCallTorch {
  private const val TAG = "AlaznahTorch"
  private const val WEBRTC_MODULE = "com.oney.WebRTCModule.WebRTCModule"

  fun setTorch(reactContext: ReactApplicationContext, enabled: Boolean): Boolean {
    val capturer = findActiveCameraCapturer(reactContext) ?: return false
    return try {
      val session = readField(capturer, "currentSession") ?: return false
      when (session.javaClass.name) {
        "org.webrtc.Camera1Session" -> setCamera1Torch(session, enabled)
        "org.webrtc.Camera2Session" -> setCamera2Torch(session, enabled)
        else -> {
          Log.w(TAG, "Unsupported camera session ${session.javaClass.name}")
          false
        }
      }
    } catch (err: Exception) {
      Log.w(TAG, "In-call torch failed", err)
      false
    }
  }

  private fun findActiveCameraCapturer(reactContext: ReactApplicationContext): Any? {
    val module = reactContext.findNativeModule(WEBRTC_MODULE)
    if (module == null) {
      Log.w(TAG, "WebRTCModule not found")
      return null
    }

    val getUserMediaImpl =
      readField(module, "getUserMediaImpl")
        ?: run {
          Log.w(TAG, "getUserMediaImpl missing")
          return null
        }

    @Suppress("UNCHECKED_CAST")
    val tracks =
      readField(getUserMediaImpl, "tracks") as? Map<String, Any?>
        ?: return null

    for (trackPrivate in tracks.values) {
      if (trackPrivate == null) continue
      val controller = readField(trackPrivate, "videoCaptureController") ?: continue
      if (!controller.javaClass.name.contains("CameraCaptureController")) continue
      val capturer = readField(controller, "videoCapturer") ?: continue
      if (capturer.javaClass.name.contains("Camera1Capturer") ||
        capturer.javaClass.name.contains("Camera2Capturer") ||
        capturer.javaClass.name.contains("CameraCapturer")
      ) {
        return capturer
      }
    }
    return null
  }

  private fun setCamera1Torch(session: Any, enabled: Boolean): Boolean {
    val camera =
      readField(session, "camera") as? Camera
        ?: return false
    val params = camera.parameters ?: return false
    val modes = params.supportedFlashModes ?: return false
    val target =
      if (enabled) {
        when {
          modes.contains(Camera.Parameters.FLASH_MODE_TORCH) ->
            Camera.Parameters.FLASH_MODE_TORCH
          modes.contains(Camera.Parameters.FLASH_MODE_ON) ->
            Camera.Parameters.FLASH_MODE_ON
          else -> return false
        }
      } else {
        Camera.Parameters.FLASH_MODE_OFF
      }
    params.flashMode = target
    camera.parameters = params
    return true
  }

  private fun setCamera2Torch(session: Any, enabled: Boolean): Boolean {
    val handler =
      readField(session, "cameraThreadHandler") as? Handler
        ?: return false
    val cameraDevice =
      readField(session, "cameraDevice") as? CameraDevice
        ?: return false
    val captureSession =
      readField(session, "captureSession") as? CameraCaptureSession
        ?: return false
    val surface =
      readField(session, "surface") as? Surface
        ?: return false

    val error = AtomicReference<Exception?>(null)
    val latch = CountDownLatch(1)

    handler.post {
      try {
        val builder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
        builder.addTarget(surface)
        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
        builder.set(
          CaptureRequest.FLASH_MODE,
          if (enabled) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF,
        )
        // Mirror WebRTC FPS range when present so preview stays stable.
        val captureFormat = readField(session, "captureFormat")
        val fpsUnitFactor = (readField(session, "fpsUnitFactor") as? Int) ?: 1
        val framerate = captureFormat?.let { readField(it, "framerate") }
        val min = framerate?.let { readField(it, "min") as? Int }
        val max = framerate?.let { readField(it, "max") as? Int }
        if (min != null && max != null && fpsUnitFactor > 0) {
          builder.set(
            CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
            android.util.Range(min / fpsUnitFactor, max / fpsUnitFactor),
          )
        }
        captureSession.setRepeatingRequest(builder.build(), null, handler)
      } catch (err: Exception) {
        error.set(err)
      } finally {
        latch.countDown()
      }
    }

    if (!latch.await(2, TimeUnit.SECONDS)) {
      Log.w(TAG, "Camera2 torch timed out")
      return false
    }
    error.get()?.let { throw it }
    return true
  }

  private fun readField(target: Any, name: String): Any? {
    var cls: Class<*>? = target.javaClass
    while (cls != null) {
      try {
        val field = cls.getDeclaredField(name)
        field.isAccessible = true
        return field.get(target)
      } catch (_: NoSuchFieldException) {
        cls = cls.superclass
      }
    }
    return null
  }

  private fun ReactApplicationContext.findNativeModule(className: String): Any? {
    return try {
      val clazz = Class.forName(className)
      @Suppress("UNCHECKED_CAST")
      getNativeModule(clazz as Class<com.facebook.react.bridge.NativeModule>)
    } catch (_: Exception) {
      null
    }
  }
}
