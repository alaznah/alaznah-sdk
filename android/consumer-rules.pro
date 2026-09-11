# PiP renderer looks up react-native-webrtc internals reflectively.
-keep class com.oney.WebRTCModule.WebRTCModule { *; }
-keep class com.oney.WebRTCModule.EglUtils { *; }
-keep class com.oney.WebRTCModule.ThreadUtils { *; }
-keep class org.webrtc.** { *; }
