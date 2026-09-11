package com.alaznah.calling

import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * RN view manager for [AlaznahTextureVideoView] — drop-in Android replacement for RTCView.
 * Props mirror react-native-webrtc RTCView where the call UI needs them.
 */
class AlaznahTextureVideoViewManager : SimpleViewManager<AlaznahTextureVideoView>() {
  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): AlaznahTextureVideoView {
    return AlaznahTextureVideoView(reactContext)
  }

  override fun onDropViewInstance(view: AlaznahTextureVideoView) {
    view.releaseFully()
    super.onDropViewInstance(view)
  }

  @ReactProp(name = "streamURL")
  fun setStreamURL(view: AlaznahTextureVideoView, streamURL: String?) {
    view.setStreamURL(streamURL)
  }

  @ReactProp(name = "mirror")
  fun setMirror(view: AlaznahTextureVideoView, mirror: Boolean) {
    view.setMirror(mirror)
  }

  @ReactProp(name = "objectFit")
  fun setObjectFit(view: AlaznahTextureVideoView, objectFit: String?) {
    view.setObjectFit(objectFit)
  }

  @ReactProp(name = "zOrder")
  fun setZOrder(view: AlaznahTextureVideoView, zOrder: Int) {
    view.setZOrder(zOrder)
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any>? {
    return MapBuilder.of(
      "onDimensionsChange",
      MapBuilder.of("registrationName", "onDimensionsChange"),
    )
  }

  companion object {
    const val REACT_CLASS = "AlaznahTextureVideoView"
  }
}
