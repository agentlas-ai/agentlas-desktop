import AppKit
import ApplicationServices
import Foundation

// AgentlasInputDriver is deliberately a small, single-request executable.
// The Electron main process owns authorization, validation, serialization and
// audit. This helper only translates one already-approved JSON request into
// CoreGraphics/AppKit calls, then exits. It never opens a socket or executes a
// shell command.

let maxInputBytes = 128 * 1024

func respond(_ value: [String: Any], exitCode: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [])) ?? Data("{\"ok\":false,\"error\":\"serialization-failed\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    Foundation.exit(exitCode)
}

func failure(_ error: String, message: String, exitCode: Int32 = 1) -> Never {
    respond(["ok": false, "error": error, "message": message], exitCode: exitCode)
}

func number(_ request: [String: Any], _ key: String) -> Double? {
    guard let value = request[key] as? NSNumber else { return nil }
    let result = value.doubleValue
    return result.isFinite ? result : nil
}

func integer(_ request: [String: Any], _ key: String) -> Int? {
    guard let value = request[key] as? NSNumber else { return nil }
    let result = value.intValue
    return Double(result) == value.doubleValue ? result : nil
}

func activeDisplayBounds() -> [CGRect] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
}

func pointIsOnActiveDisplay(_ point: CGPoint) -> Bool {
    activeDisplayBounds().contains { $0.contains(point) }
}

func validatedPoint(_ request: [String: Any], xKey: String = "x", yKey: String = "y") -> CGPoint? {
    guard let x = number(request, xKey), let y = number(request, yKey) else { return nil }
    let point = CGPoint(x: x, y: y)
    return pointIsOnActiveDisplay(point) ? point : nil
}

func ensureAccessibility() {
    guard AXIsProcessTrusted() else {
        failure(
            "accessibility-permission-required",
            message: "Enable Agentlas in System Settings > Privacy & Security > Accessibility.",
            exitCode: 77
        )
    }
}

func mouseDefinition(_ raw: String) -> (CGMouseButton, CGEventType, CGEventType, CGEventType)? {
    switch raw.lowercased() {
    case "left": return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return nil
    }
}

func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64? = nil) {
    guard let event = CGEvent(
        mouseEventSource: CGEventSource(stateID: .hidSystemState),
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: button
    ) else {
        failure("event-create-failed", message: "macOS could not create a mouse event.")
    }
    if let clickState { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
    event.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49,
    "`": 50, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
    "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109,
    "f12": 111, "f15": 113, "home": 115, "pageup": 116, "page_up": 116,
    "forwarddelete": 117, "forward_delete": 117, "f4": 118, "end": 119,
    "f2": 120, "pagedown": 121, "page_down": 121, "f1": 122,
    "left": 123, "right": 124, "down": 125, "up": 126
]

func eventFlags(_ raw: Any?) -> CGEventFlags? {
    guard raw == nil || raw is [Any] else { return nil }
    let modifiers = raw as? [Any] ?? []
    var flags: CGEventFlags = []
    for value in modifiers {
        guard let modifier = value as? String else { return nil }
        switch modifier.lowercased() {
        case "command", "cmd", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option", "alt": flags.insert(.maskAlternate)
        case "control", "ctrl": flags.insert(.maskControl)
        case "fn", "function": flags.insert(.maskSecondaryFn)
        default: return nil
        }
    }
    return flags
}

func postKey(code: CGKeyCode, keyDown: Bool, flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: keyDown) else {
        failure("event-create-failed", message: "macOS could not create a keyboard event.")
    }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func postKeyChord(code: CGKeyCode, flags: CGEventFlags) {
    // CGEvent consumers use the event flags as the authoritative modifier
    // state. Posting synthetic modifier-key transitions around the chord is
    // timing-sensitive with Chromium/IME input and can leave Command+A/V as an
    // ordinary key. Keep one deterministic down/up pair with exact flags.
    postKey(code: code, keyDown: true, flags: flags)
    Thread.sleep(forTimeInterval: 0.012)
    postKey(code: code, keyDown: false, flags: flags)
    Thread.sleep(forTimeInterval: 0.012)
}

func postUnicodeText(_ text: String) {
    let units = Array(text.utf16)
    var offset = 0
    while offset < units.count {
        let end = min(offset + 32, units.count)
        let chunk = Array(units[offset..<end])
        guard let down = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: 0, keyDown: false) else {
            failure("event-create-failed", message: "macOS could not create a text event.")
        }
        chunk.withUnsafeBufferPointer { pointer in
            guard let base = pointer.baseAddress else { return }
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: base)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        // CGEventPost is asynchronous. Keep the one-shot helper alive long
        // enough for the window server to consume each Unicode chunk.
        Thread.sleep(forTimeInterval: 0.015)
        offset = end
    }
}

func focusedAccessibilityElement(targetPid: pid_t? = nil) -> AXUIElement? {
    // The system-wide object is the authoritative source for the currently
    // focused control. Chromium/Electron applications do not consistently
    // expose kAXFocusedUIElement on their application AX element even though
    // the focused input itself is writable.
    let system = AXUIElementCreateSystemWide()
    var systemValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &systemValue) == .success,
       let systemValue {
        let element = systemValue as! AXUIElement
        if let targetPid {
            var ownerPid: pid_t = 0
            if AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == targetPid {
                return element
            }
        } else {
            return element
        }
    }

    guard let targetPid else { return nil }
    let application = AXUIElementCreateApplication(targetPid)
    var appValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &appValue) == .success,
          let appValue else { return nil }
    return (appValue as! AXUIElement)
}

func replaceSelectedText(_ text: String, targetPid: pid_t? = nil) -> Bool {
    guard let element = focusedAccessibilityElement(targetPid: targetPid) else { return false }
    return AXUIElementSetAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        text as CFString
    ) == .success
}

func replaceSelectedTextUsingValue(_ replacement: String, targetPid: pid_t? = nil) -> Bool {
    guard let element = focusedAccessibilityElement(targetPid: targetPid) else { return false }
    var rawValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &rawValue) == .success,
          let current = rawValue as? String else { return false }
    let currentText = current as NSString
    var range = CFRange(location: currentText.length, length: 0)
    var rawRange: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rawRange) == .success,
       let rawRange, CFGetTypeID(rawRange) == AXValueGetTypeID() {
        var selected = CFRange()
        if AXValueGetValue(rawRange as! AXValue, .cfRange, &selected),
           selected.location >= 0, selected.length >= 0,
           selected.location + selected.length <= currentText.length {
            range = selected
        }
    }
    let updated = currentText.replacingCharacters(
        in: NSRange(location: range.location, length: range.length),
        with: replacement
    )
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, updated as CFString) == .success else {
        return false
    }
    var next = CFRange(location: range.location + (replacement as NSString).length, length: 0)
    if let nextValue = AXValueCreate(.cfRange, &next) {
        _ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, nextValue)
    }
    return true
}

func selectAllFocusedText(targetPid: pid_t? = nil) -> Bool {
    guard let element = focusedAccessibilityElement(targetPid: targetPid) else { return false }
    var rawValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &rawValue) == .success,
          let text = rawValue as? String else { return false }
    var range = CFRange(location: 0, length: (text as NSString).length)
    guard let value = AXValueCreate(.cfRange, &range) else { return false }
    return AXUIElementSetAttributeValue(
        element,
        kAXSelectedTextRangeAttribute as CFString,
        value
    ) == .success
}

struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]
}

func snapshotGeneralPasteboard(maxBytes: Int = 16 * 1024 * 1024) -> PasteboardSnapshot? {
    let pasteboard = NSPasteboard.general
    var total = 0
    var snapshots: [[NSPasteboard.PasteboardType: Data]] = []
    for item in pasteboard.pasteboardItems ?? [] {
        var values: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types {
            guard let data = item.data(forType: type) else { continue }
            total += data.count
            if total > maxBytes { return nil }
            values[type] = data
        }
        snapshots.append(values)
    }
    return PasteboardSnapshot(items: snapshots)
}

func restoreGeneralPasteboard(_ snapshot: PasteboardSnapshot) -> Bool {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    if snapshot.items.isEmpty { return true }
    let items = snapshot.items.map { values -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in values { item.setData(data, forType: type) }
        return item
    }
    return pasteboard.writeObjects(items)
}

func pasteUnicodeTextPreservingClipboard(_ text: String) -> (pasted: Bool, restored: Bool) {
    guard let snapshot = snapshotGeneralPasteboard() else { return (false, false) }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    guard pasteboard.setString(text, forType: .string) else {
        _ = restoreGeneralPasteboard(snapshot)
        return (false, false)
    }
    let temporaryChangeCount = pasteboard.changeCount
    postKeyChord(code: 9, flags: [.maskCommand])
    Thread.sleep(forTimeInterval: 0.2)
    // Never overwrite a clipboard that another app/user changed while the
    // paste was in flight. In the normal path, restore every original type.
    guard pasteboard.changeCount == temporaryChangeCount else { return (true, false) }
    return (true, restoreGeneralPasteboard(snapshot))
}

func raiseApplicationWindow(pid: pid_t) {
    let application = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    var rawWindow: CFTypeRef?
    var copied = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &rawWindow)
    if copied != .success || rawWindow == nil {
        copied = AXUIElementCopyAttributeValue(application, kAXMainWindowAttribute as CFString, &rawWindow)
    }
    guard copied == .success, let rawWindow else { return }
    let window = rawWindow as! AXUIElement
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty, input.count <= maxInputBytes else {
    failure("invalid-request", message: "Input must be a non-empty JSON object under 128 KiB.", exitCode: 64)
}
guard let json = try? JSONSerialization.jsonObject(with: input), let request = json as? [String: Any],
      let action = request["action"] as? String else {
    failure("invalid-request", message: "Input must contain a string action.", exitCode: 64)
}

switch action {
case "status":
    let location = CGEvent(source: nil)?.location
    respond([
        "ok": true,
        "accessibility": AXIsProcessTrusted(),
        "cursor": location.map { ["x": $0.x, "y": $0.y] } as Any,
        "displayCount": activeDisplayBounds().count
    ])

case "listApps":
    let apps = NSWorkspace.shared.runningApplications
        .filter { !$0.isTerminated && $0.activationPolicy != .prohibited }
        .prefix(100)
        .map { app -> [String: Any] in
            [
                "name": app.localizedName ?? "Unknown",
                "bundleIdentifier": app.bundleIdentifier as Any,
                "pid": Int(app.processIdentifier),
                "active": app.isActive
            ]
        }
    respond(["ok": true, "apps": Array(apps)])

case "focusApp":
    guard let target = request["app"] as? String, !target.isEmpty, target.count <= 160 else {
        failure("invalid-app", message: "app must be a non-empty string under 160 characters.", exitCode: 64)
    }
    let needle = target.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    let requestedPid: pid_t? = {
        guard needle.hasPrefix("pid:"), let value = Int32(needle.dropFirst(4)), value > 0 else { return nil }
        return value
    }()
    let match = NSWorkspace.shared.runningApplications.first { app in
        guard !app.isTerminated && app.activationPolicy != .prohibited else { return false }
        if let requestedPid { return app.processIdentifier == requestedPid }
        let name = (app.localizedName ?? "").folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        let bundle = (app.bundleIdentifier ?? "").folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return name == needle || bundle == needle || name.contains(needle)
    }
    guard let match else { failure("app-not-found", message: "No running application matched the requested app name, bundle identifier, or pid.", exitCode: 69) }
    let activated = match.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    if activated {
        Thread.sleep(forTimeInterval: 0.08)
        raiseApplicationWindow(pid: match.processIdentifier)
    }
    respond(["ok": activated, "app": match.localizedName ?? target, "pid": Int(match.processIdentifier)])

case "move":
    ensureAccessibility()
    guard let point = validatedPoint(request) else {
        failure("invalid-coordinate", message: "x and y must identify a point on an active display.", exitCode: 64)
    }
    postMouse(.mouseMoved, point: point, button: .left)
    respond(["ok": true, "x": point.x, "y": point.y])

case "click":
    ensureAccessibility()
    guard let point = validatedPoint(request) else {
        failure("invalid-coordinate", message: "x and y must identify a point on an active display.", exitCode: 64)
    }
    let buttonName = (request["button"] as? String) ?? "left"
    guard let (button, downType, upType, _) = mouseDefinition(buttonName) else {
        failure("invalid-button", message: "button must be left, right, or middle.", exitCode: 64)
    }
    let count = integer(request, "clickCount") ?? 1
    guard (1...2).contains(count) else {
        failure("invalid-click-count", message: "clickCount must be 1 or 2.", exitCode: 64)
    }
    postMouse(.mouseMoved, point: point, button: button)
    Thread.sleep(forTimeInterval: 0.04)
    for index in 1...count {
        postMouse(downType, point: point, button: button, clickState: Int64(index))
        postMouse(upType, point: point, button: button, clickState: Int64(index))
        if count == 2 && index == 1 { Thread.sleep(forTimeInterval: 0.06) }
    }
    Thread.sleep(forTimeInterval: 0.06)
    respond(["ok": true, "x": point.x, "y": point.y, "button": buttonName, "clickCount": count])

case "drag":
    ensureAccessibility()
    guard let from = validatedPoint(request, xKey: "fromX", yKey: "fromY"),
          let to = validatedPoint(request, xKey: "toX", yKey: "toY") else {
        failure("invalid-coordinate", message: "Drag endpoints must be on active displays.", exitCode: 64)
    }
    let buttonName = (request["button"] as? String) ?? "left"
    guard let (button, downType, upType, dragType) = mouseDefinition(buttonName) else {
        failure("invalid-button", message: "button must be left, right, or middle.", exitCode: 64)
    }
    let durationMs = integer(request, "durationMs") ?? 450
    guard (50...5000).contains(durationMs) else {
        failure("invalid-duration", message: "durationMs must be between 50 and 5000.", exitCode: 64)
    }
    postMouse(.mouseMoved, point: from, button: button)
    postMouse(downType, point: from, button: button)
    let steps = max(2, min(300, durationMs / 16))
    for step in 1...steps {
        let progress = CGFloat(step) / CGFloat(steps)
        let point = CGPoint(x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress)
        postMouse(dragType, point: point, button: button)
        Thread.sleep(forTimeInterval: Double(durationMs) / Double(steps) / 1000.0)
    }
    postMouse(upType, point: to, button: button)
    respond(["ok": true, "fromX": from.x, "fromY": from.y, "toX": to.x, "toY": to.y])

case "scroll":
    ensureAccessibility()
    let deltaX = integer(request, "deltaX") ?? 0
    let deltaY = integer(request, "deltaY") ?? 0
    guard abs(deltaX) <= 4000, abs(deltaY) <= 4000, deltaX != 0 || deltaY != 0 else {
        failure("invalid-scroll", message: "Scroll deltas must be non-zero and within 4000 pixels.", exitCode: 64)
    }
    guard let event = CGEvent(
        scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState),
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(-deltaY),
        wheel2: Int32(-deltaX),
        wheel3: 0
    ) else {
        failure("event-create-failed", message: "macOS could not create a scroll event.")
    }
    event.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.08)
    respond(["ok": true, "deltaX": deltaX, "deltaY": deltaY])

case "typeText":
    ensureAccessibility()
    guard let text = request["text"] as? String, !text.isEmpty, text.utf8.count <= 16 * 1024 else {
        failure("invalid-text", message: "text must be non-empty and at most 16 KiB.", exitCode: 64)
    }
    let targetPid = integer(request, "targetPid").flatMap { $0 > 0 && $0 <= Int(Int32.max) ? pid_t($0) : nil }
    let mode: String
    var clipboardRestored: Bool? = nil
    if replaceSelectedTextUsingValue(text, targetPid: targetPid) {
        mode = "accessibility-value"
    } else if replaceSelectedText(text, targetPid: targetPid) {
        mode = "accessibility-selected-text"
    } else {
        let pasted = pasteUnicodeTextPreservingClipboard(text)
        if pasted.pasted {
            clipboardRestored = pasted.restored
            mode = "pasteboard-preserved"
        } else {
            postUnicodeText(text)
            Thread.sleep(forTimeInterval: 0.08)
            mode = "unicode-key-events"
        }
    }
    var result: [String: Any] = ["ok": true, "characters": text.count, "bytes": text.utf8.count, "mode": mode]
    if let clipboardRestored { result["clipboardRestored"] = clipboardRestored }
    respond(result)

case "selectText":
    ensureAccessibility()
    let targetPid = integer(request, "targetPid").flatMap { $0 > 0 && $0 <= Int(Int32.max) ? pid_t($0) : nil }
    if selectAllFocusedText(targetPid: targetPid) {
        respond(["ok": true, "mode": "accessibility-selection"])
    }
    postKeyChord(code: 0, flags: [.maskCommand])
    Thread.sleep(forTimeInterval: 0.08)
    respond(["ok": true, "mode": "command-a-fallback"])

case "key":
    ensureAccessibility()
    guard let key = request["key"] as? String, key.count <= 32,
          let code = keyCodes[key.lowercased()], let flags = eventFlags(request["modifiers"]) else {
        failure("invalid-key", message: "Use a supported key name and command/shift/option/control/fn modifiers.", exitCode: 64)
    }
    let repeatCount = integer(request, "repeat") ?? 1
    guard (1...20).contains(repeatCount) else {
        failure("invalid-repeat", message: "repeat must be between 1 and 20.", exitCode: 64)
    }
    for _ in 0..<repeatCount {
        postKeyChord(code: code, flags: flags)
        Thread.sleep(forTimeInterval: 0.01)
    }
    respond(["ok": true, "key": key.lowercased(), "repeat": repeatCount])

default:
    failure("unsupported-action", message: "The requested input action is not supported.", exitCode: 64)
}
