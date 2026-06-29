import Testing
@testable import FounderMobileApp
@testable import FounderMobileIntents

@Test func founderDestinationsAreStable() {
    #expect(FounderDestination.newIdea.rawValue == "newIdea")
    #expect(FounderDestination.today.rawValue == "today")
    #expect(FounderDestination.marketValidation.rawValue == "marketValidation")
}

@Test func intentsHaveExpectedDefaults() {
    let openIntent = OpenStartupWorkIntent()
    let createIntent = CreateStartupIdeaIntent()

    #expect(openIntent.destination == .today)
    #expect(createIntent.idea == nil)
}

@Test func mobileWorkflowMapsActionsToIntentDestinations() {
    #expect(FounderAction.createIdea.destination == .newIdea)
    #expect(FounderAction.today.destination == .today)
    #expect(FounderAction.marketValidation.destination == .marketValidation)
}

@Test func mobilePacketCarriesCurrentBuildStage() {
    let packet = FounderMobileWorkflow.packet(
        idea: "  Startup package agent app  ",
        selectedAction: .marketValidation
    )

    #expect(packet.idea == "Startup package agent app")
    #expect(packet.selectedAction == .marketValidation)
    #expect(packet.currentStageTitle == "앱 제작")
    #expect(packet.nextNativeProof.contains("SwiftUI shell"))
}
