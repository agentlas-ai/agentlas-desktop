import AppIntents

public enum FounderDestination: String, AppEnum {
    case newIdea
    case today
    case marketValidation

    public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Startup Destination")

    public static let caseDisplayRepresentations: [FounderDestination: DisplayRepresentation] = [
        .newIdea: "New Startup Idea",
        .today: "Today's Startup Work",
        .marketValidation: "Market Validation"
    ]
}

public struct OpenStartupWorkIntent: AppIntent {
    public static let title: LocalizedStringResource = "Open Startup Work"
    public static let description = IntentDescription("Open a focused Startup Studio workflow.")
    public static let openAppWhenRun = true

    @Parameter(title: "Destination")
    public var destination: FounderDestination

    public init() {
        self.destination = .today
    }

    public init(destination: FounderDestination) {
        self.destination = destination
    }

    public func perform() async throws -> some IntentResult {
        .result()
    }
}

public struct CreateStartupIdeaIntent: AppIntent {
    public static let title: LocalizedStringResource = "Create Startup Idea"
    public static let description = IntentDescription("Start a new Startup Studio idea capture.")
    public static let openAppWhenRun = true

    @Parameter(title: "Idea")
    public var idea: String?

    public init() {
        self.idea = nil
    }

    public init(idea: String?) {
        self.idea = idea
    }

    public func perform() async throws -> some IntentResult {
        .result()
    }
}

public struct StartupShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CreateStartupIdeaIntent(),
            phrases: [
                "Create a startup idea in \(.applicationName)",
                "새 창업 아이디어를 \(.applicationName)에 추가"
            ],
            shortTitle: "New Idea",
            systemImageName: "lightbulb"
        )

        AppShortcut(
            intent: OpenStartupWorkIntent(destination: .today),
            phrases: [
                "Open today's startup work in \(.applicationName)",
                "\(.applicationName)에서 오늘 창업 작업 열기"
            ],
            shortTitle: "Today",
            systemImageName: "checklist"
        )

        AppShortcut(
            intent: OpenStartupWorkIntent(destination: .marketValidation),
            phrases: [
                "Open market validation in \(.applicationName)",
                "\(.applicationName)에서 시장 검증 열기"
            ],
            shortTitle: "Market",
            systemImageName: "chart.bar"
        )
    }
}
