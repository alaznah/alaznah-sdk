#import "AlaznahCallingPip.h"

#import <AVKit/AVKit.h>

@implementation AlaznahCallingPip

RCT_EXPORT_MODULE(AlaznahCallingPip)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"AlaznahCallingPipModeChanged" ];
}

/**
 * Visual PiP on iOS is driven by react-native-webrtc `iosPIP` on RTCView.
 * This module only reports support; enter is a no-op (JS calls startIOSPIP).
 */
RCT_EXPORT_METHOD(setEnabled:(BOOL)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  resolve(@YES);
}

RCT_EXPORT_METHOD(isSupported:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  if (@available(iOS 15.0, *)) {
    resolve(@([AVPictureInPictureController isPictureInPictureSupported]));
  } else {
    resolve(@NO);
  }
}

RCT_EXPORT_METHOD(enter:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  // Handled in JS via react-native-webrtc startIOSPIP(ref).
  resolve(@NO);
}

RCT_EXPORT_METHOD(isActive:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  resolve(@NO);
}

@end
