import AVFoundation
import CallKit
import Foundation
import PushKit
import UIKit

@objc(AlaznahCallingManager)
public final class AlaznahCallingManager: NSObject {
  @objc public static let shared = AlaznahCallingManager()

  @objc public var voipTokenHandler: ((NSDictionary) -> Void)?
  @objc public var incomingActionHandler: ((NSDictionary) -> Void)?
  @objc public var audioSessionHandler: ((NSDictionary) -> Void)?

  private let pendingActionKey = "alaznahCalling.pendingIncomingAction"
  private let httpBaseKey = "alaznahCalling.httpBase"
  private let userIdKey = "alaznahCalling.userId"
  private let callIdMapKey = "alaznahCalling.callIdByUUID"
  private let rejectTokenMapKey = "alaznahCalling.rejectTokens"
  private let actionTTL: TimeInterval = 70_000
  private var registry: PKPushRegistry?
  private var provider: CXProvider?
  private let callController = CXCallController()
  private var storedVoipToken: String?
  private var callIdsByUUID: [UUID: String] = [:]
  private var uuidsByCallId: [String: UUID] = [:]
  private var metadataByCallId: [String: (callerId: String, mediaType: String, isIncoming: Bool)] = [:]
  private var callKitRegisteredIds = Set<String>()
  /// Call IDs where CXStartCallAction (or incoming report) actually succeeded.
  private var callKitLiveIds = Set<String>()
  private var localizedName: String = "Audio Video Call"

  private override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handlePipActionNotification(_:)),
      name: Notification.Name("AlaznahCallingPipAction"),
      object: nil
    )
  }

  @objc private func handlePipActionNotification(_ note: Notification) {
    let action = (note.userInfo?["action"] as? String) ?? ""
    // Prefer the live CallKit / active mapped call.
    let callId = callKitLiveIds.first ?? uuidsByCallId.keys.first ?? ""
    guard !callId.isEmpty, !action.isEmpty else { return }
    NSLog("[AlaznahCalling] PiP overlay action=%@ callId=%@", action, callId)
    publish(action: action, callId: callId)
  }

  @objc public func configure() {
    configure(withAppName: localizedName)
  }

  @objc(configureWithAppName:)
  public func configure(withAppName appName: String?) {
    if let appName, !appName.isEmpty {
      localizedName = appName
    }
    restoreCallIdMap()
    guard registry == nil else { return }
    if !Thread.isMainThread {
      DispatchQueue.main.async { [weak self] in self?.configure(withAppName: appName) }
      return
    }

    let configuration = CXProviderConfiguration(localizedName: localizedName)
    configuration.supportsVideo = true
    configuration.maximumCallsPerCallGroup = 1
    configuration.maximumCallGroups = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = false

    let provider = CXProvider(configuration: configuration)
    provider.setDelegate(self, queue: .main)
    self.provider = provider

    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
  }

  @objc(configureCallEndpointWithHttpBaseUrl:userId:)
  public func configureCallEndpoint(httpBaseUrl: String, userId: String) {
    let base = httpBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    let uid = userId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !base.isEmpty, !uid.isEmpty else { return }
    UserDefaults.standard.set(base, forKey: httpBaseKey)
    UserDefaults.standard.set(uid, forKey: userIdKey)
    NSLog("[AlaznahCalling] configureCallEndpoint base=%@ userId=%@", base, uid)
  }

  @objc(storeRejectTokenForCallId:token:)
  public func storeRejectToken(callId: String, token: String) {
    let id = callId.trimmingCharacters(in: .whitespacesAndNewlines)
    let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !id.isEmpty, !value.isEmpty else { return }
    var map =
      UserDefaults.standard.dictionary(forKey: rejectTokenMapKey) as? [String: String] ?? [:]
    map[id] = value
    UserDefaults.standard.set(map, forKey: rejectTokenMapKey)
  }

  private func readRejectToken(for callId: String) -> String {
    let map =
      UserDefaults.standard.dictionary(forKey: rejectTokenMapKey) as? [String: String] ?? [:]
    return map[callId]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  @objc public func voipToken() -> String? {
    storedVoipToken
  }

  @objc(reportIncomingCall:callerId:mediaType:completion:)
  public func reportIncomingCall(
    _ callId: String,
    callerId: String,
    mediaType: String,
    completion: ((NSError?) -> Void)?
  ) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.reportIncomingCall(
          callId,
          callerId: callerId,
          mediaType: mediaType,
          completion: completion
        )
      }
      return
    }

    configure()
    metadataByCallId[callId] = (callerId, mediaType, true)

    #if targetEnvironment(simulator)
    // CallKit cannot present incoming calls on the Simulator: the CallKit host
    // immediately commits a CXEndCallAction, which the SDK would interpret as a
    // user decline and auto-reject the call. The JS incoming screen covers UX.
    completion?(nil)
    #else
    let uuid = uuid(for: callId)
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerId)
    let isVideo = mediaType.lowercased() == "video"
    update.localizedCallerName = isVideo ? "\(callerId) · Video call" : "\(callerId) · Voice call"
    update.hasVideo = isVideo
    update.supportsHolding = false
    update.supportsDTMF = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    provider?.reportNewIncomingCall(with: uuid, update: update) { error in
      if error == nil {
        // Live = CallKit UI shown. Do NOT mark registered here — registered means
        // Answer/Start happened. Decline while only live must run rejectViaHttp.
        self.callKitLiveIds.insert(callId)
      }
      completion?(error as NSError?)
    }
    #endif
  }

  @objc public func endCall(_ callId: String) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.endCall(callId) }
      return
    }
    guard let uuid = uuidsByCallId[callId] else { return }
    // reportCall(endedAt:) — do NOT request CXEndCallAction here or we re-enter
    // provider(_:perform: CXEndCallAction) and publish a duplicate "end" to JS.
    provider?.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
    callKitRegisteredIds.remove(callId)
    remove(callId: callId, uuid: uuid)
  }

  @objc(reportOutgoingCall:peerId:mediaType:completion:)
  public func reportOutgoingCall(
    _ callId: String,
    peerId: String,
    mediaType: String,
    completion: ((NSError?) -> Void)?
  ) {
    registerCallKitSession(
      callId: callId,
      peerId: peerId,
      mediaType: mediaType,
      outgoing: true,
      markConnected: false,
      completion: completion
    )
  }

  @objc(reportOngoingCall:peerId:mediaType:completion:)
  public func reportOngoingCall(
    _ callId: String,
    peerId: String,
    mediaType: String,
    completion: ((NSError?) -> Void)?
  ) {
    registerCallKitSession(
      callId: callId,
      peerId: peerId,
      mediaType: mediaType,
      outgoing: false,
      markConnected: true,
      completion: completion
    )
  }

  @objc(reportCallConnected:)
  public func reportCallConnected(_ callId: String) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.reportCallConnected(callId) }
      return
    }
    guard let uuid = uuidsByCallId[callId] else { return }
    markCallKitConnected(callId: callId, uuid: uuid)
  }

  private func callUpdate(peerId: String, mediaType: String) -> CXCallUpdate {
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: peerId)
    let isVideo = mediaType.lowercased() == "video"
    update.localizedCallerName = isVideo ? "\(peerId) · Video call" : "\(peerId) · Voice call"
    update.hasVideo = isVideo
    update.supportsHolding = false
    update.supportsDTMF = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    return update
  }

  /// Marks a CallKit session connected — required for PiP mute/end chrome.
  private func markCallKitConnected(callId: String, uuid: UUID) {
    guard let meta = metadataByCallId[callId] else { return }
    let update = callUpdate(peerId: meta.callerId, mediaType: meta.mediaType)
    provider?.reportCall(with: uuid, updated: update)
    // connectedAt is only valid for outgoing / CXStartCallAction sessions.
    if !meta.isIncoming {
      provider?.reportOutgoingCall(with: uuid, connectedAt: Date())
    }
    callKitRegisteredIds.insert(callId)
    callKitLiveIds.insert(callId)
    NSLog("[AlaznahCalling] CallKit connected callId=%@ incoming=%@ video=%@ live=%@",
          callId,
          meta.isIncoming ? "YES" : "NO",
          meta.mediaType.lowercased() == "video" ? "YES" : "NO",
          callKitLiveIds.contains(callId) ? "YES" : "NO")
  }

  private func registerCallKitSession(
    callId: String,
    peerId: String,
    mediaType: String,
    outgoing: Bool,
    markConnected: Bool,
    completion: ((NSError?) -> Void)?
  ) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.registerCallKitSession(
          callId: callId,
          peerId: peerId,
          mediaType: mediaType,
          outgoing: outgoing,
          markConnected: markConnected,
          completion: completion
        )
      }
      return
    }

    configure()

    #if targetEnvironment(simulator)
    completion?(nil)
    return
    #endif

    metadataByCallId[callId] = (
      peerId,
      mediaType,
      // Preserve incoming flag only when we already have a live incoming session.
      (metadataByCallId[callId]?.isIncoming ?? false) && callKitLiveIds.contains(callId)
    )

    // Live CallKit session already exists — just mark connected for PiP chrome.
    if callKitLiveIds.contains(callId), let uuid = uuidsByCallId[callId] {
      if markConnected || !outgoing {
        markCallKitConnected(callId: callId, uuid: uuid)
      }
      completion?(nil)
      return
    }

    // Orphan UUID from a failed prior start — clear so we can retry cleanly.
    if let stale = uuidsByCallId[callId], !callKitLiveIds.contains(callId) {
      NSLog("[AlaznahCalling] clearing orphan CallKit uuid for callId=%@", callId)
      callIdsByUUID.removeValue(forKey: stale)
      uuidsByCallId.removeValue(forKey: callId)
      callKitRegisteredIds.remove(callId)
    }

    // Zoom pattern: CXStartCallAction → fulfill → startedConnecting → connectedAt.
    // Do this when media is up so CallKit owns an active call (PiP mute/end).
    let uuid = uuid(for: callId)
    let handle = CXHandle(type: .generic, value: peerId)
    let isVideo = mediaType.lowercased() == "video"
    // Fresh CXStartCallAction sessions are outgoing from CallKit's POV.
    metadataByCallId[callId] = (peerId, mediaType, false)

    let action = CXStartCallAction(call: uuid, handle: handle)
    action.isVideo = isVideo
    action.contactIdentifier = peerId

    NSLog("[AlaznahCalling] requesting CXStartCallAction callId=%@ video=%@", callId, isVideo ? "YES" : "NO")

    callController.request(CXTransaction(action: action)) { [weak self] error in
      guard let self else {
        completion?(nil)
        return
      }
      if let error = error as NSError? {
        NSLog("[AlaznahCalling] CXStartCallAction failed: %@ (%ld)", error.localizedDescription, error.code)
        // Allow a later retry — do not leave a fake "existing" session.
        DispatchQueue.main.async {
          self.callIdsByUUID.removeValue(forKey: uuid)
          self.uuidsByCallId.removeValue(forKey: callId)
          self.callKitRegisteredIds.remove(callId)
          self.callKitLiveIds.remove(callId)
          self.persistCallIdMap()
        }
        completion?(error)
        return
      }
      DispatchQueue.main.async {
        self.callKitRegisteredIds.insert(callId)
        self.callKitLiveIds.insert(callId)
        self.provider?.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
        let update = self.callUpdate(peerId: peerId, mediaType: mediaType)
        self.provider?.reportCall(with: uuid, updated: update)
        if markConnected {
          // Let CallKit process startedConnecting before connectedAt.
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.markCallKitConnected(callId: callId, uuid: uuid)
            completion?(nil)
          }
        } else {
          completion?(nil)
        }
      }
    }
  }

  @objc public func endAllCalls() {
    let callIds = Array(uuidsByCallId.keys)
    callIds.forEach(endCall)
  }

  /// Front (`user`) / back (`environment`) — whether that camera has a torch LED.
  @objc(hasCameraTorchForFacingMode:)
  public func hasCameraTorch(forFacingMode facingMode: String) -> Bool {
    guard let device = Self.videoDevice(forFacingMode: facingMode) else { return false }
    return device.hasTorch && device.isTorchAvailable
  }

  /// Toggle torch on the camera matching facing mode. Returns whether torch is now on.
  @objc public func setCameraTorchEnabled(_ enabled: Bool, facingMode: String) -> Bool {
    guard let device = Self.videoDevice(forFacingMode: facingMode),
          device.hasTorch,
          device.isTorchAvailable
    else {
      return false
    }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      if enabled {
        try device.setTorchModeOn(level: 1.0)
      } else {
        device.torchMode = .off
      }
      return device.torchMode == .on
    } catch {
      return false
    }
  }

  private static func videoDevice(forFacingMode facingMode: String) -> AVCaptureDevice? {
    let position: AVCaptureDevice.Position =
      facingMode.lowercased() == "environment" ? .back : .front
    if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) {
      return device
    }
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera, .builtInDualCamera, .builtInTrueDepthCamera],
      mediaType: .video,
      position: position
    )
    return discovery.devices.first
  }

  @objc public func consumePendingAction() -> NSDictionary? {
    let defaults = UserDefaults.standard
    guard
      let payload = defaults.dictionary(forKey: pendingActionKey),
      let timestamp = payload["timestamp"] as? Double
    else {
      return nil
    }
    defaults.removeObject(forKey: pendingActionKey)
    guard Date().timeIntervalSince1970 * 1_000 - timestamp <= actionTTL else {
      return nil
    }
    return payload as NSDictionary
  }

  private func uuid(for callId: String) -> UUID {
    if let known = uuidsByCallId[callId] {
      return known
    }
    let uuid = UUID(uuidString: callId) ?? UUID()
    uuidsByCallId[callId] = uuid
    callIdsByUUID[uuid] = callId
    persistCallIdMap()
    return uuid
  }

  private func resolveCallId(for actionUUID: UUID) -> String {
    if let known = callIdsByUUID[actionUUID] {
      return known
    }
    // Process may have restarted after VoIP report — restore from disk.
    restoreCallIdMap()
    if let known = callIdsByUUID[actionUUID] {
      return known
    }
    return actionUUID.uuidString
  }

  private func persistCallIdMap() {
    var stored: [String: String] = [:]
    for (uuid, callId) in callIdsByUUID {
      stored[uuid.uuidString] = callId
    }
    UserDefaults.standard.set(stored, forKey: callIdMapKey)
  }

  private func restoreCallIdMap() {
    guard let stored = UserDefaults.standard.dictionary(forKey: callIdMapKey) as? [String: String]
    else { return }
    for (uuidString, callId) in stored {
      guard let uuid = UUID(uuidString: uuidString) else { continue }
      callIdsByUUID[uuid] = callId
      uuidsByCallId[callId] = uuid
    }
  }

  private func remove(callId: String, uuid: UUID) {
    uuidsByCallId.removeValue(forKey: callId)
    callIdsByUUID.removeValue(forKey: uuid)
    metadataByCallId.removeValue(forKey: callId)
    callKitRegisteredIds.remove(callId)
    callKitLiveIds.remove(callId)
    persistCallIdMap()
  }

  private func publish(action: String, callId: String) {
    let metadata = metadataByCallId[callId]
    let payload: NSDictionary = [
      "action": action,
      "callId": callId,
      "callerId": metadata?.callerId ?? "",
      "mediaType": metadata?.mediaType ?? "audio",
      "timestamp": Date().timeIntervalSince1970 * 1_000,
    ]
    UserDefaults.standard.set(payload, forKey: pendingActionKey)
    NSLog("[AlaznahCalling] publish action=%@ callId=%@", action, callId)
    incomingActionHandler?(payload)
  }

  private func storeCallEndpointFromPush(_ data: [AnyHashable: Any]) {
    func clean(_ value: Any?) -> String {
      let raw = String(describing: value ?? "")
      if raw == "<null>" || raw == "nil" { return "" }
      return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let httpBase = clean(data["signalingHttp"])
    let userId = clean(data["calleeId"])
    if !httpBase.isEmpty, !userId.isEmpty {
      configureCallEndpoint(httpBaseUrl: httpBase, userId: userId)
    }
    let callId = clean(data["callId"])
    let rejectToken = clean(data["rejectToken"])
    if !callId.isEmpty, !rejectToken.isEmpty {
      storeRejectToken(callId: callId, token: rejectToken)
    }
  }

  private func httpRejectCandidates(from base: String) -> [String] {
    var candidates: [String] = []
    let trimmed = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if !trimmed.isEmpty { candidates.append(trimmed) }
    if base.hasPrefix("ws://") {
      candidates.append("http://" + String(base.dropFirst(5)).trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    } else if base.hasPrefix("wss://") {
      candidates.append("https://" + String(base.dropFirst(6)).trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }
    var seen = Set<String>()
    return candidates.filter { seen.insert($0).inserted }
  }

  private func rejectViaHttp(callId: String) {
    guard
      let base = UserDefaults.standard.string(forKey: httpBaseKey)?.trimmingCharacters(in: .whitespacesAndNewlines),
      let userId = UserDefaults.standard.string(forKey: userIdKey)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !callId.isEmpty,
      !base.isEmpty,
      !userId.isEmpty
    else {
      NSLog(
        "[AlaznahCalling] rejectViaHttp skipped — missing endpoint callId=%@ base=%@ userId=%@",
        callId,
        UserDefaults.standard.string(forKey: httpBaseKey) ?? "",
        UserDefaults.standard.string(forKey: userIdKey) ?? ""
      )
      return
    }

    let rejectToken = readRejectToken(for: callId)
    guard !rejectToken.isEmpty else {
      NSLog("[AlaznahCalling] rejectViaHttp skipped — missing rejectToken callId=%@", callId)
      return
    }

    let payload: [String: Any] = [
      "callId": callId,
      "userId": userId,
      "reason": "declined",
      "rejectToken": rejectToken,
    ]
    guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }

    for candidate in httpRejectCandidates(from: base) {
      guard let url = URL(string: candidate + "/call/reject") else { continue }
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
      request.timeoutInterval = 8

      let task = URLSession.shared.dataTask(with: request) { _, response, error in
        if let error {
          NSLog("[AlaznahCalling] rejectViaHttp failed url=%@ err=%@", candidate, error.localizedDescription)
          return
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        NSLog("[AlaznahCalling] rejectViaHttp status=%ld url=%@ callId=%@", code, candidate, callId)
      }
      task.resume()
      return
    }
  }

  private static func currentApplicationState() -> UIApplication.State {
    if Thread.isMainThread {
      return UIApplication.shared.applicationState
    }
    var state: UIApplication.State = .background
    DispatchQueue.main.sync {
      state = UIApplication.shared.applicationState
    }
    return state
  }
}

extension AlaznahCallingManager: PKPushRegistryDelegate {
  public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    storedVoipToken = token
    voipTokenHandler?(["token": token])
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didInvalidatePushTokenFor type: PKPushType
  ) {
    if type == .voIP {
      storedVoipToken = nil
    }
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }

    let root = payload.dictionaryPayload
    let data = (root["data"] as? [AnyHashable: Any]) ?? root
    let callId = String(describing: data["callId"] ?? UUID().uuidString)
    let type = String(describing: data["type"] ?? "incoming_call")

    // Caller hung up — end existing CallKit UI only. Never report a NEW incoming
    // call here (that causes a 1s re-ring flash). Unknown UUIDs are ignored;
    // PushKit cancel delivery is optional and Android uses FCM instead.
    if type == "call_canceled" || type == "call_cancelled" {
      if uuidsByCallId[callId] != nil {
        endCall(callId)
      }
      completion()
      return
    }

    let callerId = String(
      describing: data["callerId"] ?? data["handle"] ?? "Incoming call"
    )
    let mediaType = String(describing: data["mediaType"] ?? "audio")
    storeCallEndpointFromPush(data)

    // Foreground: WebSocket + in-app UI already own incoming UX. Reporting
    // CallKit here duplicates the ringing screen the user sees when app is open.
    let appState = Self.currentApplicationState()
    if appState == .active || appState == .inactive {
      completion()
      return
    }

    reportIncomingCall(
      callId,
      callerId: callerId,
      mediaType: mediaType
    ) { _ in completion() }
  }
}

extension AlaznahCallingManager: CXProviderDelegate {
  public func providerDidReset(_ provider: CXProvider) {
    callIdsByUUID.removeAll()
    uuidsByCallId.removeAll()
    metadataByCallId.removeAll()
    callKitRegisteredIds.removeAll()
    callKitLiveIds.removeAll()
  }

  public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    let anyVideoLive = metadataByCallId.contains { callId, meta in
      callKitLiveIds.contains(callId) && meta.mediaType.lowercased() == "video"
    }
    let mode: AVAudioSession.Mode = anyVideoLive ? .videoChat : .voiceChat
    do {
      try audioSession.setCategory(
        .playAndRecord,
        mode: mode,
        options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
      )
      try audioSession.setActive(true)
      if anyVideoLive {
        try audioSession.overrideOutputAudioPort(.speaker)
      }
    } catch {
      NSLog("[AlaznahCalling] didActivate audio config failed: %@", error.localizedDescription)
    }
    // Notify WebRTC that CallKit activated the shared audio session.
    audioSessionHandler?(["active": true])
  }

  public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    // Only tell WebRTC to release audio when no live CallKit calls remain.
    // Ending a stale CXCall must not kill an active WebRTC call's audio.
    if callKitLiveIds.isEmpty {
      audioSessionHandler?(["active": false])
    }
  }

  public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    let callId = resolveCallId(for: action.callUUID)
    callKitRegisteredIds.insert(callId)
    callKitLiveIds.insert(callId)
    NSLog("[AlaznahCalling] CallKit answer callId=%@", callId)
    publish(action: "accept", callId: callId)
    action.fulfill()
    // Incoming call is now active — update CallKit so PiP controls appear.
    markCallKitConnected(callId: callId, uuid: action.callUUID)
  }

  public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    let callId = resolveCallId(for: action.callUUID)
    callKitRegisteredIds.insert(callId)
    callKitLiveIds.insert(callId)
    NSLog("[AlaznahCalling] CallKit start fulfilled callId=%@", callId)
    // Audio session is activated by CallKit via provider(_:didActivate:) after fulfill.
    action.fulfill()
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
  }

  public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    let callId = resolveCallId(for: action.callUUID)
    NSLog("[AlaznahCalling] CallKit mute=%@ callId=%@", action.isMuted ? "YES" : "NO", callId)
    publish(action: action.isMuted ? "mute" : "unmute", callId: callId)
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let callId = resolveCallId(for: action.callUUID)
    NSLog("[AlaznahCalling] CallKit end callId=%@", callId)
    if callKitRegisteredIds.contains(callId) {
      publish(action: "end", callId: callId)
    } else {
      rejectViaHttp(callId: callId)
      publish(action: "decline", callId: callId)
    }
    remove(callId: callId, uuid: action.callUUID)
    action.fulfill()
  }
}
