package com.alaznah.calling

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class AlaznahCallingPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? =
    when (name) {
      AlaznahCallingModule.NAME -> AlaznahCallingModule(reactContext)
      AlaznahCallingPipModule.NAME -> AlaznahCallingPipModule(reactContext)
      else -> null
    }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      AlaznahCallingModule.NAME to ReactModuleInfo(
        name = AlaznahCallingModule.NAME,
        className = AlaznahCallingModule.NAME,
        canOverrideExistingModule = false,
        needsEagerInit = false,
        isCxxModule = false,
        isTurboModule = true,
      ),
      AlaznahCallingPipModule.NAME to ReactModuleInfo(
        name = AlaznahCallingPipModule.NAME,
        className = AlaznahCallingPipModule.NAME,
        canOverrideExistingModule = false,
        needsEagerInit = false,
        isCxxModule = false,
        isTurboModule = false,
      ),
    )
  }
}
