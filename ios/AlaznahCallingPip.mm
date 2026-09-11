#import "AlaznahCallingPip.h"

#import <AVKit/AVKit.h>
#import <UIKit/UIKit.h>

static NSString *const kAlaznahWebRTCPipWillStart = @"AlaznahWebRTCPipWillStart";
static NSString *const kAlaznahWebRTCPipDidStart = @"AlaznahWebRTCPipDidStart";
static NSString *const kAlaznahWebRTCPipWillStop = @"AlaznahWebRTCPipWillStop";
static NSString *const kAlaznahWebRTCPipDidStop = @"AlaznahWebRTCPipDidStop";
static NSString *const kAlaznahWebRTCPipFailed = @"AlaznahWebRTCPipFailed";

static void AlaznahApplyPassThroughToView(UIView *view, BOOL passThrough)
{
  if (view == nil) {
    return;
  }
  view.userInteractionEnabled = !passThrough;
  view.alpha = passThrough ? 0.0 : 1.0;
}

static BOOL AlaznahViewLooksLikeModalHost(UIView *view)
{
  NSString *name = NSStringFromClass(view.class);
  return [name containsString:@"ModalHost"] || [name containsString:@"RNModal"] ||
         [name containsString:@"RCTFabricModal"];
}

static void AlaznahApplyPassThroughInViewTree(UIView *root, BOOL passThrough)
{
  if (root == nil) {
    return;
  }
  if (AlaznahViewLooksLikeModalHost(root)) {
    AlaznahApplyPassThroughToView(root, passThrough);
    return;
  }
  for (UIView *subview in root.subviews) {
    AlaznahApplyPassThroughInViewTree(subview, passThrough);
  }
}

static void AlaznahApplyPassThroughInViewController(UIViewController *controller, BOOL passThrough)
{
  if (controller == nil) {
    return;
  }
  UIViewController *presented = controller.presentedViewController;
  if (presented != nil) {
    // RN <Modal> is a presented view controller. Make it invisible + non-interactive
    // so touches reach the app underneath while AVKit PiP keeps its sourceView.
    AlaznahApplyPassThroughToView(presented.view, passThrough);
    AlaznahApplyPassThroughInViewController(presented, passThrough);
  }
  for (UIViewController *child in controller.childViewControllers) {
    AlaznahApplyPassThroughInViewController(child, passThrough);
  }
}

static void AlaznahApplyModalPassThrough(BOOL passThrough)
{
  NSArray<UIWindow *> *windows = nil;
  if (@available(iOS 13.0, *)) {
    NSMutableArray<UIWindow *> *collected = [NSMutableArray array];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) {
        continue;
      }
      UIWindowScene *windowScene = (UIWindowScene *)scene;
      [collected addObjectsFromArray:windowScene.windows];
    }
    windows = collected;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    windows = UIApplication.sharedApplication.windows;
#pragma clang diagnostic pop
  }

  for (UIWindow *window in windows) {
    AlaznahApplyPassThroughInViewTree(window, passThrough);
    AlaznahApplyPassThroughInViewController(window.rootViewController, passThrough);
  }
}

static UIView *AlaznahFindPipRtcVideoViewInView(UIView *root)
{
  if (root == nil) {
    return nil;
  }
  NSString *name = NSStringFromClass(root.class);
  // react-native-webrtc RTCVideoView exposes startPIP when iosPIP is enabled.
  if ([name containsString:@"RTCVideoView"]) {
    if ([root respondsToSelector:NSSelectorFromString(@"startPIP")]) {
      return root;
    }
  }
  for (UIView *subview in root.subviews) {
    UIView *found = AlaznahFindPipRtcVideoViewInView(subview);
    if (found != nil) {
      return found;
    }
  }
  return nil;
}

static UIView *AlaznahFindPipRtcVideoView(void)
{
  NSArray<UIWindow *> *windows = nil;
  if (@available(iOS 13.0, *)) {
    NSMutableArray<UIWindow *> *collected = [NSMutableArray array];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) {
        continue;
      }
      [collected addObjectsFromArray:((UIWindowScene *)scene).windows];
    }
    windows = collected;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    windows = UIApplication.sharedApplication.windows;
#pragma clang diagnostic pop
  }
  // Prefer key window / presented modal (call UI) so we hit the live PiP source.
  for (UIWindow *window in windows) {
    if (!window.isKeyWindow) {
      continue;
    }
    UIView *found = AlaznahFindPipRtcVideoViewInView(window);
    if (found != nil) {
      return found;
    }
  }
  for (UIWindow *window in windows) {
    UIView *found = AlaznahFindPipRtcVideoViewInView(window);
    if (found != nil) {
      return found;
    }
  }
  return nil;
}

@implementation AlaznahCallingPip {
  BOOL _observingPipLifecycle;
  BOOL _modalPassThrough;
}

RCT_EXPORT_MODULE(AlaznahCallingPip)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"AlaznahCallingPipModeChanged" ];
}

- (void)startObserving
{
  if (_observingPipLifecycle) {
    return;
  }
  _observingPipLifecycle = YES;
  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  [center addObserver:self
             selector:@selector(onWebRtcPipActive:)
                 name:kAlaznahWebRTCPipWillStart
               object:nil];
  [center addObserver:self
             selector:@selector(onWebRtcPipActive:)
                 name:kAlaznahWebRTCPipDidStart
               object:nil];
  [center addObserver:self
             selector:@selector(onWebRtcPipActive:)
                 name:kAlaznahWebRTCPipWillStop
               object:nil];
  [center addObserver:self
             selector:@selector(onWebRtcPipInactive:)
                 name:kAlaznahWebRTCPipDidStop
               object:nil];
  [center addObserver:self
             selector:@selector(onWebRtcPipFailed:)
                 name:kAlaznahWebRTCPipFailed
               object:nil];
}

- (void)stopObserving
{
  if (!_observingPipLifecycle) {
    return;
  }
  _observingPipLifecycle = NO;
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)onWebRtcPipActive:(NSNotification *)notification
{
  NSString *name = notification.name;
  if ([name isEqualToString:kAlaznahWebRTCPipDidStart]) {
    NSLog(@"[PIP_DID_START]");
    _modalPassThrough = YES;
    AlaznahApplyModalPassThrough(YES);
    [self sendEventWithName:@"AlaznahCallingPipModeChanged" body:@{ @"active" : @YES }];
    return;
  }
  if ([name isEqualToString:kAlaznahWebRTCPipWillStart]) {
    NSLog(@"[PIP_START] willStart — not hiding CallingUI until didStart");
    return;
  }
  if ([name isEqualToString:kAlaznahWebRTCPipWillStop]) {
    NSLog(@"[PIP_START] willStop — restoring CallingUI for morph");
    _modalPassThrough = NO;
    AlaznahApplyModalPassThrough(NO);
    return;
  }
}

- (void)onWebRtcPipInactive:(NSNotification *)notification
{
  (void)notification;
  NSLog(@"[PIP_DID_STOP]");
  _modalPassThrough = NO;
  AlaznahApplyModalPassThrough(NO);
  [self sendEventWithName:@"AlaznahCallingPipModeChanged" body:@{ @"active" : @NO }];
}

- (void)onWebRtcPipFailed:(NSNotification *)notification
{
  NSString *error = notification.userInfo[@"error"];
  if (![error isKindOfClass:[NSString class]] || error.length == 0) {
    error = @"failedToStartPictureInPicture";
  }
  NSLog(@"[PIP_FAILED] %@", error);
  _modalPassThrough = NO;
  AlaznahApplyModalPassThrough(NO);
  [self sendEventWithName:@"AlaznahCallingPipModeChanged"
                     body:@{ @"active" : @NO, @"error" : error }];
}

/**
 * Visual PiP on iOS is driven by one react-native-webrtc `iosPIP` RTCView
 * (CallingUI keep-alive). Home uses canStartPictureInPictureAutomaticallyFromInline;
 * Minimize calls startIOSPIP on the same view. This module forwards AVKit
 * lifecycle to JS so the calling Modal can hide only after didStart.
 */
RCT_EXPORT_METHOD(setEnabled:(BOOL)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  resolve(@YES);
}

RCT_EXPORT_METHOD(setRemoteStreamUrl:(NSString *)url
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  resolve(@YES);
}

RCT_EXPORT_METHOD(isSupported:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
#if TARGET_OS_SIMULATOR
  resolve(@NO);
#else
  if (@available(iOS 15.0, *)) {
    resolve(@([AVPictureInPictureController isPictureInPictureSupported]));
  } else {
    resolve(@NO);
  }
#endif
}

RCT_EXPORT_METHOD(enter:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  // Broadcast to every live PIPController (react-native-webrtc). More reliable
  // than Fabric findNodeHandle / view-tree walk for Minimize.
  dispatch_async(dispatch_get_main_queue(), ^{
#if TARGET_OS_SIMULATOR
    NSLog(@"[PIP_ENTER] simulator — Picture in Picture unsupported");
    resolve(@NO);
    return;
#endif
    if (@available(iOS 15.0, *)) {
      if (![AVPictureInPictureController isPictureInPictureSupported]) {
        NSLog(@"[PIP_ENTER] PiP not supported on this device");
        resolve(@NO);
        return;
      }
      NSLog(@"[PIP_ENTER] posting AlaznahWebRTCPipRequestStart");
      [[NSNotificationCenter defaultCenter]
        postNotificationName:@"AlaznahWebRTCPipRequestStart"
                      object:nil];
      // Also try direct RTCVideoView startPIP as a second path.
      UIView *rtcView = AlaznahFindPipRtcVideoView();
      if (rtcView != nil) {
        SEL startSel = NSSelectorFromString(@"startPIP");
        if ([rtcView respondsToSelector:startSel]) {
          NSLog(@"[PIP_ENTER] direct startPIP on %@", NSStringFromClass(rtcView.class));
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
          [rtcView performSelector:startSel];
#pragma clang diagnostic pop
        }
      } else {
        NSLog(@"[PIP_ENTER] no RTCVideoView in hierarchy (notification still posted)");
      }
      resolve(@YES);
      return;
    }
    resolve(@NO);
  });
}

RCT_EXPORT_METHOD(isActive:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  resolve(@(_modalPassThrough));
}

/**
 * After AVKit didStart: hide the RN Modal window without destroying the
 * in-Modal RTCView (PiP source). Touches reach the app underneath.
 */
RCT_EXPORT_METHOD(setPipUiPassThrough:(BOOL)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_modalPassThrough = enabled;
    AlaznahApplyModalPassThrough(enabled);
    NSLog(@"[PIP_UI] modalPassThrough=%@", enabled ? @"YES" : @"NO");
    resolve(@YES);
  });
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

@end
