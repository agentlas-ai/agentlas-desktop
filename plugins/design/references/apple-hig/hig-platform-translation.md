# Reading Apple's guidance for the platform you actually ship

The HIG names Apple frameworks. The *principles* transfer; the *nouns* do not. Translate before
you speak to the user, and use their vocabulary in every finding — a React developer should never
have to decode "UITabBarController".

## Vocabulary

| HIG says | Web / React | Electron desktop | React Native | Flutter |
|---|---|---|---|---|
| iOS, iPadOS | mobile viewport / touch | — | mobile platform | mobile platform |
| macOS | desktop viewport | the app window | — | desktop target |
| SwiftUI / UIKit / AppKit | React + CSS | React in the renderer | RN core components | widget tree |
| UIColor / Color, semantic colors | CSS custom properties, theme tokens | same | theme object / `PlatformColor` | `ColorScheme`, `Theme` |
| Dynamic Type | `rem` type scale + user font-size | same | `allowFontScaling` | `MediaQuery.textScaler` |
| Safe area | `env(safe-area-inset-*)` | title-bar inset, traffic-light zone | `SafeAreaView` | `SafeArea` |
| SF Symbols | the project's icon set (Lucide, Phosphor…) | same | same | `Icon` set |
| SF Pro | `system-ui` / the product typeface | same | system font | system font |
| Navigation stack | router history | window / view routing | `@react-navigation` stack | `Navigator` |
| Tab bar | bottom nav (mobile) / top nav (web) | sidebar or segmented control | `BottomTabNavigator` | `BottomNavigationBar` |
| Sidebar | `<nav>` region, collapsible | primary sidebar | drawer | `NavigationRail` / `Drawer` |
| Sheet / popover / alert | dialog, drawer, popover primitives | same, plus native dialogs | `Modal`, action sheet | `showModalBottomSheet`, `Dialog` |
| Liquid Glass / materials | `backdrop-filter` layers | same | `BlurView` | `BackdropFilter` |
| Haptics | — (no web equivalent) | — | `Haptics` | `HapticFeedback` |
| Reduce Motion | `prefers-reduced-motion` | same | `AccessibilityInfo` | `MediaQuery.disableAnimations` |
| VoiceOver | screen reader + ARIA | same | `accessibilityLabel` | `Semantics` |

## Rules that do not survive the trip

Do not carry these over without checking — repeating them on the wrong platform is how a review
loses credibility:

- **Tab-bar-only navigation.** Correct on a phone. On a wide desktop window a sidebar is
  usually right, and on the web a top nav is native to the medium.
- **Hit targets.** 44×44 pt is a *touch* floor. Pointer-driven desktop UI can go smaller
  (~24–28 px), but hover and focus states then become mandatory, not optional.
- **"Avoid an app-specific appearance setting."** True where the OS owns the setting. On the
  web the OS preference only arrives as `prefers-color-scheme`, so an in-app theme switch
  that *defaults to system* is the correct pattern, not a violation.
- **Apple-hardware pages** (`digital-crown`, `action-button`, `remotes`, `eyes`, `camera-control`,
  `apple-pencil-and-scribble`) describe inputs the target may not have. Read them for the
  interaction principle, never as a requirement.
- **App Store specifics** (`ratings-and-reviews`, `in-app-purchase`) bind Apple distribution.
  A web product borrows the timing wisdom and nothing else.

## Where Apple is simply right regardless of platform

Accessibility floors, semantic color, state completeness, error recovery, sparing modality,
purposeful motion, honest AI labelling. These are not Apple conventions — they are the parts
of the HIG that read as general interface engineering, and they hold on any stack.
