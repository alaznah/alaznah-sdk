#import "AlaznahCallingPip.h"

#import <AVKit/AVKit.h>
#import <QuartzCore/QuartzCore.h>
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
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  view.alpha = passThrough ? 0.02 : 1.0;
  [CATransaction commit];
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

static void AlaznahApplyPassThroughInViewController(UIViewController *controller, BOOL passThrough);
static UIView *AlaznahFindPipRtcVideoViewInView(UIView *root);

static void AlaznahApplyPassThroughInViewController(UIViewController *controller, BOOL passThrough)
{
  if (controller == nil) {
    return;
  }
  UIViewController *presented = controller.presentedViewController;
  if (presented != nil) {
    // Only the presented Modal view — never the shared key window alpha
    // (that made the whole app look black under PiP).
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
    if (!window.isKeyWindow && AlaznahFindPipRtcVideoViewInView(window) != nil) {
      UIView *target = window.rootViewController.view;
      if (target != nil) {
        AlaznahApplyPassThroughToView(target, passThrough);
      }
    }
  }
}

static UIView *AlaznahFindPipRtcVideoViewInView(UIView *root)
{
  if (root == nil) {
    return nil;
  }
  NSString *name = NSStringFromClass(root.class);
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

@implementation AlaznahCallingPip {
  BOOL _observingPipLifecycle;
  BOOL _modalPassThrough;
  BOOL _pipSessionActive;
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
    _pipSessionActive = YES;
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
    NSLog(@"[PIP_START] willStop — keep Modal pass-through until didStop (no slide)");
    _pipSessionActive = NO;
    return;
  }
}

- (void)onWebRtcPipInactive:(NSNotification *)notification
{
  (void)notification;
  NSLog(@"[PIP_DID_STOP]");
  _pipSessionActive = NO;
  _modalPassThrough = NO;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  AlaznahApplyModalPassThrough(NO);
  [CATransaction commit];
  [self sendEventWithName:@"AlaznahCallingPipModeChanged" body:@{ @"active" : @NO }];
}

- (void)onWebRtcPipFailed:(NSNotification *)notification
{
  NSString *error = notification.userInfo[@"error"];
  if (![error isKindOfClass:[NSString class]] || error.length == 0) {
    error = @"failedToStartPictureInPicture";
  }
  NSLog(@"[PIP_FAILED] %@", error);
  _pipSessionActive = NO;
  _modalPassThrough = NO;
  AlaznahApplyModalPassThrough(NO);
  [self sendEventWithName:@"AlaznahCallingPipModeChanged"
                     body:@{ @"active" : @NO, @"error" : error }];
}

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

RCT_EXPORT_METHOD(setRemoteVideoActive:(BOOL)active
                  initials:(NSString *)initials
                  avatarUrl:(NSString *)avatarUrl
                  surfaceColor:(NSString *)surfaceColor
                  accentColor:(NSString *)accentColor
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  (void)avatarUrl;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSMutableDictionary *info = [NSMutableDictionary dictionary];
    info[@"active"] = @(!active); // placeholder when camera OFF
    if ([surfaceColor isKindOfClass:[NSString class]] && surfaceColor.length > 0) {
      info[@"surfaceColor"] = surfaceColor;
    }
    if ([accentColor isKindOfClass:[NSString class]] && accentColor.length > 0) {
      info[@"accentColor"] = accentColor;
    }
    if ([initials isKindOfClass:[NSString class]] && initials.length > 0) {
      info[@"initials"] = initials;
    }
    [[NSNotificationCenter defaultCenter] postNotificationName:@"AlaznahWebRTCPipSetPlaceholder"
                                                        object:nil
                                                      userInfo:info];
    resolve(@YES);
  });
}

RCT_EXPORT_METHOD(prepareTeardown:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    // Stop AVKit PiP + detach sample renderers before JS nulls streams / unmounts RTCView.
    [[NSNotificationCenter defaultCenter] postNotificationName:@"AlaznahWebRTCPipPrepareTeardown"
                                                      object:nil];
    resolve(@YES);
  });
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
  // Same PiP controller Home uses — one startPIP request, then shared lifecycle.
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
      NSLog(@"[PIP_ENTER] posting AlaznahWebRTCPipRequestStart (same path as Home PiP)");
      [[NSNotificationCenter defaultCenter]
        postNotificationName:@"AlaznahWebRTCPipRequestStart"
                      object:nil];
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

RCT_EXPORT_METHOD(setPipUiPassThrough:(BOOL)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    // Ignore JS false while PiP is live (effect cleanup race → black Modal / no app).
    if (!enabled && self->_pipSessionActive) {
      NSLog(@"[PIP_UI] ignore passThrough=NO while PiP session active");
      resolve(@YES);
      return;
    }
    self->_modalPassThrough = enabled;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    AlaznahApplyModalPassThrough(enabled);
    [CATransaction commit];
    NSLog(@"[PIP_UI] modalPassThrough=%@", enabled ? @"YES" : @"NO");
    resolve(@YES);
  });
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

@end
