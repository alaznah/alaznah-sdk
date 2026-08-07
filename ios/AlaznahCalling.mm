#import "AlaznahCalling.h"

#import <AVFoundation/AVFoundation.h>
#import <CallKit/CallKit.h>
#import <PushKit/PushKit.h>
#import <UserNotifications/UserNotifications.h>

#if __has_include(<AlaznahCalling/AlaznahCalling-Swift.h>)
#import <AlaznahCalling/AlaznahCalling-Swift.h>
#else
#import "AlaznahCalling-Swift.h"
#endif

static void EnableWebRtcMultitaskingCamera(void)
{
  Class optionsClass = NSClassFromString(@"WebRTCModuleOptions");
  if (!optionsClass) {
    return;
  }
  SEL sharedSel = NSSelectorFromString(@"sharedInstance");
  if (![optionsClass respondsToSelector:sharedSel]) {
    return;
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
  id options = [optionsClass performSelector:sharedSel];
  SEL setSel = NSSelectorFromString(@"setEnableMultitaskingCameraAccess:");
  if ([options respondsToSelector:setSel]) {
    NSMethodSignature *signature = [options methodSignatureForSelector:setSel];
    if (signature) {
      NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
      invocation.selector = setSel;
      invocation.target = options;
      BOOL enabled = YES;
      [invocation setArgument:&enabled atIndex:2];
      [invocation invoke];
    }
  }
#pragma clang diagnostic pop
}

static void WireCallKitAudioSessionToWebRtc(void)
{
  // Call RTCAudioSession directly. WebRTCModule.audioSessionDidActivate is an
  // instance RCT method — invoking it on the class is a silent no-op and leaves
  // CallKit-accepted calls connected with no WebRTC audio.
  [AlaznahCallingManager shared].audioSessionHandler = ^(NSDictionary *payload) {
    Class rtcAudioSessionClass = NSClassFromString(@"RTCAudioSession");
    if (!rtcAudioSessionClass) {
      NSLog(@"[AlaznahCalling] RTCAudioSession class missing — CallKit audio will not reach WebRTC");
      return;
    }
    SEL sharedSel = NSSelectorFromString(@"sharedInstance");
    if (![rtcAudioSessionClass respondsToSelector:sharedSel]) {
      return;
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id rtcSession = [rtcAudioSessionClass performSelector:sharedSel];
#pragma clang diagnostic pop
    BOOL active = [payload[@"active"] boolValue];
    AVAudioSession *avSession = [AVAudioSession sharedInstance];
    SEL sel = active ? NSSelectorFromString(@"audioSessionDidActivate:")
                     : NSSelectorFromString(@"audioSessionDidDeactivate:");
    if (rtcSession && [rtcSession respondsToSelector:sel]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      [rtcSession performSelector:sel withObject:avSession];
#pragma clang diagnostic pop
      NSLog(@"[AlaznahCalling] RTCAudioSession %@ notified", active ? @"activate" : @"deactivate");
    }
  };
}

@interface AlaznahCallingBootstrap : NSObject
@end

@implementation AlaznahCallingBootstrap
+ (void)load
{
  dispatch_async(dispatch_get_main_queue(), ^{
    EnableWebRtcMultitaskingCamera();
    WireCallKitAudioSessionToWebRtc();
    [[AlaznahCallingManager shared] configure];
  });
}
@end

@implementation AlaznahCalling

RCT_EXPORT_MODULE(AlaznahCalling)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (instancetype)init
{
  if ((self = [super init])) {
    EnableWebRtcMultitaskingCamera();
    WireCallKitAudioSessionToWebRtc();
    __weak AlaznahCalling *weakSelf = self;
    [AlaznahCallingManager shared].voipTokenHandler = ^(NSDictionary *payload) {
      [weakSelf emitOnVoipPushToken:payload];
    };
    [AlaznahCallingManager shared].incomingActionHandler = ^(NSDictionary *payload) {
      [weakSelf emitOnIncomingCallAction:payload];
    };
  }
  return self;
}

RCT_REMAP_METHOD(requestPermission,
                 requestPermission:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:(UNAuthorizationOptionAlert |
                                       UNAuthorizationOptionSound |
                                       UNAuthorizationOptionBadge)
                    completionHandler:^(BOOL granted, NSError *_Nullable error) {
    if (error) {
      reject(@"audio_video_call_permission_error", error.localizedDescription, error);
    } else {
      resolve(@(granted));
    }
  }];
}

RCT_REMAP_METHOD(registerVoip,
                 registerVoip:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  EnableWebRtcMultitaskingCamera();
  [[AlaznahCallingManager shared] configure];
  resolve([[AlaznahCallingManager shared] voipToken] ?: [NSNull null]);
}

RCT_REMAP_METHOD(getVoipToken,
                 getVoipToken:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  resolve([[AlaznahCallingManager shared] voipToken] ?: [NSNull null]);
}

RCT_REMAP_METHOD(show,
                 show:(NSString *)title
                 body:(NSString *)body
                 callId:(NSString *)callId
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [self showIncoming:title
                body:body
              callId:callId
            callerId:body.length ? body : title
           mediaType:@"audio"
             resolve:resolve
              reject:reject];
}

RCT_REMAP_METHOD(showIncoming,
                 showIncoming:(NSString *)title
                 body:(NSString *)body
                 callId:(NSString *)callId
                 callerId:(NSString *)callerId
                 mediaType:(NSString *)mediaType
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared]
      reportIncomingCall:callId
                callerId:callerId.length ? callerId : body
               mediaType:mediaType
              completion:^(NSError *_Nullable error) {
    if (error) {
      reject(@"audio_video_call_callkit_error", error.localizedDescription, error);
    } else {
      resolve(@YES);
    }
  }];
}

RCT_REMAP_METHOD(cancel,
                 cancel:(NSString *)callId
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared] endCall:callId];
  resolve(@YES);
}

RCT_REMAP_METHOD(cancelAll,
                 cancelAll:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared] endAllCalls];
  resolve(@YES);
}

RCT_REMAP_METHOD(consumePendingAction,
                 consumePendingAction:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  resolve([[AlaznahCallingManager shared] consumePendingAction] ?: [NSNull null]);
}

RCT_REMAP_METHOD(configureCallEndpoint,
                 configureCallEndpoint:(NSString *)httpBaseUrl
                 userId:(NSString *)userId
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared] configureCallEndpointWithHttpBaseUrl:httpBaseUrl
                                                               userId:userId];
  resolve(@YES);
}

RCT_REMAP_METHOD(storeRejectToken,
                 storeRejectToken:(NSString *)callId
                 rejectToken:(NSString *)rejectToken
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared] storeRejectTokenForCallId:callId token:rejectToken];
  resolve(@YES);
}

RCT_REMAP_METHOD(reportOutgoingCall,
                 reportOutgoingCall:(NSString *)callId
                 peerId:(NSString *)peerId
                 mediaType:(NSString *)mediaType
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared]
      reportOutgoingCall:callId
                  peerId:peerId
               mediaType:mediaType
              completion:^(NSError *_Nullable error) {
    if (error) {
      reject(@"audio_video_call_callkit_error", error.localizedDescription, error);
    } else {
      resolve(@YES);
    }
  }];
}

RCT_REMAP_METHOD(reportOngoingCall,
                 reportOngoingCall:(NSString *)callId
                 peerId:(NSString *)peerId
                 mediaType:(NSString *)mediaType
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared]
      reportOngoingCall:callId
                 peerId:peerId
              mediaType:mediaType
             completion:^(NSError *_Nullable error) {
    if (error) {
      reject(@"audio_video_call_callkit_error", error.localizedDescription, error);
    } else {
      resolve(@YES);
    }
  }];
}

RCT_REMAP_METHOD(reportCallConnected,
                 reportCallConnected:(NSString *)callId
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  [[AlaznahCallingManager shared] reportCallConnected:callId];
  resolve(@YES);
}

RCT_REMAP_METHOD(enableBackgroundCamera,
                 enableBackgroundCamera:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  EnableWebRtcMultitaskingCamera();
  resolve(@YES);
}

RCT_REMAP_METHOD(hasCameraTorch,
                 hasCameraTorch:(NSString *)facingMode
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  BOOL available = [[AlaznahCallingManager shared]
      hasCameraTorchForFacingMode:facingMode.length ? facingMode : @"user"];
  resolve(@(available));
}

RCT_REMAP_METHOD(setCameraTorch,
                 setCameraTorch:(BOOL)enabled
                 facingMode:(NSString *)facingMode
                 resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject)
{
  BOOL on = [[AlaznahCallingManager shared]
      setCameraTorchEnabled:enabled
                 facingMode:facingMode.length ? facingMode : @"user"];
  resolve(@(on));
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeAlaznahCallingSpecJSI>(params);
}

@end
