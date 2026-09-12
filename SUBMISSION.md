# MedRoute submission kit

## Devpost title

MedRoute — Time-sensitive medicine availability, handled

## One-line pitch

MedRoute uses CALL-E to help caregivers and care coordinators locate time-sensitive or hard-to-find medicine through consent-first, structured pharmacy calls.

## Devpost description

After a hospital discharge, an unexpected stockout, or a search for a less commonly stocked strength or formulation, locating a prescribed medicine can still mean calling pharmacies one by one. Online inventory may be unavailable, stale, or require physical confirmation. The repeated calls consume a caregiver's or coordinator's time and produce no comparable record of what was checked.

MedRoute lets an operator enter a medicine and a small list of pharmacies they are authorized to contact. After an explicit authorization gate, CALL-E calls each pharmacy, identifies itself as an automated assistant, asks only for stock status, approximate price range, same-day pickup readiness, and hours, then returns schema-validated results. MedRoute ranks the responses into a shortlist the operator can act on.

The design is deliberately bounded. It never enters patient details, offers medical advice, asks for a prescription, makes a purchase, or holds medication. Demo mode returns deterministic data and never places calls; a second, clearly labelled confirmation is required before the server-side CALL-E code path can run.

Built with the official `@call-e/calle` server SDK. The live workflow creates a call with an explicit recipient, `recipientResultSchema`, and metadata, then observes CALL-E until the outbound attempt, transcript, and structured result are available. This prevents an early incomplete provider status from being recorded as the final call outcome.

## What is novel

- It targets a specific phone-work bottleneck: promptly confirming physical availability when an online listing is absent or insufficient.
- It treats the call result as operational data, not an unstructured transcript: each pharmacy response is normalized and ranked.
- It makes safety visible in the interaction: authorization, demo-first behavior, and a separate live-call decision.
- It creates a reusable pattern for any “call a shortlist, compare factual answers, let a human decide” workflow.

## Evidence for judges

| Criterion | Evidence |
| --- | --- |
| Real-world impact | Removes a repeated coordination burden when a caregiver or care team needs a particular medicine promptly. |
| Quality of idea | A focused, bounded calling workflow rather than a generic voice agent. |
| Technical implementation | Official CALL-E SDK, real runtime call creation, explicit recipients, JSON result schema, reliable result observation, transcripts, and automated smoke tests. |
| Product and demo | A polished result-ranked interface, visible safeguards, deterministic demo mode, and a live-call path for authorized recipients. |

## Video run of show (target: 2:45)

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:20 | Opening screen | “After a discharge or unexpected stockout, a caregiver may need a particular medicine today—but confirming physical stock can mean repeating the same call.” |
| 0:20–0:45 | Illustrative medicine and pharmacy form | “MedRoute turns that narrow task into one transparent workflow without patient details or medical advice.” |
| 0:45–1:10 | Authorization gate and demo mode | “The operator confirms authorization. Demo mode is safe by default; live calls require a second explicit decision.” |
| 1:10–1:40 | Results shortlist | “CALL-E returns comparable stock, price, same-day pickup, and hours data. MedRoute ranks practical options.” |
| 1:40–2:15 | Authorized live call and result | “The production path calls an authorized recipient, identifies itself, asks each question once, and returns a structured result.” |
| 2:15–2:35 | Transcript and saved check | “The call becomes auditable evidence rather than a forgotten conversation.” |
| 2:35–2:45 | Closing screen | “MedRoute helps humans decide faster; it never diagnoses, orders, or substitutes clinical judgment.” |

## Live demo checklist

1. Obtain permission from each test pharmacy or use a phone number you own that will answer as a pharmacy role-play.
2. Use only a non-sensitive example medicine; do not provide patient data.
3. Set `CALLE_API_KEY` only in your local `.env` or deployment secret store.
4. Record the default demo flow first, then the authorized live flow.
5. Blur phone numbers, API keys, and any unplanned personal information from the final video.
6. Deploy the safe demo from the included Dockerfile and add its public URL, public video URL, and upstream PR URL to Devpost.

## Roadmap, not MVP scope

The orchestration pattern can later be reused by hospital networks, humanitarian supply chains, and public-health agencies to verify stock exceptions or coordinate human-approved redistribution. The submitted MVP makes only the narrower pharmacy-availability claim demonstrated in the application.

## Upstream PR checklist

1. Fork `CALLE-AI/awesome-phone-call-agents`.
2. Copy this project into `apps/typescript/medroute/` in that fork.
3. Add a concise MedRoute entry to the upstream app list.
4. Run `npm install`, `npm run check`, and `npm test`.
5. Open a PR with a title such as `feat(apps): add MedRoute pharmacy availability workbench`.
6. Include the demo-mode, safety, credential, cancellation, and live side-effect notes from this README in the PR body.
