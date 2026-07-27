# MedRoute submission kit

## Devpost title

MedRoute — Find medicine, faster

## One-line pitch

MedRoute uses CALL-E to turn pharmacy availability checks into a consent-first, structured calling workflow for caregivers and care coordinators.

## Devpost description

Finding a prescribed medicine can still mean calling several pharmacies one by one—especially when online inventory is missing or stale. That delay is hard on caregivers and care teams, and it produces no useful record of what was checked.

MedRoute lets an operator enter a medicine and a small list of pharmacies they are authorized to contact. After an explicit authorization gate, CALL-E calls each pharmacy, identifies itself as an automated assistant, asks only for stock status, approximate price range, pickup readiness, and hours, then returns schema-validated results. MedRoute ranks the responses into a shortlist the operator can act on.

The design is deliberately bounded. It never enters patient details, offers medical advice, asks for a prescription, makes a purchase, or holds medication. Demo mode returns deterministic data and never places calls; a second, clearly labelled confirmation is required before the server-side CALL-E code path can run.

Built with the official `@call-e/calle` server SDK. The live workflow uses `CalleClient.calls.createAndWait()` with an explicit recipient, `recipientResultSchema`, metadata, and structured-result handling.

## What is novel

- It treats the call result as operational data, not an unstructured transcript: each pharmacy response is normalized and ranked.
- It makes safety visible in the interaction: authorization, demo-first behavior, and a separate live-call decision.
- It creates a reusable pattern for any “call a shortlist, compare factual answers, let a human decide” workflow.

## Evidence for judges

| Criterion | Evidence |
| --- | --- |
| Real-world impact | Removes a repeated, time-sensitive coordination burden for caregivers and care teams. |
| Quality of idea | A focused, bounded calling workflow rather than a generic voice agent. |
| Technical implementation | Official CALL-E SDK, real `createAndWait` integration, explicit recipients, JSON result schema, metadata, and automated demo smoke test. |
| Product and demo | A polished result-ranked interface, visible safeguards, deterministic demo mode, and a live-call path for authorized recipients. |

## Three-minute video run of show

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:20 | Opening screen | “Finding medication often still means a caregiver making a string of repetitive calls.” |
| 0:20–0:45 | Medicine and pharmacy form | “MedRoute turns that into one transparent, authorized workflow—without patient details or medical advice.” |
| 0:45–1:15 | Consent gate and demo mode | “Calls are never hidden: demo mode is the default and live calls require a distinct confirmation.” |
| 1:15–1:45 | Results shortlist | “CALL-E returns comparable stock, price, pickup, and hours data. MedRoute ranks the practical options.” |
| 1:45–2:25 | `runLiveCall` in `server.js` | “This is a real CALL-E `createAndWait` workflow with an explicit recipient and structured result schema.” |
| 2:25–2:50 | Authorized live call or recorded result | “With authorized recipients, the exact same path calls a pharmacy, identifies itself, and returns only factual results.” |
| 2:50–3:00 | Closing screen | “MedRoute helps humans decide faster; it never diagnoses, orders, or substitutes clinical judgment.” |

## Live demo checklist

1. Obtain permission from each test pharmacy or use a phone number you own that will answer as a pharmacy role-play.
2. Use only a non-sensitive example medicine; do not provide patient data.
3. Set `CALLE_API_KEY` only in your local `.env` or deployment secret store.
4. Record the default demo flow first, then the authorized live flow.
5. Blur phone numbers, API keys, and any unplanned personal information from the final video.
6. Add the public video URL and upstream PR URL to Devpost.

## Upstream PR checklist

1. Fork `CALLE-AI/awesome-phone-call-agents`.
2. Copy this project into `apps/typescript/medroute/` in that fork.
3. Add a concise MedRoute entry to the upstream app list.
4. Run `npm install`, `npm run check`, and `npm test`.
5. Open a PR with a title such as `feat(apps): add MedRoute pharmacy availability workbench`.
6. Include the demo-mode, safety, credential, cancellation, and live side-effect notes from this README in the PR body.
