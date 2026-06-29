# 07 Sales Demo

## Sales Claim

Startup Studio is sold as a founder package app, not as a generic chat prompt.
The product promise is: write a rough startup idea once, then leave with a
validated Founder Packet, PRD/design handoff, web/app proof, and QA log.

## Package Choices

| Package | Price hypothesis | Buyer intent |
|---|---:|---|
| Starter | $19-29/month | Solo founder validating one idea |
| Studio | $79-149/month | Founder running multiple ideas and exports |
| Concierge | $299-999/run | Founder who wants a reviewed support-program or investor package |

## In-App Proof

- The package selector is visible inside `webapp/index.html`.
- Selecting Starter, Studio, or Concierge updates the visible package status.
- The Founder Packet records the selected package, price hypothesis, buyer fit,
  and next paid-pilot action.
- The paid-pilot tracker shows three anonymous pilot candidates and records the
  active conversation status, objection, and next action.
- The tracker shows progress such as `2/3 대화 기록` and keeps `매출 검증 전`
  visible until three real paid pilots are recorded outside the demo.
- The browser test must treat this as purchase intent only; no real payment is
  executed in the dogfood proof.

## Paid Pilot Script

1. Ask the founder for one raw idea and one deadline.
2. Run the Startup lifecycle through PRD, Stitch handoff, app web prototype, and
   QA evidence.
3. Show the before/after Founder Packet.
4. Ask whether Starter, Studio, or Concierge matches the next paid step.
5. Record objections: price, trust, quality, missing artifacts, or provider
   setup friction.
6. Record whether each pilot is `대화 전`, `대화 기록`, `유료 파일럿`, or `보류`.
7. Do not mark revenue validated until three real paid pilots are recorded
   outside the demo.

## Pilot Tracker Defaults

| Candidate | Package | Default status | First objection | First next action |
|---|---|---|---|---|
| Pilot 01 | Starter | 대화 기록 | Price | Send sample Founder Packet |
| Pilot 02 | Concierge | 대화 기록 | Trust | Compare against a support-program form |
| Pilot 03 | Studio | 대화 전 | Repeat usage | Run a 20-minute demo |
