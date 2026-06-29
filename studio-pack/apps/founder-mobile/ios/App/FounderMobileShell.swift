import FounderMobileIntents
import SwiftUI

public enum FounderAction: String, CaseIterable, Identifiable, Equatable, Sendable {
    case createIdea
    case today
    case marketValidation

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .createIdea: "새 아이디어 만들기"
        case .today: "오늘 할 일 보기"
        case .marketValidation: "시장 검증 열기"
        }
    }

    public var subtitle: String {
        switch self {
        case .createIdea: "아이디어를 고객 문제와 첫 검증 질문으로 바꿉니다."
        case .today: "오늘 닫아야 할 창업 작업 묶음을 엽니다."
        case .marketValidation: "경쟁사, 구매자, 시장 포화도를 먼저 확인합니다."
        }
    }

    public var destination: FounderDestination {
        switch self {
        case .createIdea: .newIdea
        case .today: .today
        case .marketValidation: .marketValidation
        }
    }
}

public struct FounderStage: Identifiable, Equatable, Sendable {
    public let id: Int
    public let title: String
    public let status: String
}

public struct FounderMobilePacket: Equatable, Sendable {
    public let idea: String
    public let selectedAction: FounderAction
    public let currentStageTitle: String
    public let nextNativeProof: String
}

public enum FounderMobileWorkflow {
    public static let stages: [FounderStage] = [
        FounderStage(id: 1, title: "아이디어 구체화", status: "진행"),
        FounderStage(id: 2, title: "PRD/화면 설계", status: "다음"),
        FounderStage(id: 3, title: "앱 제작", status: "연결")
    ]

    public static func packet(
        idea: String,
        selectedAction: FounderAction
    ) -> FounderMobilePacket {
        FounderMobilePacket(
            idea: idea.trimmingCharacters(in: .whitespacesAndNewlines),
            selectedAction: selectedAction,
            currentStageTitle: "앱 제작",
            nextNativeProof: "SwiftUI shell + App Intents + emulator QA preflight"
        )
    }
}

public struct FounderMobileShell: View {
    @State private var idea: String
    @State private var selectedAction: FounderAction

    public init(
        idea: String = "스타트업 패키지 에이전트 앱",
        selectedAction: FounderAction = .createIdea
    ) {
        self._idea = State(initialValue: idea)
        self._selectedAction = State(initialValue: selectedAction)
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    ideaEditor
                    actionPicker
                    stageList
                }
                .padding(20)
            }
            .background(Color(red: 0.95, green: 0.96, blue: 0.97))
            .navigationTitle("오늘의 창업 작업")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Startup Studio")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("아이디어를 앱 행동으로 바꾸기")
                .font(.title2.weight(.bold))
            Text("현재 선택: \(selectedAction.title)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var ideaEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("RAW IDEA")
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            TextEditor(text: $idea)
                .frame(minHeight: 120)
                .padding(10)
                .background(.background)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("창업 아이디어")
        }
    }

    private var actionPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("바로 실행할 일")
                .font(.headline)
            ForEach(FounderAction.allCases) { action in
                Button {
                    selectedAction = action
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: selectedAction == action ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selectedAction == action ? .blue : .secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(action.title)
                                .font(.body.weight(.semibold))
                            Text(action.subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(12)
                .background(.background)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private var stageList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("진행 상태")
                .font(.headline)
            ForEach(FounderMobileWorkflow.stages) { stage in
                HStack {
                    Text(stage.title)
                    Spacer()
                    Text(stage.status)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(stage.status == "진행" ? .blue : .secondary)
                }
                .padding(12)
                .background(.background)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
