require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |spec|
    spec.name         = "AlaznahCalling"
  spec.version      = package["version"]
  spec.summary      = package["description"]
  spec.homepage     = "https://docs.alaznah.com"
  spec.license      = package["license"]
  spec.author       = "Alaznah"
  spec.platforms    = { :ios => "15.1" }
  spec.source       = {
    :git => "https://github.com/alaznah/calling.git",
    :tag => spec.version.to_s
  }

  spec.source_files = "ios/**/*.{h,m,mm,swift,cpp}"
  spec.private_header_files = "ios/**/*.h"
  spec.swift_version = "5.9"
  spec.frameworks = "CallKit", "PushKit", "UserNotifications", "AVKit"
  spec.static_framework = true

  install_modules_dependencies(spec)

  spec.pod_target_xcconfig = {
    "CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES" => "YES"
  }

  # npm may install this pod before react-native-webrtc, so postinstall can
  # miss the patch. Re-apply on every iOS compile if the marker is absent.
  spec.script_phases = [
    {
      :name => "Alaznah apply WebRTC iOS PiP patch",
      :execution_position => :before_compile,
      :always_out_of_date => "1",
      :script => %(
        SCRIPT_PATH="${PODS_TARGET_SRCROOT}/scripts/apply-webrtc-ios-pip-patch.cjs"
        if [ ! -f "$SCRIPT_PATH" ]; then
          exit 0
        fi
        export ALAZNAH_APP_ROOT="${SRCROOT}/.."
        NODE_BIN="${NODE_BINARY:-node}"
        "$NODE_BIN" "$SCRIPT_PATH" || true
      )
    }
  ]
end
